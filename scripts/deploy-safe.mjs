#!/usr/bin/env node
/**
 * 安全部署：先备份线上 D1，再构建、发布、线上自检。
 *
 * 目的：站点数据是真实用户歌单，`wrangler deploy` / 迁移一旦出问题不能"重来一次"。
 * 所以部署顺序固定为 —— 迁移审查 → 导出线上库 → 校验导出 → 构建 → 发布 → 自检。
 *
 * 用法：
 *   npm run deploy:safe                          # 正常发布
 *   npm run deploy:safe -- --allow-destructive   # 迁移里确实需要 DROP/DELETE 时显式放开
 *   npm run deploy:safe -- --skip-live-check     # 不访问线上（离线环境）
 *   npm run deploy:safe -- --backup-only         # 只做备份（db:migrate 会用它做预备份）
 *   npm run deploy:safe -- --all-migrations      # 扫描全部迁移（默认只看 pending）
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { findDestructive } from './lib/sql-scan.mjs'
import { parsePendingMigrations } from './lib/wrangler-migrations.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const DB_NAME = 'siren-records'
const SITE = 'https://siren.neolx.ltd'
const MIGRATIONS_DIR = path.join(ROOT, 'migrations')
const BACKUP_DIR = path.join(ROOT, 'backups', 'd1')
const KEEP_BACKUPS = 10
const TABLES = ['users', 'sessions', 'playlists']

const args = new Set(process.argv.slice(2))
const allowDestructive = args.has('--allow-destructive')
const skipLiveCheck = args.has('--skip-live-check')
const checkOnly = args.has('--check')
const dryRun = args.has('--dry-run')
const backupOnly = args.has('--backup-only')
const allMigrations = args.has('--all-migrations')
const npx = 'npx'

function log(message) {
  console.log(`\n[safe-deploy] ${message}`)
}

function fail(message) {
  console.error(`\n[safe-deploy] 中止：${message}`)
  process.exit(1)
}

function run(command, commandArgs, options = {}) {
  // Windows 上 npm/npx 是 .cmd，必须经 shell 才能启动；所有参数都保证不含空白与引号
  for (const arg of [command, ...commandArgs]) {
    if (/\s|["']/.test(arg)) fail(`参数不能含空白或引号：${arg}`)
  }
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    shell: process.platform === 'win32',
  })
  if (result.error) fail(`${command} 无法执行：${result.error.message}`)
  if (result.status !== 0) {
    if (options.capture) console.error(result.stdout || '', result.stderr || '')
    if (options.allowFailure) return { ok: false, stdout: result.stdout || '', stderr: result.stderr || '' }
    fail(`${command} ${commandArgs.join(' ')} 退出码 ${result.status}`)
  }
  return { ok: true, stdout: result.stdout || '', stderr: result.stderr || '' }
}

/* ---------- 1. 迁移审查（词法级，只看 pending） ---------- */

function pendingMigrations() {
  const result = run(npx, ['wrangler', 'd1', 'migrations', 'list', DB_NAME, '--remote'], {
    capture: true,
    allowFailure: true,
  })
  if (!result.ok) return null
  return parsePendingMigrations(result.stdout)
}

function inspectMigrations() {
  if (!existsSync(MIGRATIONS_DIR)) return
  const all = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort()
  if (!all.length) return

  let files = all
  if (!allMigrations) {
    const pending = pendingMigrations()
    if (pending === null) {
      console.warn('  ⚠ 无法读取 pending 列表，退回扫描全部迁移')
    } else if (!pending.length) {
      log('迁移审查：线上已是最新，无待应用迁移')
      return
    } else {
      files = pending.filter((file) => all.includes(file))
      const missing = pending.filter((file) => !all.includes(file))
      if (missing.length) fail(`wrangler 报告存在本地缺失的迁移：${missing.join('、')}`)
    }
  }

  const findings = []
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    for (const finding of findDestructive(sql)) findings.push(`${file} 含 ${finding.label}：${finding.statement}`)
  }
  if (!findings.length) {
    log(`迁移审查通过（检查 ${files.length} 个待应用迁移，无破坏性语句）`)
    return
  }
  for (const finding of findings) console.warn(`  ⚠ ${finding}`)
  if (!allowDestructive) {
    fail('迁移中包含可能丢数据的语句。确认无误后加 -- --allow-destructive 重跑')
  }
  log('已显式允许破坏性迁移（--allow-destructive）')
}

