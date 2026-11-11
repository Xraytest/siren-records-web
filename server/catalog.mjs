/**
 * 曲库同步 —— 本地 Node + node:sqlite 实现（与 worker/catalog.mjs 同契约）。
 *
 * 用途有两个：
 *   1. `npm run server` 时后台每 10 分钟同步一次，本地开发也能拿到官方最新曲库；
 *   2. `node server/server.mjs --sync-catalog` 手动跑一轮（部署前自检 / 排查用）。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import {
  SYNC_INTERVAL_MS,
  STALE_AFTER_MS,
  CATALOG_SCHEMA_VERSION,
  OFFICIAL,
  buildCatalogBody,
  catalogStats,
  isStale,
  matchesEtag,
  seedFromBaseline,
  syncCatalog,
} from '../shared/catalog-core.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')

/** 模块级持有 db，避免每个调用点都传 */
const state = { db: null }

const DDL = `
  CREATE TABLE IF NOT EXISTS catalog_albums (
    cid TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    songCount INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS catalog_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS catalog_albums_updated ON catalog_albums (updatedAt);
`

export function ensureCatalogSchema(db) {
  db.exec(DDL)
}

/* ---------- 响应 ---------- */

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  })
  res.end(body)
}

function sendCatalogBody(req, res, body, etag, meta) {
  const headers = {
    ...BASE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    ETag: etag,
    'X-Catalog-Version': String(meta?.version || 0),
    'X-Catalog-Synced-At': String(meta?.syncedAt || ''),
    'X-Catalog-Mode': String(meta?.mode || 'live'),
  }
  const inm = req.headers['if-none-match']
  if (matchesEtag(inm, etag)) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  headers['Content-Length'] = Buffer.byteLength(body)
  res.writeHead(200, headers)
  res.end(req.method === 'HEAD' ? undefined : body)
}

/* ---------- 存储适配器 ---------- */

function parseMetaRows(rows) {
  const meta = {}
  for (const row of rows || []) meta[String(row.key)] = String(row.value)
  return meta
}

function readMeta(db) {
  return parseMetaRows(db.prepare('SELECT key, value FROM catalog_meta').all())
}

