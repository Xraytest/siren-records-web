// SIREN RECORDS 归档前端 —— Cloudflare Worker 后端
// 由 server/server.mjs 迁移而来：node:http + node:sqlite -> fetch + D1。
// 接口契约与本地 Node 版保持一致，方便两端共用同一套前端。

const SESSION_DAYS = 30
const OFFICIAL = 'https://monster-siren.hypergryph.com'
const SONG_CACHE_MS = 30 * 60 * 1000
const songCache = new Map()

/* ---------- 响应helper ---------- */

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const HSTS = 'max-age=31536000; includeSubDomains'

function json(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Strict-Transport-Security': HSTS,
      ...extraHeaders,
    },
  })
}

const BODY_MAX_BYTES = 2 * 1024 * 1024

// 按字节流式读取并在超限时立刻 cancel：只看 Content-Length 挡不住 chunked，
// 而 `await request.text()` 会先把整个 body 读进 isolate 内存（128MB 上限）再判断。
async function readTextCapped(request, max) {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) {
        try {
          await reader.cancel()
        } catch {
          /* 已经断开就无所谓 */
        }
        throw new HttpError(413, '请求体过大')
      }
      chunks.push(value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* ignore */
    }
  }
  const buf = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    buf.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(buf)
}

async function readJson(request) {
  const declared = Number(request.headers.get('content-length') || 0)
  if (declared > BODY_MAX_BYTES) throw new HttpError(413, '请求体过大')
  const text = await readTextCapped(request, BODY_MAX_BYTES)
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
}

function redirect(location) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  })
}

/* ---------- 数据映射 ---------- */

function toUser(row) {
  return { id: row.id, name: row.name, handle: row.handle, bio: row.bio, createdAt: row.createdAt }
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function toPlaylist(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tags: parseJson(row.tags, []),
    coverSongCid: row.coverSongCid || null,
    songs: parseJson(row.songs, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt || null,
    publishCode: row.publishCode || null,
  }
}

function clipText(value, max = 2000) {
  return typeof value === 'string' ? value.replace(/\u0000/g, '').slice(0, max) : ''
}

const MAX_SONGS_PER_PLAYLIST = 500

function cidList(value) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.filter((v) => typeof v === 'string' && v.length < 64))).slice(0, MAX_SONGS_PER_PLAYLIST)
}

function tagList(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim().slice(0, 24))
    .slice(0, 6)
}

// 广场封面只接受内嵌 data:image 或官方 CDN：否则一条发布就能把 feed 撑到上百 MB，
// 并且每个访客的浏览器都会向攻击者指定的地址发请求（IP 信标）。
// 注意：`data:` 封面不进广场（只留在自己的歌单里）——60 条 × 200KB ≈ 12MB 一次响应，
// 匿名 feed 会被单账号打成流量与内存放大器。
const COVER_MAX = 200_000
const OFFICIAL_IMAGE_PREFIX = 'https://web.hycdn.cn/siren/pic/'
function normalizeCover(value) {
  if (typeof value !== 'string' || !value) return null
  // 超长直接丢弃而不是截断：截断后的 base64 一定渲染不出来，等于静默写坏数据
  if (value.length > COVER_MAX) return null
  if (value.startsWith('data:image/')) return value
  if (value.startsWith(OFFICIAL_IMAGE_PREFIX)) return value
  return null
}

/** 广场里只保留官方 CDN 封面，内嵌 data: 一律不公开返回 */
function publicCover(value) {
  return typeof value === 'string' && value.startsWith(OFFICIAL_IMAGE_PREFIX) ? value : null
}

// 曲目编号（cid）与封面曲目编号都是纯数字串；此前 coverSongCid 没有任何校验，
// 单账号可以塞进 200 × 2MB 的字符串，让 GET /api/playlists 永久 500。
const CID_MAX = 16
function songCidOrNull(value) {
  if (typeof value !== 'string') return null
  const cid = value.trim()
  return /^\d{1,16}$/.test(cid) ? cid : null
}

// 分享码是客户端用 LZString 生成的 URI-safe 串：只允许其字母表，超长直接拒（不要截断成坏链接）。
const PUBLISH_CODE_MAX = 20_000
const PUBLISH_CODE_RE = /^[A-Za-z0-9+\-$]+$/
function normalizePublishCode(value) {
  if (typeof value !== 'string') throw new HttpError(400, '分享码缺失')
  const code = value.trim()
  if (!code) throw new HttpError(400, '分享码缺失')
  if (code.length > PUBLISH_CODE_MAX) throw new HttpError(413, '分享码过长')
  if (!PUBLISH_CODE_RE.test(code)) throw new HttpError(400, '分享码包含非法字符')
  return code
}

