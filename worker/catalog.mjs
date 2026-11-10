/**
 * 曲库同步 —— Cloudflare Worker + D1 实现。
 *
 * 存储结构（见 migrations/0003_catalog.sql）：
 *   catalog_albums(cid, payload, songCount, updatedAt)  一张专辑一行，payload 就是对外 JSON
 *   catalog_meta(key, value)                            版本号、时间戳、顺序、租约
 *
 * 读路径把各行 payload 直接字符串拼接成完整曲库（不 parse/stringify 整个大对象），
 * 写路径按专辑粒度 upsert，因此一次同步只写真正变化的行。
 */
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

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS catalog_albums (
     cid TEXT PRIMARY KEY,
     payload TEXT NOT NULL,
     songCount INTEGER NOT NULL DEFAULT 0,
     updatedAt INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS catalog_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS catalog_albums_updated ON catalog_albums (updatedAt)`,
]

/* ---------- 响应工具 ---------- */

function jsonResponse(status, payload, extra = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, 'Cache-Control': 'no-store', ...extra },
  })
}

function isMissingTable(error) {
  const message = String(error?.message || error || '')
  return /no such table|no such column|no such index/i.test(message)
}

/* ---------- 表结构 ---------- */

let schemaState = { db: null, promise: null }

function ensureSchema(db) {
  if (schemaState.db === db && schemaState.promise) return schemaState.promise
  const promise = db
    .batch(DDL.map((sql) => db.prepare(sql)))
    .then(() => undefined)
    .catch((error) => {
      if (schemaState.promise === promise) schemaState = { db: null, promise: null }
      throw error
    })
  schemaState = { db, promise }
  return promise
}

/* ---------- 存储适配器 ---------- */

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

function parseMetaRows(rows) {
  const meta = {}
  for (const row of rows || []) meta[String(row.key)] = String(row.value)
  return meta
}

async function readMeta(db) {
  const result = await db.prepare('SELECT key, value FROM catalog_meta').all()
  return parseMetaRows(result?.results)
}

function createStore(env) {
  const db = env.DB

  /** 迁移没应用时自动补建（DDL 幂等），避免「部署了但忘了迁移」直接 500 */
  const guard = (fn) => async (...args) => {
    try {
      return await fn(...args)
    } catch (error) {
      if (!isMissingTable(error)) throw error
      await ensureSchema(db)
      return fn(...args)
    }
  }

  return {
    readSyncState: guard(async () => {
      const [meta, rows] = await Promise.all([
        readMeta(db),
        db.prepare('SELECT cid, songCount, updatedAt FROM catalog_albums').all(),
      ])
      return { meta, albums: rows?.results || [] }
    }),

    /** 只读少量 meta 行：给「刚查过就别再查」的前置判断用，避免每次 POST 都全表扫 */
    readMetaKeys: guard(async (keys) => {
      const list = (keys || []).map(String)
      if (!list.length) return {}
      const placeholders = list.map(() => '?').join(', ')
      const result = await db
        .prepare(`SELECT key, value FROM catalog_meta WHERE key IN (${placeholders})`)
        .bind(...list)
        .all()
      return parseMetaRows(result?.results)
    }),

    getAlbumPayload: guard(async (cid) => {
      const row = await db.prepare('SELECT payload FROM catalog_albums WHERE cid = ?').bind(String(cid)).first()
      return row?.payload ?? null
    }),

    putAlbums: guard(async (rows) => {
      if (!rows.length) return
      const statement = db.prepare(
        `INSERT INTO catalog_albums (cid, payload, songCount, updatedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(cid) DO UPDATE SET
           payload = excluded.payload,
           songCount = excluded.songCount,
           updatedAt = excluded.updatedAt`,
      )
      for (let index = 0; index < rows.length; index += 40) {
        const chunk = rows.slice(index, index + 40)
        await db.batch(
          chunk.map((row) => statement.bind(row.cid, row.payload, Number(row.songCount) || 0, Number(row.updatedAt) || Date.now())),
        )
      }
    }),

    deleteAlbums: guard(async (cids) => {
      if (!cids.length) return
      const statement = db.prepare('DELETE FROM catalog_albums WHERE cid = ?')
      for (let index = 0; index < cids.length; index += 50) {
        await db.batch(cids.slice(index, index + 50).map((cid) => statement.bind(String(cid))))
      }
    }),

    setMeta: guard(async (patch) => {
      const entries = Object.entries(patch)
      if (!entries.length) return
      const statement = db.prepare(
        `INSERT INTO catalog_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      await db.batch(entries.map(([key, value]) => statement.bind(String(key), String(value ?? ''))))
    }),

    stats: guard(async () => {
      const row = await db
        .prepare('SELECT COUNT(*) AS albums, COALESCE(SUM(songCount), 0) AS songs FROM catalog_albums')
        .first()
      return { albums: Number(row?.albums) || 0, songs: Number(row?.songs) || 0 }
    }),

    /**
     * 租约值格式 "<到期毫秒>|<持有者 token>"：单行单语句，天然原子。
     * SQLite 的 CAST('1720…|ab12' AS INTEGER) 只取前导数字，所以过期判断不用改。
     * 带 token 之后，releaseLease 只清自己的租约，慢轮次结束不会把别人的租约删掉。
     */
    acquireLease: guard(async (now, ttlMs, token) => {
      const result = await db
        .prepare(
          `INSERT INTO catalog_meta (key, value) VALUES ('leaseUntil', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value
           WHERE CAST(catalog_meta.value AS INTEGER) <= ?`,
        )
        .bind(`${now + ttlMs}|${token}`, String(now))
        .run()
      return Number(result?.meta?.changes) > 0
    }),

    renewLease: guard(async (token, now, ttlMs) => {
      if (!token) return false
      const result = await db
        .prepare(
          `UPDATE catalog_meta SET value = ?
           WHERE key = 'leaseUntil' AND substr(value, instr(value, '|') + 1) = ?`,
        )
        .bind(`${now + ttlMs}|${token}`, String(token))
        .run()
      return Number(result?.meta?.changes) > 0
    }),

    releaseLease: guard(async (token) => {
      if (!token) {
        await db.prepare("UPDATE catalog_meta SET value = '0' WHERE key = 'leaseUntil'").run()
        return
      }
      await db
        .prepare(
          `UPDATE catalog_meta SET value = '0'
           WHERE key = 'leaseUntil' AND substr(value, instr(value, '|') + 1) = ?`,
        )
        .bind(String(token))
        .run()
    }),
  }
}

