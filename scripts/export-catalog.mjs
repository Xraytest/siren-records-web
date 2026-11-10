#!/usr/bin/env node
/**
 * 把本地已同步的曲库（DATA_DIR/siren.db）导出成静态快照 public/data/catalog.json。
 *
 * 快照不再决定线上曲库内容，只承担两个角色：
 *   1. 首次部署 / 空库时铺底（官方全量详情要 300+ 次请求，一轮同步抓不完）
 *   2. 后端完全不可用时的离线兜底
 * 导出后要重新 `npm run build`，快照才会进入 dist/ 并随 Assets 一起发布。
 *
 * 用法：
 *   node scripts/export-catalog.mjs
 *   node scripts/export-catalog.mjs --out public/data/catalog.json
 *   DATA_DIR=/srv/siren/data node scripts/export-catalog.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildCatalogBody, OFFICIAL } from '../shared/catalog-core.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data')
const outIndex = process.argv.indexOf('--out')
const OUT = path.resolve(ROOT, outIndex > -1 && process.argv[outIndex + 1] ? process.argv[outIndex + 1] : 'public/data/catalog.json')

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

let db
try {
  db = new DatabaseSync(path.join(DATA_DIR, 'siren.db'), { readOnly: true })
} catch (error) {
  fail(`打不开 ${path.join(DATA_DIR, 'siren.db')}：${error.message}\n  先跑一次同步（npm run catalog:sync）再导出。`)
}

let rows
let metaRows
try {
  rows = db.prepare('SELECT cid, payload FROM catalog_albums').all()
  metaRows = db.prepare('SELECT key, value FROM catalog_meta').all()
} catch (error) {
  fail(`曲库表不存在或不可读：${error.message}`)
}
db.close()

if (!rows.length) fail('曲库是空的，先跑 npm run catalog:sync')

const meta = Object.fromEntries(metaRows.map((row) => [row.key, String(row.value)]))
let order = []
try {
  order = JSON.parse(meta.order || '[]')
} catch {
  order = []
}

const body = buildCatalogBody({
  generatedAt: meta.generatedAt || new Date().toISOString(),
  source: meta.source || OFFICIAL,
  version: meta.version || '1',
  syncedAt: meta.syncedAt || '',
  lastCheckAt: meta.lastCheckAt || '',
  albums: rows,
  order,
})

const albumCount = rows.length
const songCount = rows.reduce((total, row) => {
  try {
    return total + (JSON.parse(row.payload).songs?.length || 0)
  } catch {
    return total
  }
}, 0)

let previous = null
try {
  previous = await readFile(OUT, 'utf8')
} catch {
  // 首次导出：没有旧文件很正常
}

if (previous === body) {
  console.log(`= 快照无变化（${albumCount} 张 / ${songCount} 首）`)
  process.exit(0)
}

await writeFile(OUT, body, 'utf8')
console.log(`✓ 已写出 ${path.relative(ROOT, OUT)}：${albumCount} 张专辑 / ${songCount} 首，${Buffer.byteLength(body)} 字节`)
console.log(`  版本 v${meta.version || '?'}，同步于 ${meta.syncedAt || '未知'}；记得 npm run build 让 dist/ 也更新`)