/* ---------- 加密helper ---------- */

const enc = new TextEncoder()

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return hex(buf)
}

// Workers 运行时不提供 node:crypto 的 scrypt，改用 WebCrypto PBKDF2-SHA256（10 万次迭代）做口令派生
async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    key,
    256,
  )
  return hex(bits)
}

// 长度不同也走完整循环：避免用响应时间泄露令牌长度（提前返回会暴露「前缀比对到第几位」）。
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const n = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

// 用户不存在时也跑一次等价的 PBKDF2，抹平「存在 vs 不存在」的时间差，
// 否则可以靠响应时间稳定枚举已注册用户名。
// 注意：随机数与密钥派生都放在函数里做，不能在全局作用域调用（Workers 10021）。
let DUMMY_SALT = null
let DUMMY_HASH = null
async function dummyCreds() {
  if (!DUMMY_SALT) {
    DUMMY_SALT = randomHex(16)
    DUMMY_HASH = await hashPassword(randomHex(32), DUMMY_SALT)
  }
  return { salt: DUMMY_SALT, hash: DUMMY_HASH }
}

// 简易限速（每 isolate 内存计数）。Workers 多实例不共享，抗不了分布式暴力破解，
// 生产上应叠加 CF WAF 的 Rate Limiting 规则；这里至少挡住单点连打。
const AUTH_WINDOW_MS = 60_000
const AUTH_MAX_PER_WINDOW = 20
const authHits = new Map()

// Map 键是客户端 IP，长期运行会累积已过期的条目；超过阈值时做一次懒清理。
function pruneHits(map, now) {
  if (map.size < 2048) return
  for (const [key, hit] of map) if (hit.reset < now) map.delete(key)
}

function authAllowed(request) {
  const key = request.headers.get('CF-Connecting-IP') || 'unknown'
  const now = Date.now()
  pruneHits(authHits, now)
  const hit = authHits.get(key)
  if (!hit || hit.reset < now) {
    authHits.set(key, { reset: now + AUTH_WINDOW_MS, n: 1 })
    return true
  }
  hit.n += 1
  return hit.n <= AUTH_MAX_PER_WINDOW
}

function makeIdentity(name) {
  return {
    id: `u_${randomHex(8)}`,
    handle: name.toLowerCase().replace(/\s+/g, '_'),
  }
}

// 匿名出站代理（audio / lyric）单独一档：每分钟 120 次，够一个人正常听歌，
// 又不至于让本站变成打官方接口的放大器。
const PROXY_WINDOW_MS = 60_000
const PROXY_MAX_PER_WINDOW = 120
const proxyHits = new Map()

function proxyAllowed(request) {
  const key = request.headers.get('CF-Connecting-IP') || 'unknown'
  const now = Date.now()
  pruneHits(proxyHits, now)
  const hit = proxyHits.get(key)
  if (!hit || hit.reset < now) {
    proxyHits.set(key, { reset: now + PROXY_WINDOW_MS, n: 1 })
    return true
  }
  hit.n += 1
  return hit.n <= PROXY_MAX_PER_WINDOW
}

/* ---------- 数据库导出（供 NetCenter 定期备份拉取） ---------- */

// 令牌由 `wrangler secret put BACKUP_TOKEN` 注入；未配置时接口直接 404，等于不存在。
const BACKUP_MIN_TOKEN = 32
const BACKUP_WINDOW_MS = 60 * 60_000
const BACKUP_MAX_PER_WINDOW = 10
const backupHits = new Map()

function backupAllowed(request) {
  const key = request.headers.get('CF-Connecting-IP') || 'unknown'
  const now = Date.now()
  pruneHits(backupHits, now)
  const hit = backupHits.get(key)
  if (!hit || hit.reset < now) {
    backupHits.set(key, { reset: now + BACKUP_WINDOW_MS, n: 1 })
    return true
  }
  hit.n += 1
  return hit.n <= BACKUP_MAX_PER_WINDOW
}