function parseOrder(value) {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/** pendingRemoval 存的是 cid 数组，对外只暴露条数 */
function pendingRemovalCount(value) {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

function createStore(db) {
  return {
    async readSyncState() {
      const albums = db
        .prepare('SELECT cid, songCount, updatedAt FROM catalog_albums')
        .all()
        .map((row) => ({ cid: String(row.cid), songCount: Number(row.songCount), updatedAt: Number(row.updatedAt) }))
      return { meta: readMeta(db), albums }
    },

    /** 只读少量 meta 行：给「刚查过就别再查」的前置判断用，避免每次 POST 都全表扫 */
    async readMetaKeys(keys) {
      const list = (keys || []).map(String)
      if (!list.length) return {}
      const placeholders = list.map(() => '?').join(', ')
      const rows = db.prepare(`SELECT key, value FROM catalog_meta WHERE key IN (${placeholders})`).all(...list)
      return parseMetaRows(rows)
    },

    async getAlbumPayload(cid) {
      const row = db.prepare('SELECT payload FROM catalog_albums WHERE cid = ?').get(String(cid))
      return row?.payload ?? null
    },

    async putAlbums(rows) {
      if (!rows.length) return
      const statement = db.prepare(
        `INSERT INTO catalog_albums (cid, payload, songCount, updatedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(cid) DO UPDATE SET
           payload = excluded.payload,
           songCount = excluded.songCount,
           updatedAt = excluded.updatedAt`,
      )
      db.exec('BEGIN')
      try {
        for (const row of rows) {
          statement.run(
            String(row.cid),
            String(row.payload),
            Number(row.songCount) || 0,
            Number(row.updatedAt) || Date.now(),
          )
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },

    async deleteAlbums(cids) {
      if (!cids.length) return
      const statement = db.prepare('DELETE FROM catalog_albums WHERE cid = ?')
      db.exec('BEGIN')
      try {
        for (const cid of cids) statement.run(String(cid))
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },

    async setMeta(patch) {
      const entries = Object.entries(patch)
      if (!entries.length) return
      const statement = db.prepare(
        `INSERT INTO catalog_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      db.exec('BEGIN')
      try {
        for (const [key, value] of entries) statement.run(String(key), String(value ?? ''))
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },

    async stats() {
      const row = db
        .prepare('SELECT COUNT(*) AS albums, COALESCE(SUM(songCount), 0) AS songs FROM catalog_albums')
        .get()
      return { albums: Number(row?.albums) || 0, songs: Number(row?.songs) || 0 }
    },

    /**
     * 租约值格式 "<到期毫秒>|<持有者 token>"：单行单语句，天然原子。
     * SQLite 的 CAST('1720…|ab12' AS INTEGER) 只取前导数字，所以过期判断不用改。
     * 带 token 之后，releaseLease 只清自己的租约，慢轮次结束不会把别人的租约删掉。
     */
    async acquireLease(now, ttlMs, token) {
      const result = db
        .prepare(
          `INSERT INTO catalog_meta (key, value) VALUES ('leaseUntil', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value
           WHERE CAST(catalog_meta.value AS INTEGER) <= ?`,
        )
        .run(`${now + ttlMs}|${token}`, String(now))
      return Number(result?.changes) > 0
    },

    async renewLease(token, now, ttlMs) {
      if (!token) return false
      const result = db
        .prepare(
          `UPDATE catalog_meta SET value = ?
           WHERE key = 'leaseUntil' AND substr(value, instr(value, '|') + 1) = ?`,
        )
        .run(`${now + ttlMs}|${token}`, String(token))
      return Number(result?.changes) > 0
    },

    async releaseLease(token) {
      if (!token) {
        db.prepare("UPDATE catalog_meta SET value = '0' WHERE key = 'leaseUntil'").run()
        return
      }
      db.prepare(
        `UPDATE catalog_meta SET value = '0'
         WHERE key = 'leaseUntil' AND substr(value, instr(value, '|') + 1) = ?`,
      ).run(String(token))
    },
  }
}

/* ---------- 静态快照 ---------- */

let baselineCache = null

async function loadBaseline() {
  if (baselineCache) return baselineCache
  const candidates = [
    path.join(path.resolve(process.env.DIST_DIR || path.join(ROOT, 'dist')), 'data/catalog.json'),
    path.join(ROOT, 'public/data/catalog.json'),
  ]
  let lastError = null
  for (const file of candidates) {
    try {
      const text = await readFile(file, 'utf8')
      const data = JSON.parse(text)
      if (!Array.isArray(data?.albums) || !data.albums.length) throw new Error('快照内容为空')
      baselineCache = { text, data, file }
      return baselineCache
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('找不到曲库快照')
}

/* ---------- 同步 ---------- */

let running = null

export function runSyncOnce({ reason = 'manual' } = {}) {
  if (running) return running
  running = (async () => {
    const { db } = state
    const store = createStore(db)
    return syncCatalog({
      store,
      reason,
      now: Date.now(),
      fetchImpl: fetch,
      bootstrap: async () => {
        const baseline = await loadBaseline().catch(() => null)
        if (!baseline) return 0
        return seedFromBaseline(store, baseline.data, Date.now())
      },
    })
  })()
    .catch((error) => ({ ok: false, error: String(error?.message || error), reason }))
    .finally(() => {
      running = null
    })
  return running
}

/** 绑定数据库并建表（与 migrations/0003_catalog.sql 等价，本地库不走 wrangler 迁移） */
export function bindCatalogDb(db) {
  state.db = db
  ensureCatalogSchema(db)
}

/* ---------- 定时同步 ---------- */

let schedulerStarted = false

export function startCatalogScheduler({ intervalMs = SYNC_INTERVAL_MS } = {}) {
  if (schedulerStarted || !state.db) return
  schedulerStarted = true
  // 启动 5 秒后先同步一次（不阻塞 listen），之后每 10 分钟一次
  const kick = setTimeout(() => {
    void runSyncOnce({ reason: 'startup' })
  }, 5_000)
  kick.unref?.()
  const timer = setInterval(() => {
    void runSyncOnce({ reason: 'interval' })
  }, intervalMs)
  timer.unref?.()
  return () => {
    clearTimeout(kick)
    clearInterval(timer)
    schedulerStarted = false
  }
}

/* ---------- 懒同步（请求时发现过期） ---------- */

let lastLazyAt = 0

function maybeLazySync() {
  if (!state.db) return
  const now = Date.now()
  if (now - lastLazyAt < 60_000) return
  const meta = readMeta(state.db)
  if (!isStale(meta)) return
  lastLazyAt = now
  void runSyncOnce({ reason: 'lazy' })
}

/* ---------- 读路径 ---------- */

let bodyCache = null // { etag, body, at }

async function snapshotPayload() {
  const baseline = await loadBaseline()
  const stats = catalogStats(baseline.data.albums)
  return {
    text: baseline.text,
    meta: {
      mode: 'snapshot',
      version: Number(baseline.data.version) || 0,
      albums: stats.albums,
      songs: stats.songs,
      generatedAt: String(baseline.data.generatedAt || ''),
      syncedAt: String(baseline.data.syncedAt || baseline.data.generatedAt || ''),
      lastCheckAt: '',
      stale: true,
    },
  }
}

async function metaPayload() {
  const base = {
    mode: 'snapshot',
    stale: true,
    intervalMs: SYNC_INTERVAL_MS,
    staleAfterMs: STALE_AFTER_MS,
    schema: CATALOG_SCHEMA_VERSION,
    source: OFFICIAL,
    lastError: '',
    lastErrorAt: '',
    lastWarning: '',
    lastWarningAt: '',
    pendingRemoval: 0,
    lastRemoved: 0,
  }
  if (!state.db) return { ...base, version: 0, albums: 0, songs: 0, generatedAt: '', syncedAt: '', lastCheckAt: '' }
  try {
    const meta = readMeta(state.db)
    if (!meta.version && !meta.order) {
      const snapshot = await snapshotPayload().catch(() => null)
      return {
        ...base,
        version: 0,
        albums: snapshot?.meta.albums || 0,
        songs: snapshot?.meta.songs || 0,
        generatedAt: snapshot?.meta.generatedAt || '',
        syncedAt: snapshot?.meta.syncedAt || '',
        lastCheckAt: '',
      }
    }
    return {
      ...base,
      mode: 'live',
      version: Number(meta.version) || 0,
      albums: Number(meta.albums) || 0,
      songs: Number(meta.songs) || 0,
      generatedAt: meta.generatedAt || '',
      syncedAt: meta.syncedAt || '',
      lastCheckAt: meta.lastCheckAt || '',
      lastError: meta.lastError || '',
      lastErrorAt: meta.lastErrorAt || '',
      lastWarning: meta.lastWarning || '',
      lastWarningAt: meta.lastWarningAt || '',
      pendingRemoval: pendingRemovalCount(meta.pendingRemoval),
      lastRemoved: Number(meta.lastRemoved) || 0,
      lastRemovedAt: meta.lastRemovedAt || '',
      lastReason: meta.lastReason || '',
      stale: isStale(meta),
    }
  } catch (error) {
    return { ...base, version: 0, albums: 0, songs: 0, generatedAt: '', syncedAt: '', lastCheckAt: '', lastError: String(error?.message || error) }
  }
}

async function sendCatalog(req, res) {
  if (!state.db) {
    const snapshot = await snapshotPayload()
    sendCatalogBody(req, res, snapshot.text, `"snap-${snapshot.meta.version}-${snapshot.meta.albums}-${snapshot.meta.songs}"`, snapshot.meta)
    return
  }
  // DB 读段（meta / 行数据）任何一步抛错都退回静态快照，与 worker readCatalog 的
  // catch → snapshotResponse 同规：库坏了最多降级，不能让整条接口 500
  try {
    const meta = readMeta(state.db)
    if (!meta.version && !meta.order) {
      const snapshot = await snapshotPayload()
      sendCatalogBody(req, res, snapshot.text, `"snap-${snapshot.meta.version}-${snapshot.meta.albums}-${snapshot.meta.songs}"`, snapshot.meta)
      return
    }
    const etag = `"cat-${meta.version || 0}-${meta.albums || 0}-${meta.songs || 0}"`
    if (bodyCache && bodyCache.etag === etag && Date.now() - bodyCache.at < 60_000) {
      // 用缓存里那份 meta 生成响应头：否则「内容没变、只有时间戳变了」的一轮同步之后，
      // 同一份 body 会配上一个更新的 X-Catalog-Synced-At，与 body 里的时间自相矛盾。
      sendCatalogBody(req, res, bodyCache.body, etag, bodyCache.meta)
      return
    }
    const rows = state.db.prepare('SELECT cid, payload FROM catalog_albums').all()
    if (!rows.length) {
      const snapshot = await snapshotPayload()
      sendCatalogBody(req, res, snapshot.text, `"snap-${snapshot.meta.version}-${snapshot.meta.albums}-${snapshot.meta.songs}"`, snapshot.meta)
      return
    }
    const body = buildCatalogBody({
      generatedAt: meta.generatedAt,
      source: meta.source || OFFICIAL,
      version: meta.version,
      syncedAt: meta.syncedAt,
      lastCheckAt: meta.lastCheckAt,
      albums: rows,
      order: parseOrder(meta.order),
    })
    bodyCache = { etag, body, meta, at: Date.now() }
    sendCatalogBody(req, res, body, etag, meta)
  } catch (error) {
    console.error('[siren] 曲库读取失败，退回静态快照', error)
    const snapshot = await snapshotPayload().catch(() => null)
    if (!snapshot) {
      sendJson(res, 500, { error: '曲库服务异常' })
      return
    }
    sendCatalogBody(req, res, snapshot.text, `"snap-${snapshot.meta.version}-${snapshot.meta.albums}-${snapshot.meta.songs}"`, snapshot.meta)
  }
}

/* ---------- 路由 ---------- */

let lastManualAt = 0
const MANUAL_COOLDOWN_MS = 15_000

export async function handleCatalog(req, res, pathname) {
  const method = (req.method || 'GET').toUpperCase()
  const action = pathname.split('/').filter(Boolean)[2] || ''

  try {
    if (!action && (method === 'GET' || method === 'HEAD')) {
      maybeLazySync()
      await sendCatalog(req, res)
      return
    }
    if (action === 'meta' && (method === 'GET' || method === 'HEAD')) {
      maybeLazySync()
      sendJson(res, 200, await metaPayload())
      return
    }
    if (action === 'sync') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: '只接受 POST' }, { Allow: 'POST' })
        return
      }
      // 只接受同源触发：第三方页面即使能发 no-cors POST，也不该能驱动我们打官方接口
      // （与 worker/catalog.mjs 同分支的逻辑保持逐行一致，两端行为不许分叉）
      const origin = req.headers.origin || ''
      if (origin) {
        let originHost = ''
        try {
          originHost = new URL(origin).host
        } catch {
          originHost = ''
        }
        if (originHost && originHost !== req.headers.host) {
          sendJson(res, 403, { error: '只接受同源请求' })
          return
        }
      }
      const now = Date.now()
      if (now - lastManualAt < MANUAL_COOLDOWN_MS) {
        sendJson(res, 429, { error: '同步过于频繁，请稍后再试' })
        return
      }
      lastManualAt = now
      // 先响应后执行：与 worker/catalog.mjs 同分支保持同形（202 + started:true），
      // 手动同步动辄几十秒，同步等待会让前端 30 秒超时直接报错，而同步本身还在后台继续
      sendJson(res, 202, { started: true, reason: 'manual', checkedAt: new Date().toISOString() })
      void runSyncOnce({ reason: 'manual' }).then((result) => {
        if (result && !result.ok) console.error('[siren] 曲库手动同步失败', result.error)
        else if (result?.warnings?.length) console.warn('[siren] 曲库手动同步部分失败', result.warnings.slice(0, 3))
        else console.log(`[siren] 曲库手动同步完成 v${result?.version}（+${result?.added} 专辑）`)
      })
      return
    }
    sendJson(res, 404, { error: '接口不存在' })
  } catch (error) {
    console.error('[siren] 曲库接口异常', error)
    if (!res.headersSent) sendJson(res, 500, { error: '曲库服务异常' })
    else res.end()
  }
}
