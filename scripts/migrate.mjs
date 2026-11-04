#!/usr/bin/env node
/**
 * 迁移守门 + 预备份：`npm run db:migrate`
 *
 * 为什么存在：`wrangler d1 migrations apply --remote` 是唯一会直接改线上数据的命令，
 * 早期把「破坏性语句检查」只放在 deploy-safe 里 —— 那条路径根本不会 apply 迁移，
 * 于是直接 `npm run db:migrate` 就绕过了闸门。
 *
 * 顺序：检查 pending 迁移 → 导出线上库（含完整性校验）→ apply。
 *
 * 用法：
 *   npm run db:migrate                         # 检查 + 备份 + 应用
 *   npm run db:migrate -- --check               # 只检查，不备份不应用
 *   npm run db:migrate -- --allow-destructive   # 确实需要 DROP/DELETE 时显式放开
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { findDestructive } from './lib/sql-scan.mjs'
import { parsePendingMigrations } from './lib/wrangler-migrations.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const DB_NAME = 'siren-records'
const MIGRATIONS_DIR = path.join(ROOT, 'migrations')

const args = new Set(process.argv.slice(2))
const allowDestructive = args.has('--allow-destructive')
const checkOnly = args.has('--check')
const npx = 'npx'

function log(message) {
  console.log(`\n[db-migrate] ${message}`)
}

function fail(message) {
  console.error(`\n[db-migrate] 中止：${message}`)
  process.exit(1)
}

function run(command, commandArgs, options = {}) {
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
    if (options.capture && result.stderr) console.error(result.stderr)
    if (options.allowFailure) return { ok: false, stdout: result.stdout || '', stderr: result.stderr || '' }
    fail(`${command} ${commandArgs.join(' ')} 退出码 ${result.status}`)
  }
  return { ok: true, stdout: result.stdout || '', stderr: result.stderr || '' }
}

/** 线上已应用的迁移列表（失败时返回 null，调用方退回「全部扫描」并提示） */
function pendingMigrations() {
  const result = run(npx, ['wrangler', 'd1', 'migrations', 'list', DB_NAME, '--remote'], {
    capture: true,
    allowFailure: true,
  })
  if (!result.ok) return null
  return parsePendingMigrations(result.stdout)
}

function inspect(files) {
  const findings = []
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    for (const finding of findDestructive(sql)) findings.push(`${file} 含 ${finding.label}：${finding.statement}`)
  }
  return findings
}

/* ---------- 1. 闸门 ---------- */

const allFiles = existsSync(MIGRATIONS_DIR)
  ? readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort()
  : []
if (!allFiles.length) {
  log('没有迁移文件，无事可做')
  process.exit(0)
}

const pending = pendingMigrations()
let targets
if (pending === null) {
  console.warn('  ⚠ 无法从 wrangler 读取 pending 列表，退回「扫描全部迁移文件」')
  targets = allFiles
} else if (pending.length === 0) {
  log('线上已是最新，没有待应用的迁移')
  process.exit(0)
} else {
  const missing = pending.filter((file) => !allFiles.includes(file))
  if (missing.length) fail(`wrangler 报告存在本地缺失的迁移：${missing.join('、')}`)
  targets = pending
}

log(`待应用迁移：${targets.join('、')}`)
const findings = inspect(targets)
if (findings.length) {
  for (const finding of findings) console.warn(`  ⚠ ${finding}`)
  if (!allowDestructive) {
    fail('待应用的迁移包含可能丢数据的语句。确认无误后加 -- --allow-destructive 重跑')
  }
  log('已显式允许破坏性迁移（--allow-destructive）')
} else {
  log('闸门通过：待应用迁移中无破坏性语句')
}

if (checkOnly) {
  log('仅检查模式（--check）：未备份、未应用')
  process.exit(0)
}

/* ---------- 2. 预备份（复用 deploy-safe 的导出与校验） ---------- */

run('node', ['scripts/deploy-safe.mjs', '--backup-only'])

/* ---------- 3. 应用 ---------- */

log('应用迁移到线上 D1')
run(npx, ['wrangler', 'd1', 'migrations', 'apply', DB_NAME, '--remote'])
log('完成。')