const BACKUP_TABLES = ['users', 'sessions', 'playlists']
// 每张表的「永不复用主键」列：keyset 分页的游标必须用它，不能用 rowid
const BACKUP_KEYS = { users: 'id', sessions: 'token', playlists: 'id' }
const BACKUP_PAGE = 500

// 与 migrations/0001_init.sql 保持一致：备份自带建表语句，可独立恢复。
const BACKUP_SCHEMA = `CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  handle TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_name ON users(name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  coverSongCid TEXT,
  cover TEXT,
  songs TEXT NOT NULL DEFAULT '[]',
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  publishedAt INTEGER,
  publishCode TEXT
);
CREATE INDEX IF NOT EXISTS playlists_user ON playlists(userId, updatedAt DESC);
CREATE INDEX IF NOT EXISTS playlists_published ON playlists(publishedAt DESC);`

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (value instanceof Uint8Array) {
    return `X'${[...value].map((b) => b.toString(16).padStart(2, '0')).join('')}'`
  }
  if (value instanceof ArrayBuffer) {
    return `X'${[...new Uint8Array(value)].map((b) => b.toString(16).padStart(2, '0')).join('')}'`
  }
  // 单引号按 SQL 规则双写；NUL 没法直接写进字面量，用 char(0) 拼接保证逐字节还原
  return sqlText(value)
}

function sqlText(value) {
  const text = String(value)
  if (!text.includes('\u0000')) return `'${text.replace(/'/g, "''")}'`
  const parts = text.split('\u0000').map((piece) => `'${piece.replace(/'/g, "''")}'`)
  return `(${parts.join(' || char(0) || ')})`
}

function asciiHeader(value) {
  return String(value).replace(/[^\x20-\x7e]/g, '')
}

async function dumpDatabase(env, now = Date.now()) {
  const lines = []
  const counts = {}
  lines.push('-- SIREN RECORDS · Cloudflare D1 backup')
  lines.push(`-- generated_at: ${new Date(now).toISOString()}`)
  lines.push('-- schema: 0001_init')
  lines.push('PRAGMA foreign_keys=OFF;')
  lines.push('BEGIN TRANSACTION;')
  lines.push(BACKUP_SCHEMA)
  for (const table of BACKUP_TABLES) {
    lines.push(`DELETE FROM ${table};`)
    // keyset 分页按「永不复用的主键」而不是 rowid：rowid 在删行后会被新行复用，
    // 一旦复用发生在两页之间，游标之后的新行就会被静默跳过（已实测复现）。
    // 三张表的主键都是随机串（users.id / sessions.token / playlists.id），插入不会改变既有顺序。
    const key = BACKUP_KEYS[table]
    let lastKey = ''
    let count = 0
    for (;;) {
      const { results } = await env.DB.prepare(
        `SELECT * FROM ${table} WHERE ${key} > ? ORDER BY ${key} LIMIT ?`,
      )
        .bind(lastKey, BACKUP_PAGE)
        .all()
      const rows = results || []
      for (const row of rows) {
        lastKey = row[key]
        count++
        const cols = Object.keys(row)
        lines.push(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => sqlLiteral(row[c])).join(', ')});`)
      }
      if (rows.length < BACKUP_PAGE) break
    }
    counts[table] = count
  }
  lines.push('COMMIT;')
  lines.push(`-- END OF DUMP tables=${BACKUP_TABLES.map((t) => `${t}:${counts[t]}`).join(',')}`)
  return { sql: `${lines.join('\n')}\n`, counts }
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text))
  return hex(digest)
}


/* ---------- 会话 ---------- */

function bearerToken(request) {
  const header = request.headers.get('Authorization') || ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

// 会话只存令牌的 SHA-256，不存明文：备份导出的是 hash，即使 dump 泄露也无法
// 直接拿来冒充会话（服务端只接受「原像的 hash 命中」，拿到 hash 反推不出原像）。
// 代价：部署后旧会话全部失效，用户需要重新登录一次。
async function sessionKey(token) {
  return sha256Hex(token)
}

async function currentUser(request, env) {
  const token = bearerToken(request)
  if (!token) return null
  const key = await sessionKey(token)
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.userId
     WHERE s.token = ? AND s.expiresAt > ?`,
  )
    .bind(key, Date.now())
    .first()
  return row ? toUser(row) : null
}

async function requireUser(request, env) {
  const user = await currentUser(request, env)
  if (!user) throw new HttpError(401, '请先登录')
  return user
}