/* ---------- 2. 导出线上库 ---------- */

function timestamp() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  )
}

/** 线上真实行数（拿不到就返回 null，调用方降级） */
function liveCounts() {
  const sql = `SELECT ${TABLES.map((t) => `(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(', ')}`
  // 两条约束一起把这里逼成「自己拼一条命令行」：
  //  1. `--file` 批量执行只返回 "Total queries executed"，不返回 SELECT 结果（实测）；
  //  2. run() 拒绝含空白的参数（Windows 经 shell 拼接会把 SQL 撕成多段）。
  // SQL 只由常量 TABLES 拼成，不含引号/百分号/感叹号，套一层引号传给 shell 是安全的。
  const quoted = process.platform === 'win32' ? `"${sql}"` : `'${sql}'`
  const line = `${npx} wrangler d1 execute ${DB_NAME} --remote --json --command=${quoted}`
  const result = spawnSync(line, {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  })
  if (result.error || result.status !== 0) return null
  try {
    const start = result.stdout.indexOf('[')
    const end = result.stdout.lastIndexOf(']')
    if (start < 0 || end < 0) return null
    const rows = JSON.parse(result.stdout.slice(start, end + 1))
    const row = rows?.[0]?.results?.[0]
    if (!row) return null
    return Object.fromEntries(TABLES.map((table) => [table, Number(row[table] ?? row[table.toUpperCase()] ?? 0)]))
  } catch {
    return null
  }
}

/**
 * 把导出文件真正加载进内存 SQLite 校验：integrity_check + 每表行数。
 * 早期只查 4 个子串（`CREATE TABLE users` 等），空库/另一份库/干净截断的下载都能通过。
 */
async function verifyDump(target, expected) {
  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    console.warn('  ⚠ 当前 Node 没有 node:sqlite，退化为标记检查（无法做完整性校验）')
    return null
  }
  const sql = readFileSync(target, 'utf8')
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(sql)
    const integrity = db.prepare('PRAGMA integrity_check').get()
    const integrityValue = integrity ? Object.values(integrity)[0] : 'unknown'
    if (integrityValue !== 'ok') fail(`导出库 integrity_check=${integrityValue}`)
    const counts = {}
    for (const table of TABLES) {
      counts[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)
    }
    if (counts.users < 1) fail('导出库 users 为 0（可能是空库/错库），不继续')
    if (expected) {
      for (const table of TABLES) {
        if (expected[table] !== counts[table]) {
          fail(`导出库 ${table} 行数 ${counts[table]} 与线上 ${expected[table]} 不一致（导出不完整）`)
        }
      }
    }
    return counts
  } catch (error) {
    fail(`导出库无法加载：${error.message}`)
  } finally {
    db.close()
  }
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function pruneBackups() {
  const files = readdirSync(BACKUP_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .reverse()
  for (const name of files.slice(KEEP_BACKUPS)) {
    for (const suffix of ['', '.sha256']) {
      const target = path.join(BACKUP_DIR, name + suffix)
      if (existsSync(target)) unlinkSync(target)
    }
  }
}

async function backupDatabase() {
  // 明文 dump 含用户凭据哈希与（已哈希的）会话键：目录 700、文件 600，别让同机其他用户读到
  mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 })
  try {
    chmodSync(BACKUP_DIR, 0o700)
  } catch {
    // Windows 上没有 POSIX 权限位，忽略
  }
  const target = path.join(BACKUP_DIR, `siren-d1-${timestamp()}.sql`)
  const expected = liveCounts()
  log(`导出线上 D1 → ${path.relative(ROOT, target)}${expected ? `（线上 ${JSON.stringify(expected)}）` : ''}`)
  run(npx, ['wrangler', 'd1', 'export', DB_NAME, '--remote', '--skip-confirmation', `--output=${target}`], {
    env: { WRANGLER_SEND_METRICS: 'false' },
  })

  if (!existsSync(target)) fail('导出文件不存在')
  const size = statSync(target).size
  if (size < 512) fail(`导出文件过小（${size} 字节），不继续部署`)
  try {
    chmodSync(target, 0o600)
  } catch {
    // 同上
  }

  const counts = await verifyDump(target, expected)
  const digest = sha256File(target)
  const sidecar = `${target}.sha256`
  writeFileSync(sidecar, `${digest}  ${path.basename(target)}\n`, { mode: 0o600 })
  try {
    chmodSync(sidecar, 0o600)
  } catch {
    // 同上
  }

  pruneBackups()
  log(
    `备份完成：${size} 字节 · sha256 ${digest.slice(0, 16)}… · 行数 ${counts ? JSON.stringify(counts) : '未校验'}`,
  )
  return target
}

/* ---------- 3. 构建 + 发布 ---------- */

function build() {
  log('构建前端与 Worker')
  run('npm', ['run', 'build'])
}

function deploy() {
  log('发布到 Cloudflare Workers')
  run(npx, ['wrangler', 'deploy'])
}

/* ---------- 4. 线上自检 ---------- */

async function liveCheck() {
  log(`线上自检：${SITE}`)
  try {
    const feed = await fetch(`${SITE}/api/feed`, { headers: { 'Cache-Control': 'no-cache' } })
    if (!feed.ok) fail(`/api/feed 返回 ${feed.status}`)
    const payload = await feed.json()
    if (!payload || typeof payload !== 'object') fail('/api/feed 响应不是 JSON 对象')

    const page = await fetch(`${SITE}/`, { redirect: 'follow' })
    if (!page.ok) fail(`首页返回 ${page.status}`)
    const csp = page.headers.get('content-security-policy') || ''
    if (!csp.includes("frame-ancestors 'none'")) fail('首页缺少 CSP frame-ancestors 限制')

    const dump = await fetch(`${SITE}/api/backup/dump`, { redirect: 'manual' })
    if (dump.status !== 401) fail(`/api/backup/dump 未带令牌应返回 401，实际 ${dump.status}`)

    log(`自检通过（feed 正常，首页 ${page.status}，CSP 生效，备份接口关闭）`)
  } catch (error) {
    fail(`线上自检异常：${error.message}`)
  }
}

/* ---------- 主流程 ---------- */

// --backup-only 只导出、不 apply 迁移，因此不做迁移闸门（否则 db:migrate 的预备份
// 会因为「待应用迁移含 DELETE」而自我否决——闸门已在 migrate.mjs 里先跑过一次）。
if (!backupOnly) inspectMigrations()
if (checkOnly) {
  log('仅检查模式（--check）：未备份、未构建、未发布')
  process.exit(0)
}

const backupFile = await backupDatabase()
if (backupOnly) {
  log(`仅备份模式（--backup-only）：未构建、未发布。${path.relative(ROOT, backupFile)}`)
  process.exit(0)
}
build()
if (dryRun) {
  log(`演练结束（--dry-run）：未发布。线上备份留在 ${path.relative(ROOT, backupFile)}`)
  process.exit(0)
}
deploy()
if (skipLiveCheck) {
  log('已跳过线上自检（--skip-live-check）')
} else {
  await liveCheck()
}

log('完成。')
console.log(`  线上备份：${path.relative(ROOT, backupFile)}`)
console.log(
  '  该文件含用户凭据哈希与会话键（会话已改为只存 SHA-256，不再含可直接使用的令牌），勿提交、勿外传。',
)