/* ---------- 静态快照（首次铺底 + 数据库不可用时的兜底） ---------- */

let baselineCache = null

async function loadBaseline(env) {
  if (baselineCache) return baselineCache
  if (!env.ASSETS) throw new Error('静态资源未绑定')
  const response = await env.ASSETS.fetch(
    new Request('https://siren-assets.internal/data/catalog.json', { headers: { Accept: 'application/json' } }),
  )
  if (!response.ok) throw new Error(`曲库快照读取失败 ${response.status}`)
  const text = await response.text()
  const data = JSON.parse(text)
  if (!Array.isArray(data?.albums) || !data.albums.length) throw new Error('曲库快照内容为空')
  baselineCache = { text, data }
  return baselineCache
}

/* ---------- 同步 ---------- */

export async function runSync(env, options = {}) {
  if (!env?.DB) return { ok: false, error: 'D1 未绑定' }
  const store = createStore(env)
  const result = await syncCatalog({
    store,
    reason: options.reason || 'manual',
    now: Date.now(),
    fetchImpl: fetch,
    bootstrap: async () => {
      const baseline = await loadBaseline(env).catch(() => null)
      if (!baseline) return 0
      return seedFromBaseline(store, baseline.data, Date.now())
    },
  })
  return result
}

/* ---------- 读路径 ---------- */

let bodyCache = null // { etag, body, at }

function etagFor(meta) {
  return `"cat-${meta.version || 0}-${meta.albums || 0}-${meta.songs || 0}"`
}