async function issueSession(env, userId) {
  const token = randomHex(32)
  const now = Date.now()
  await env.DB.prepare('INSERT INTO sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)')
    .bind(await sessionKey(token), userId, now, now + SESSION_DAYS * 86400_000)
    .run()
  return token
}

async function userCount(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()
  return row?.n ?? 0
}

/* ---------- 歌单 ---------- */

async function ownPlaylist(env, userId, id) {
  const row = await env.DB.prepare('SELECT * FROM playlists WHERE id = ? AND userId = ?').bind(id, userId).first()
  if (!row) throw new HttpError(404, '歌单不存在')
  return row
}

async function persist(env, row, patch) {
  const next = {
    ...toPlaylist(row),
    ...patch,
    updatedAt: patch.updatedAt ?? Date.now(),
    cover: patch.cover !== undefined ? patch.cover : row.cover,
    publishedAt: patch.publishedAt !== undefined ? patch.publishedAt : row.publishedAt || null,
    publishCode: patch.publishCode !== undefined ? patch.publishCode : row.publishCode || null,
  }
  await env.DB.prepare(
    `UPDATE playlists SET name = ?, description = ?, tags = ?, coverSongCid = ?, cover = ?,
       songs = ?, updatedAt = ?, publishedAt = ?, publishCode = ? WHERE id = ?`,
  )
    .bind(
      next.name,
      next.description,
      JSON.stringify(next.tags),
      next.coverSongCid,
      next.cover,
      JSON.stringify(next.songs),
      next.updatedAt,
      next.publishedAt,
      next.publishCode,
      row.id,
    )
    .run()
  const fresh = await env.DB.prepare('SELECT * FROM playlists WHERE id = ?').bind(row.id).first()
  return toPlaylist(fresh)
}

// 每账号歌单上限：没有上限时一个账号就能把 D1 写入配额（100k 行/天）打光，
// 连带认证与登录一起写失败，属于低成本的全站可用性打击。
const MAX_PLAYLISTS_PER_USER = 200
async function assertPlaylistQuota(env, userId, adding) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM playlists WHERE userId = ?').bind(userId).first()
  if ((row?.n || 0) + adding > MAX_PLAYLISTS_PER_USER) {
    throw new HttpError(409, `每个账号最多 ${MAX_PLAYLISTS_PER_USER} 张歌单，请先删除不用的`)
  }
}

