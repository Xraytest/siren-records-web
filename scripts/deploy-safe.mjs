#!/usr/bin/env node
/**
 * 安全部署：先备份线上 D1，再构建、发布、线上自检。
 *
 * 目的：站点数据是真实用户歌单，`wrangler deploy` / 迁移一旦出问题不能"重来一次"。
 * 所以部署顺序固定为 —— 迁移审查 → 导出线上库 → 校验导出 → 构建 → 发布 → 自检。
 *
 * 用法：
 *   npm run deploy:safe                  # 正常发布
 *   npm run deploy:safe -- --allow-destructive   # 迁移里确实需要 DROP/DELETE 时显式放开
 *   npm run deploy:safe -- --skip-live-check     # 不访问线上（离线环境）
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DB_NAME = 'siren-records'
const SITE = 'https://siren.neolx.ltd'
const MIGRATIONS_DIR = path.join(ROOT, 'migrations')
const BACKUP_DIR = path.join(ROOT, 'backups', 'd1')

const args = new Set(process.argv.slice(2))
const allowDestructive = args.has('--allow-destructive')
const skipLiveCheck = args.has('--skip-live-check')
const checkOnly = args.has('--check')
const dryRun = args.has('--dry-run')
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
    fail(`${command} ${commandArgs.join(' ')} 退出码 ${result.status}`)
  }
  return result
}

/* ---------- 1. 迁移审查 ---------- */

const DESTRUCTIVE = [
  [/\bdrop\s+(table|column|index|view|trigger)\b/i, 'DROP TABLE/COLUMN/INDEX'],
  [/\bdelete\s+from\b/i, 'DELETE FROM'],
  [/\btruncate\b/i, 'TRUNCATE'],
  [/\balter\s+table\b/i, 'ALTER TABLE（改写既有结构）'],
]

function inspectMigrations() {
  if (!existsSync(MIGRATIONS_DIR)) return
  const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort()
  const findings = []
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    // 去掉 -- 行注释再匹配，避免注释里提到 DROP 造成误报
    const body = sql.replace(/--[^\n]*/g, '')
    for (const [pattern, label] of DESTRUCTIVE) {
      if (pattern.test(body)) findings.push(`${file} 含 ${label}`)
    }
  }
  if (!findings.length) {
    log(`迁移审查通过（${files.length} 个迁移文件，无破坏性语句）`)
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

function backupDatabase() {
  mkdirSync(BACKUP_DIR, { recursive: true })
  const target = path.join(BACKUP_DIR, `siren-d1-${timestamp()}.sql`)
  log(`导出线上 D1 → ${path.relative(ROOT, target)}`)
  run(npx, ['wrangler', 'd1', 'export', DB_NAME, '--remote', '--skip-confirmation', `--output=${target}`])

  if (!existsSync(target)) fail('导出文件不存在')
  const size = statSync(target).size
  if (size < 512) fail(`导出文件过小（${size} 字节），不继续部署`)

  const sql = readFileSync(target, 'utf8')
  const required = ['CREATE TABLE users', 'CREATE TABLE playlists', 'INSERT INTO "users"', 'INSERT INTO "playlists"']
  const missing = required.filter((marker) => !sql.includes(marker))
  if (missing.length) fail(`导出内容缺少关键片段：${missing.join('、')}`)

  log(`备份完成：${size} 字节，含 users / playlists 数据`)
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

    log(`自检通过（feed 正常，首页 ${page.status}，CSP 生效）`)
  } catch (error) {
    fail(`线上自检异常：${error.message}`)
  }
}

/* ---------- 主流程 ---------- */

inspectMigrations()
if (checkOnly) {
  log('仅检查模式（--check）：未备份、未构建、未发布')
  process.exit(0)
}

const backupFile = backupDatabase()
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
console.log('  该文件含用户凭据哈希，勿提交、勿外传（backups/ 已在 .gitignore 中）。')