function catalogResponse(request, body, etag, meta) {
  const headers = {
    ...JSON_HEADERS,
    'Cache-Control': 'no-cache',
    ETag: etag,
    'X-Catalog-Version': String(meta?.version || 0),
    'X-Catalog-Synced-At': String(meta?.syncedAt || ''),
    'X-Catalog-Mode': 'live',
  }
  const inm = request.headers.get('if-none-match')
  if (matchesEtag(inm, etag)) return new Response(null, { status: 304, headers })
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  return new Response(body, { status: 200, headers })
}

async function snapshotResponse(request, env, reason) {
  const baseline = await loadBaseline(env)
  const stats = catalogStats(baseline.data.albums)
  const meta = {
    version: Number(baseline.data.version) || 0,
    albums: stats.albums,
    songs: stats.songs,
    syncedAt: String(baseline.data.syncedAt || baseline.data.generatedAt || ''),
  }
  const etag = `"snap-${meta.version}-${stats.albums}-${stats.songs}"`
  const headers = {
    ...JSON_HEADERS,
    'Cache-Control': 'no-cache',
    ETag: etag,
    'X-Catalog-Mode': 'snapshot',
    'X-Catalog-Synced-At': meta.syncedAt,
    'X-Catalog-Reason': reason,
  }
  if (matchesEtag(request.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers })
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  return new Response(baseline.text, { status: 200, headers })
}

async function readCatalog(env, request) {
  if (!env?.DB) return snapshotResponse(request, env, 'no-d1')
  try {
    const meta = await readMeta(env.DB)
    if (!meta.version && !meta.order) {
      // 还没铺底：返回快照，同时后台开始建库
      return snapshotResponse(request, env, 'empty')
    }
    const etag = etagFor(meta)
    const inm = request.headers.get('if-none-match')
    if (inm && inm.trim() === etag) return catalogResponse(request, '', etag, meta)
    if (bodyCache && bodyCache.etag === etag && Date.now() - bodyCache.at < 60_000) {
      // 用缓存里那份 meta 生成响应头，保证头和 body 描述的是同一份数据
      return catalogResponse(request, bodyCache.body, etag, bodyCache.meta)
    }
    const rows = await env.DB.prepare('SELECT cid, payload FROM catalog_albums').all()
    if (!rows?.results?.length) return snapshotResponse(request, env, 'empty')
    const body = buildCatalogBody({
      generatedAt: meta.generatedAt,
      source: meta.source || OFFICIAL,
      version: meta.version,
      syncedAt: meta.syncedAt,
      lastCheckAt: meta.lastCheckAt,
      albums: rows.results,
      order: parseOrder(meta.order),
    })
    bodyCache = { etag, body, meta, at: Date.now() }
    return catalogResponse(request, body, etag, meta)
  } catch (error) {
    if (!isMissingTable(error)) console.error('[siren] 曲库读取失败，退回静态快照', error)
    return snapshotResponse(request, env, isMissingTable(error) ? 'no-schema' : 'db-error')
  }
}

async function readMetaPayload(env) {
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
  }
  if (!env?.DB) {
    const baseline = await loadBaseline(env).catch(() => null)
    const stats = baseline ? catalogStats(baseline.data.albums) : { albums: 0, songs: 0 }
    return { ...base, version: 0, albums: stats.albums, songs: stats.songs, generatedAt: baseline?.data?.generatedAt || '', syncedAt: baseline?.data?.syncedAt || baseline?.data?.generatedAt || '', lastCheckAt: '', lastError: '', lastErrorAt: '' }
  }
  try {
    const meta = await readMeta(env.DB)
    if (!meta.version && !meta.order) {
      const baseline = await loadBaseline(env).catch(() => null)
      const stats = baseline ? catalogStats(baseline.data.albums) : { albums: 0, songs: 0 }
      return { ...base, version: 0, albums: stats.albums, songs: stats.songs, generatedAt: baseline?.data?.generatedAt || '', syncedAt: baseline?.data?.generatedAt || '', lastCheckAt: '', lastError: '', lastErrorAt: '' }
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
    const baseline = await loadBaseline(env).catch(() => null)
    const stats = baseline ? catalogStats(baseline.data.albums) : { albums: 0, songs: 0 }
    return { ...base, version: 0, albums: stats.albums, songs: stats.songs, generatedAt: baseline?.data?.generatedAt || '', syncedAt: '', lastCheckAt: '', lastError: String(error?.message || error), lastErrorAt: '' }
  }
}