async function insertPlaylist(env, userId, input, now = Date.now()) {
  const id = `pl_${randomHex(8)}`
  await env.DB.prepare(
    `INSERT INTO playlists (id, userId, name, description, tags, coverSongCid, cover, songs, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      userId,
      clipText(input.name, 80).trim() || '未命名歌单',
      clipText(input.description),
      JSON.stringify(tagList(input.tags)),
      songCidOrNull(input.coverSongCid),
      // 创建时也走白名单：否则可以把任意字符串（最长到 body 上限）塞进 cover 白占存储
      typeof input.cover === 'string' ? normalizeCover(input.cover) : null,
      JSON.stringify(cidList(input.songs)),
      now,
      now,
    )
    .run()
  const row = await env.DB.prepare('SELECT * FROM playlists WHERE id = ?').bind(id).first()
  return toPlaylist(row)
}

// 每个账号在广场最多占这么多张卡片：否则一个人把 60 张全部发布就能挤掉所有真实用户
const FEED_PAGE = 60
const FEED_PER_USER = 6

async function feedItems(env) {
  // 多取一些候选再按账号取前 N 张，保证广场的展示位不被单个账号垄断
  const { results } = await env.DB.prepare(
    `SELECT p.*, u.name AS authorName FROM playlists p JOIN users u ON u.id = p.userId
     WHERE p.publishedAt IS NOT NULL ORDER BY p.publishedAt DESC LIMIT 360`,
  ).all()
  const perUser = new Map()
  const picked = []
  for (const row of results || []) {
    const used = perUser.get(row.userId) || 0
    if (used >= FEED_PER_USER) continue
    perUser.set(row.userId, used + 1)
    picked.push(row)
    if (picked.length >= FEED_PAGE) break
  }
  return picked.map((row) => ({
    code: row.publishCode,
    name: row.name,
    description: row.description,
    authorName: row.authorName,
    authorId: row.userId,
    songCount: parseJson(row.songs, []).length,
    // 广场只回官方 CDN 封面：内嵌 data: 封面留着 60×200KB，匿名 feed 会被打成 12MB
    cover: publicCover(row.cover),
    tags: parseJson(row.tags, []),
    at: row.publishedAt,
  }))
}

/* ---------- 官方接口 ---------- */

async function officialSong(cid) {
  const hit = songCache.get(cid)
  if (hit && hit.expiresAt > Date.now()) return hit.data
  const res = await fetch(`${OFFICIAL}/api/song/${cid}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 siren-archive', Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new HttpError(502, `官方接口返回 ${res.status}`)
  const body = await res.json()
  if (body?.code !== 0 || !body?.data) throw new HttpError(502, '官方接口数据异常')
  const data = { sourceUrl: body.data.sourceUrl || '', lyricUrl: body.data.lyricUrl || '' }
  songCache.set(cid, { data, expiresAt: Date.now() + SONG_CACHE_MS })
  return data
}

async function resolveAudio(cid) {
  try {
    const data = await officialSong(cid)
    return /^https:\/\//.test(data.sourceUrl) ? data.sourceUrl : null
  } catch {
    return null
  }
}

async function resolveLyric(cid) {
  try {
    const data = await officialSong(cid)
    return /^https:\/\//.test(data.lyricUrl) ? data.lyricUrl : null
  } catch {
    return null
  }
}

const LYRIC_MAX_BYTES = 512 * 1024

/** 取回 .lrc 原文；超出上限或非 2xx 返回 null（由调用方给 502/204） */
async function fetchLyricText(source) {
  try {
    const response = await fetch(source, {
      headers: { Accept: 'text/plain,*/*', 'User-Agent': 'siren-records/1.0 (+https://siren.neolx.ltd)' },
      signal: AbortSignal.timeout(12_000),
    })
    if (!response.ok) return null
    const text = await response.text()
    if (!text) return null
    return text.length > LYRIC_MAX_BYTES ? null : text
  } catch {
    return null
  }
}

/* ---------- 路由 ---------- */

async function handleApi(request, env, url) {
  const method = request.method || 'GET'
  const parts = url.pathname.split('/').filter(Boolean) // ['api', ...]

  // --- auth ---
  if (parts[1] === 'auth') {
    // 只对会花算力/会产生写操作的动作计数：GET /me 与 logout 不该吃掉同一条配额
    // （共享出口 20 人同时开页面就会把自己的正常用户 429 掉）
    const counted = (parts[2] === 'login' || parts[2] === 'register') && method === 'POST'
    if (counted && !authAllowed(request)) throw new HttpError(429, '尝试过于频繁，请稍后再试')

    if (parts[2] === 'register' && method === 'POST') {
      const body = await readJson(request)
      const name = clipText(body.name, 40).trim()
      const password = typeof body.password === 'string' ? body.password : ''
      if (name.length < 2 || name.length > 18) throw new HttpError(400, '代号需为 2–18 个字符')
      if (password.length < 6) throw new HttpError(400, '密码至少 6 位')
      const exists = await env.DB.prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE').bind(name).first()
      if (exists) throw new HttpError(409, '该代号已被占用')
      const salt = randomHex(16)
      const { id, handle } = makeIdentity(name)
      try {
        await env.DB.prepare(
          'INSERT INTO users (id, name, handle, bio, salt, hash, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
          .bind(id, name, handle, '', salt, await hashPassword(password, salt), Date.now())
          .run()
      } catch (error) {
        // 并发注册同名：UNIQUE 约束会在这里炸，转成 409 而不是 500
        if (/UNIQUE|constraint/i.test(String(error?.message || ''))) throw new HttpError(409, '该代号已被占用')
        throw error
      }
      const token = await issueSession(env, id)
      const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first()
      return json(200, { token, user: toUser(row), userCount: await userCount(env) })
    }

    if (parts[2] === 'login' && method === 'POST') {
      const body = await readJson(request)
      const name = clipText(body.name, 40).trim()
      const password = typeof body.password === 'string' ? body.password : ''
      const row = await env.DB.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE').bind(name).first()
      // 用户不存在也照样跑一次派生，抹平时间差（否则可枚举用户名）
      const dummy = await dummyCreds()
      const candidate = row ? await hashPassword(password, row.salt) : await hashPassword(password, dummy.salt)
      const expected = row ? row.hash : dummy.hash
      if (!row || !safeEqual(candidate, expected)) {
        throw new HttpError(401, '代号或密码不正确')
      }
      const token = await issueSession(env, row.id)
      return json(200, { token, user: toUser(row), userCount: await userCount(env) })
    }

    if (parts[2] === 'logout' && method === 'POST') {
      const token = bearerToken(request)
      if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(await sessionKey(token)).run()
      return json(200, { ok: true })
    }

    if (parts[2] === 'me') {
      if (method === 'GET') {
        const user = await requireUser(request, env)
        return json(200, { user, userCount: await userCount(env) })
      }
      if (method === 'PATCH') {
        const user = await requireUser(request, env)
        const body = await readJson(request)
        const nextName = typeof body.name === 'string' ? body.name.trim() : user.name
        const nextBio = typeof body.bio === 'string' ? body.bio.slice(0, 240) : user.bio
        if (nextName.length < 2 || nextName.length > 18) throw new HttpError(400, '代号需为 2–18 个字符')
        const clash = await env.DB.prepare(
          'SELECT id FROM users WHERE name = ? COLLATE NOCASE AND id <> ?',
        )
          .bind(nextName, user.id)
          .first()
        if (clash) throw new HttpError(409, '该代号已被占用')
        await env.DB.prepare('UPDATE users SET name = ?, handle = ?, bio = ? WHERE id = ?')
          .bind(nextName, nextName.toLowerCase().replace(/\s+/g, '_'), nextBio, user.id)
          .run()
        const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first()
        return json(200, { user: toUser(row) })
      }
    }
    throw new HttpError(405, '不支持的方法')
  }

  // --- feed ---
  if (parts[1] === 'feed' && method === 'GET') {
    return json(200, { feed: await feedItems(env) })
  }

  // --- playlists ---
  if (parts[1] === 'playlists') {
    if (!parts[2]) {
      if (method === 'GET') {
        const user = await requireUser(request, env)
        const { results } = await env.DB.prepare('SELECT * FROM playlists WHERE userId = ? ORDER BY updatedAt DESC')
          .bind(user.id)
          .all()
        return json(200, { playlists: (results || []).map(toPlaylist) })
      }
      if (method === 'POST') {
        const user = await requireUser(request, env)
        const body = await readJson(request)
        await assertPlaylistQuota(env, user.id, 1)
        return json(200, { playlist: await insertPlaylist(env, user.id, body) })
      }
      throw new HttpError(405, '不支持的方法')
    }

    if (parts[2] === 'import' && method === 'POST') {
      const user = await requireUser(request, env)
      const body = await readJson(request)
      const list = Array.isArray(body.items) ? body.items.slice(0, 50) : []
      if (!list.length) throw new HttpError(400, '没有可导入的歌单')
      await assertPlaylistQuota(env, user.id, list.length)
      const created = []
      for (let i = 0; i < list.length; i++) {
        created.push(await insertPlaylist(env, user.id, list[i], Date.now() + i))
      }
      return json(200, { created, count: created.length })
    }

    const id = parts[2]
    const action = parts[3]
    const user = await requireUser(request, env)
    const row = await ownPlaylist(env, user.id, id)

    if (!action) {
      if (method === 'GET') return json(200, { playlist: toPlaylist(row) })
      if (method === 'PATCH') {
        const body = await readJson(request)
        const patch = {}
        if (typeof body.name === 'string') patch.name = body.name.trim().slice(0, 80) || '未命名歌单'
        if (typeof body.description === 'string') patch.description = clipText(body.description)
        if (Array.isArray(body.tags)) patch.tags = tagList(body.tags)
        if (typeof body.coverSongCid === 'string' || body.coverSongCid === null) {
          patch.coverSongCid = songCidOrNull(body.coverSongCid)
        }
        return json(200, { playlist: await persist(env, row, patch) })
      }
      if (method === 'DELETE') {
        await env.DB.prepare('DELETE FROM playlists WHERE id = ?').bind(id).run()
        return json(200, { ok: true })
      }
      throw new HttpError(405, '不支持的方法')
    }

    if (action === 'songs') {
      const playlist = toPlaylist(row)
      if (method === 'POST') {
        const body = await readJson(request)
        const incoming = cidList(body.cids)
        const songs = [...playlist.songs]
        let added = 0
        for (const cid of incoming) {
          if (!songs.includes(cid)) {
            songs.push(cid)
            added++
          }
        }
        // 单次只限 500 条是不够的：这个路由没有任何限速，循环调用能把单行撑到无界
        if (songs.length > MAX_SONGS_PER_PLAYLIST) {
          throw new HttpError(409, `单张歌单最多 ${MAX_SONGS_PER_PLAYLIST} 首，请先删减`)
        }
        const saved = await persist(env, row, {
          songs,
          coverSongCid: playlist.coverSongCid || songs[0] || null,
        })
        return json(200, { playlist: saved, added })
      }
      if (method === 'DELETE' && parts[4]) {
        let cid
        try {
          cid = decodeURIComponent(parts[4])
        } catch {
          throw new HttpError(400, '曲目编号不合法')
        }
        const songs = playlist.songs.filter((c) => c !== cid)
        const saved = await persist(env, row, {
          songs,
          coverSongCid: playlist.coverSongCid === cid ? songs[0] || null : playlist.coverSongCid,
        })
        return json(200, { playlist: saved })
      }
    }

    if (action === 'order' && method === 'PATCH') {
      const body = await readJson(request)
      const songs = cidList(body.songs)
      const playlist = toPlaylist(row)
      // 只接受与原集合相同的重排结果
      const sameSet = songs.length === playlist.songs.length && songs.every((cid) => playlist.songs.includes(cid))
      if (!sameSet) throw new HttpError(400, '曲目顺序不合法')
      return json(200, { playlist: await persist(env, row, { songs }) })
    }

    if (action === 'publish' && method === 'POST') {
      const body = await readJson(request)
      const code = normalizePublishCode(body.code)
      // 分享码去重必须是单条语句：先 SELECT 再 UPDATE 会被并发发布插空子，
      // 两张卡片指向同一个码会让前端以 code 为 key 的列表冲突。
      const claim = await env.DB.prepare(
        `UPDATE playlists SET publishCode = ? WHERE id = ? AND userId = ?
           AND NOT EXISTS (SELECT 1 FROM playlists WHERE publishCode = ? AND id <> ?)`,
      )
        .bind(code, row.id, row.userId, code, row.id)
        .run()
      if (!claim.meta.changes) throw new HttpError(409, '这个分享码已被其它歌单占用')
      const now = Date.now()
      const patch = { publishedAt: now, publishCode: code, updatedAt: now }
      // 只有显式传了 cover 才动封面：脚本式发布不该把已设好的封面清成 null
      if ('cover' in body) patch.cover = normalizeCover(body.cover)
      const saved = await persist(env, row, patch)
      const entry = (await feedItems(env)).find((item) => item.code === code) || null
      return json(200, { playlist: saved, entry })
    }

    if (action === 'unpublish' && method === 'POST') {
      const saved = await persist(env, row, { publishedAt: null, publishCode: null, cover: null })
      return json(200, { playlist: saved })
    }

    throw new HttpError(405, '不支持的方法')
  }

  // --- backup：运维备份用的整库导出，必须带 Bearer BACKUP_TOKEN ---
  if (parts[1] === 'backup' && parts[2] === 'dump') {
    const configured = typeof env.BACKUP_TOKEN === 'string' ? env.BACKUP_TOKEN.trim() : ''
    // 先判配置：没配密钥时对**所有方法**都按「接口不存在」处理，
    // 否则 POST 拿到 405 就等于告诉对方这个入口存在。
    if (configured.length < BACKUP_MIN_TOKEN) throw new HttpError(404, '接口不存在')
    if (method !== 'GET') throw new HttpError(405, '不支持的方法')
    // 限速放在令牌校验之前：否则猜测令牌不消耗任何配额
    if (!backupAllowed(request)) throw new HttpError(429, '请求过于频繁，请稍后再试')
    const token = bearerToken(request)
    if (!token || !safeEqual(token, configured)) throw new HttpError(401, '未授权')
    const dump = await dumpDatabase(env)
    const digest = await sha256Hex(dump.sql)
    return new Response(dump.sql, {
      status: 200,
      headers: {
        'Content-Type': 'application/sql; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Strict-Transport-Security': HSTS,
        'Referrer-Policy': 'no-referrer',
        'X-Backup-Sha256': digest,
        'X-Backup-Bytes': String(enc.encode(dump.sql).byteLength),
        'X-Backup-Tables': asciiHeader(BACKUP_TABLES.map((t) => `${t}:${dump.counts[t]}`).join(',')),
        'X-Backup-At': new Date().toISOString(),
      },
    })
  }

  // --- audio：官方音频地址带时效签名，需在播放时向官方接口换取新地址 ---
  if (parts[1] === 'audio' && parts[2] && (method === 'GET' || method === 'HEAD')) {
    const cid = parts[2]
    if (!/^\d{1,12}$/.test(cid)) throw new HttpError(400, '曲目编号不合法')
    // 这是个匿名出站代理：不限速的话可以拿本站当放大器去打官方接口
    if (!proxyAllowed(request)) throw new HttpError(429, '请求过于频繁，请稍后再试')
    const source = await resolveAudio(cid)
    if (!source) throw new HttpError(502, '无法获取音频地址')
    return redirect(source)
  }

  if (parts[1] === 'lyric' && parts[2] && (method === 'GET' || method === 'HEAD')) {
    const cid = parts[2]
    if (!/^\d{1,12}$/.test(cid)) throw new HttpError(400, '曲目编号不合法')
    if (!proxyAllowed(request)) throw new HttpError(429, '请求过于频繁，请稍后再试')
    const source = await resolveLyric(cid)
    if (!source) {
      // 纯音乐等没有歌词的曲目：返回空内容，避免前端产生错误日志
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
    }
    // 同源代理歌词字节，而不是 302 到 CDN：
    // 302 会让浏览器在 connect-src 里跨域取 .lrc，CSP 必须额外放行 web.hycdn.cn，
    // 一旦忘配就表现为「线上永远暂无歌词、开发环境正常」。同源返回没有这个问题，
    // 顺带省掉一次跨域握手，也能由 Workers 缓存。
    const lyrics = await fetchLyricText(source)
    if (!lyrics) throw new HttpError(502, '无法获取歌词内容')
    const headers = new Headers({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    })
    return new Response(method === 'HEAD' ? null : lyrics, { status: 200, headers })
  }

  throw new HttpError(404, '接口不存在')
}

/* ---------- Worker 入口 ---------- */

// 过期会话行只增不减会让 sessions 无限膨胀；每 6 小时清扫一次（低频、异步）。
async function sweepSessions(env) {
  try {
    await env.DB.prepare('DELETE FROM sessions WHERE expiresAt <= ?').bind(Date.now()).run()
  } catch (error) {
    console.error('[siren] sessions 清理失败', error)
  }
}

// 过期会话行只增不减会让 sessions 无限膨胀；每 6 小时清扫一次。
// 用模块作用域而不是 env：Workers 不保证 env 上的写入能跨请求保留，
// 那样每个请求都会跑一次 DELETE（含静态资源），等于把所有请求都挂在一次 D1 全表扫描上。
let lastSweepAt = 0

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (Date.now() - lastSweepAt > 6 * 3600_000) {
      lastSweepAt = Date.now()
      ctx.waitUntil(sweepSessions(env))
    }

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url)
      } catch (error) {
        if (error instanceof HttpError) return json(error.status, { error: error.message })
        console.error('[siren] 未处理错误', error)
        return json(500, { error: '服务器内部错误' })
      }
    }

    // 静态资源：补上 CSP / X-Frame-Options / Referrer-Policy。
    // 站点自身只用同源脚本与塞壬 CDN 的图片音频，img-src 放开即可。
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request)
      if (res.status !== 404) {
        const headers = new Headers(res.headers)
        headers.set(
          'Content-Security-Policy',
          "default-src 'self'; img-src 'self' data: https://web.hycdn.cn https://res01.hycdn.cn; " +
            "media-src 'self' https://res01.hycdn.cn; connect-src 'self' https://monster-siren.hypergryph.com; " +
            "style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'",
        )
        headers.set('X-Frame-Options', 'DENY')
        headers.set('Referrer-Policy', 'no-referrer')
        headers.set('X-Content-Type-Options', 'nosniff')
        headers.set('Strict-Transport-Security', HSTS)
        if (url.pathname.startsWith('/assets/')) {
          // Vite 产物文件名带内容哈希，可以放心长缓存；HTML/图标仍走默认校验
          headers.set('Cache-Control', 'public, max-age=31536000, immutable')
        }
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
      }
      return res
    }

    return new Response('前端尚未构建', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  },
}