/* ---------- 懒同步 ---------- */

let lastLazyAttemptAt = 0

function maybeTriggerSync(env, ctx, meta) {
  if (!ctx?.waitUntil || !meta) return
  if (!meta.stale) return
  const now = Date.now()
  const lastCheck = Date.parse(meta.lastCheckAt || '')
  // 失败也会写 lastCheckAt，60 秒内不重复打官方接口
  if (Number.isFinite(lastCheck) && now - lastCheck < 60_000) return
  // meta 读不出来（表缺失 / D1 报错 / 还没铺底）时 lastCheckAt 是空串，
  // 只靠它限流会让每个请求都触发一轮同步，这里再兜一层 isolate 内的时间闸门。
  if (now - lastLazyAttemptAt < 60_000) return
  lastLazyAttemptAt = now
  ctx.waitUntil(
    runSync(env, { reason: 'lazy' })
      .then((result) => {
        if (result && !result.ok) console.error('[siren] 曲库懒同步失败', result.error)
        else if (result?.warnings?.length) console.warn('[siren] 曲库懒同步部分失败', result.warnings.slice(0, 3))
      })
      .catch((error) => {
        console.error('[siren] 曲库懒同步异常', error)
      }),
  )
}

/* ---------- 手动同步限流 ---------- */

let lastManualAt = 0
const MANUAL_COOLDOWN_MS = 15_000

/* ---------- 入口 ---------- */

export async function handleCatalog(request, env, ctx, url) {
  const method = (request.method || 'GET').toUpperCase()
  const action = url.pathname.split('/').filter(Boolean)[2] || ''

  try {
    if (!action && (method === 'GET' || method === 'HEAD')) {
      const meta = await readMetaPayload(env).catch(() => null)
      if (meta) maybeTriggerSync(env, ctx, meta)
      return await readCatalog(env, request)
    }

    if (action === 'meta' && (method === 'GET' || method === 'HEAD')) {
      const meta = await readMetaPayload(env)
      maybeTriggerSync(env, ctx, meta)
      return jsonResponse(200, meta)
    }

    if (action === 'sync') {
      if (method !== 'POST') return jsonResponse(405, { error: '只接受 POST' }, { Allow: 'POST' })
      // 只接受同源触发：第三方页面即使能发 no-cors POST，也不该能驱动我们打官方接口
      const origin = request.headers.get('origin')
      if (origin) {
        let originHost = ''
        try {
          originHost = new URL(origin).host
        } catch {
          originHost = ''
        }
        if (originHost && originHost !== url.host) {
          return jsonResponse(403, { error: '只接受同源请求' })
        }
      }
      const now = Date.now()
      if (now - lastManualAt < MANUAL_COOLDOWN_MS) {
        return jsonResponse(429, { error: '同步过于频繁，请稍后再试' })
      }
      lastManualAt = now
      const result = await runSync(env, { reason: 'manual' })
      return jsonResponse(result.ok ? 200 : 502, result)
    }

    return jsonResponse(404, { error: '接口不存在' })
  } catch (error) {
    console.error('[siren] 曲库接口异常', error)
    return jsonResponse(500, { error: '曲库服务异常' })
  }
}

/** cron 入口：每 10 分钟一次，把官方最新曲库合进 D1 */
export async function runScheduledSync(env) {
  try {
    const result = await runSync(env, { reason: 'cron' })
    if (!result.ok) console.error('[siren] 曲库定时同步失败', result.error)
    else if (result.warnings?.length) console.warn('[siren] 曲库定时同步部分失败', result.warnings.slice(0, 3))
    else if (result.addedPending) console.log(`[siren] 曲库仍有 ${result.addedPending} 张新专辑待抓取`)
    return result
  } catch (error) {
    console.error('[siren] 曲库定时同步异常', error)
    return { ok: false, error: String(error?.message || error) }
  }
}
