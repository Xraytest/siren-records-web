import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'

import { bindCatalogDb, handleCatalog, runSyncOnce, startCatalogScheduler } from './catalog.mjs'

const PORT = Number(process.env.PORT || 8090)
const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data')
const DIST_DIR = path.resolve(process.env.DIST_DIR || 'dist')
const SESSION_DAYS = 30

await mkdir(DATA_DIR, { recursive: true })

const db = new DatabaseSync(path.join(DATA_DIR, 'siren.db'))
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
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
  CREATE INDEX IF NOT EXISTS playlists_published ON playlists(publishedAt DESC);
  CREATE INDEX IF NOT EXISTS playlists_publish_code ON playlists(publishCode);
  CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expiresAt);
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(userId);
`)

// 曲库表：与线上 D1 的 migrations/0003_catalog.sql 保持一致
bindCatalogDb(db)

// `node server/server.mjs --sync-catalog`：只跑一轮曲库同步，不监听端口。
// 部署前自检、排查「线上为什么还没新专辑」都用它。
if (process.argv.includes('--sync-catalog')) {
  const result = await runSyncOnce({ reason: 'cli' })
  console.log(JSON.stringify(result, null, 2))
  db.close()
  // 抢不到租约 / 被间隔挡下都不算「跑过一轮」，退出码要能让人和脚本看出区别
  process.exit(result.ok && !result.skipped ? 0 : 1)
}

/* ---------- helpers ---------- */

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex')
}

// 用户不存在时也要跑一次等价的派生，抹平「存在 ~30ms / 不存在 ~1.4ms」的时间差，
// 否则可以靠响应时间稳定枚举已注册用户名。DUMMY 的盐/哈希只在内存里生成。
const DUMMY_SALT = randomBytes(16).toString('hex')
const DUMMY_HASH = hashPassword(randomBytes(32).toString('hex'), DUMMY_SALT)

// 简易限速：同一 IP 的认证请求按分钟窗口计数，超限直接拒。
// Worker 线上版建议同时在 CF 侧配 WAF Rate Limiting 规则（零代码、更抗绕过）。
const AUTH_WINDOW_MS = 60_000
const AUTH_MAX_PER_WINDOW = 20
const authHits = new Map()

function authAllowed(req) {
  const key = req.socket?.remoteAddress || 'unknown'
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

function pruneHits(map, now) {
  if (map.size < 2048) return
  for (const [key, hit] of map) if (hit.reset < now) map.delete(key)
}

// 不要按 hex 解码再比：`Buffer.from(x,'hex')` 会在第一个非 hex 字符处截断，
// 于是任意令牌都能与 base64 形态的令牌比成相等（实测 'x' 与 'q7Rb+0lP/Zm2kQ=='）。
// 统一按 utf8 字节比较；长度不同时用 sha256 摘要抹平长度差异。
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length === bufB.length) return timingSafeEqual(bufA, bufB)
  const digA = createHash('sha256').update(bufA).digest()
  const digB = createHash('sha256').update(bufB).digest()
  return timingSafeEqual(digA, digB)
}

function makeIdentity(name) {
  return {
    id: `u_${randomBytes(8).toString('hex')}`,
    handle: name.toLowerCase().replace(/\s+/g, '_'),
  }
}

function toUser(row) {
  return { id: row.id, name: row.name, handle: row.handle, bio: row.bio, createdAt: row.createdAt }
}

function toPlaylist(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tags: JSON.parse(row.tags),
    coverSongCid: row.coverSongCid || null,
    songs: JSON.parse(row.songs),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt || null,
    publishCode: row.publishCode || null,
  }
}

function clipText(value, max = 2000) {
  return typeof value === 'string' ? value.replace(/\u0000/g, '').slice(0, max) : ''
}

function cidList(value) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.filter((v) => typeof v === 'string' && v.length < 64))).slice(0, MAX_SONGS_PER_PLAYLIST)
}

const MAX_SONGS_PER_PLAYLIST = 500

function tagList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim().slice(0, 24)).slice(0, 6)
}

// 广场封面只接受内嵌 data:image 或官方 CDN：否则一条发布就能把 feed 撑到上百 MB，
// 并且每个访客的浏览器都会向攻击者指定的地址发请求（IP 信标）。
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

// 曲目编号（含封面曲目编号）都应是纯数字串，与 Worker 同一规则
function songCidOrNull(value) {
  if (typeof value !== 'string') return null
  const cid = value.trim()
  return /^\d{1,16}$/.test(cid) ? cid : null
}

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

// 一行坏 JSON 不该让整个 feed 500（Worker 侧同样容错）
function parseJson(value, fallback) {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) ?? fallback
  } catch {
    return fallback
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    // 与 Worker 对齐：同一套安全头，避免「本地测过就等于线上安全」的错觉
    'X-Content-Type-Options': 'nosniff',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Referrer-Policy': 'no-referrer',
  })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 2 * 1024 * 1024) throw new HttpError(413, '请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
}

// 会话只存令牌的 SHA-256，不存明文：备份导出的是 hash，dump 泄露也无法直接冒充会话
function sessionKey(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function issueSession(userId) {
  const token = randomBytes(32).toString('hex')
  const now = Date.now()
  db.prepare('INSERT INTO sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)').run(
    sessionKey(token),
    userId,
    now,
    now + SESSION_DAYS * 86400_000,
  )
  return token
}

function currentUser(req) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) return null
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.userId
       WHERE s.token = ? AND s.expiresAt > ?`,
    )
    .get(sessionKey(token), Date.now())
  return row ? toUser(row) : null
}

function requireUser(req) {
  const user = currentUser(req)
  if (!user) throw new HttpError(401, '请先登录')
  return user
}

function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n
}

/* ---------- 数据库导出（本地镜像：与 Worker /api/backup/dump 同一契约） ---------- */

const BACKUP_MIN_TOKEN = 32
const BACKUP_WINDOW_MS = 60 * 60_000
const BACKUP_MAX_PER_WINDOW = 10
const backupHits = new Map()

function backupAllowed(req) {
  const key = req.socket.remoteAddress || 'unknown'
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

/* ---------- 音频/歌词代理限速（与 Worker 同一档：每分钟 120 次） ---------- */

const PROXY_WINDOW_MS = 60_000
const PROXY_MAX_PER_WINDOW = 120
const proxyHits = new Map()

function proxyAllowed(req) {
  const key = req.socket.remoteAddress || 'unknown'
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

const BACKUP_TABLES = ['users', 'sessions', 'playlists']
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
CREATE INDEX IF NOT EXISTS playlists_published ON playlists(publishedAt DESC);
CREATE INDEX IF NOT EXISTS playlists_publish_code ON playlists(publishCode);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expiresAt);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(userId);`

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`
  // 单引号按 SQL 规则双写；NUL 没法直接写进字面量，用 char(0) 拼接保证逐字节还原
  return sqlText(value)
}

function sqlText(value) {
  const text = String(value)
  if (!text.includes('\u0000')) return `'${text.replace(/'/g, "''")}'`
  const parts = text.split('\u0000').map((piece) => `'${piece.replace(/'/g, "''")}'`)
  return `(${parts.join(' || char(0) || ')})`
}

function dumpDatabase(now = Date.now()) {
  const lines = []
  const counts = {}
  lines.push('-- SIREN RECORDS · local sqlite backup')
  lines.push(`-- generated_at: ${new Date(now).toISOString()}`)
  lines.push('-- schema: 0001_init')
  lines.push('PRAGMA foreign_keys=OFF;')
  lines.push('BEGIN TRANSACTION;')
  lines.push(BACKUP_SCHEMA)
  for (const table of BACKUP_TABLES) {
    lines.push(`DELETE FROM ${table};`)
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
    for (const row of rows) {
      const cols = Object.keys(row)
      lines.push(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => sqlLiteral(row[c])).join(', ')});`)
    }
    counts[table] = rows.length
  }
  lines.push('COMMIT;')
  lines.push(`-- END OF DUMP tables=${BACKUP_TABLES.map((t) => `${t}:${counts[t]}`).join(',')}`)
  return { sql: `${lines.join('\n')}\n`, counts }
}

function ownPlaylist(userId, id) {
  const row = db.prepare('SELECT * FROM playlists WHERE id = ? AND userId = ?').get(id, userId)
  if (!row) throw new HttpError(404, '歌单不存在')
  return row
}

function persist(row, patch) {
  const next = {
    ...toPlaylist(row),
    ...patch,
    updatedAt: patch.updatedAt ?? Date.now(),
    cover: patch.cover !== undefined ? patch.cover : row.cover,
    publishedAt: patch.publishedAt !== undefined ? patch.publishedAt : row.publishedAt || null,
    publishCode: patch.publishCode !== undefined ? patch.publishCode : row.publishCode || null,
  }
  db.prepare(
    `UPDATE playlists SET name = ?, description = ?, tags = ?, coverSongCid = ?, cover = ?,
       songs = ?, updatedAt = ?, publishedAt = ?, publishCode = ? WHERE id = ?`,
  ).run(
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
  return toPlaylist(db.prepare('SELECT * FROM playlists WHERE id = ?').get(row.id))
}

// 与 Worker 一致：每账号歌单上限，避免单账号打光写入配额
const MAX_PLAYLISTS_PER_USER = 200
function assertPlaylistQuota(userId, adding) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM playlists WHERE userId = ?').get(userId)
  const n = row ? Number(row.n) : 0
  if (n + adding > MAX_PLAYLISTS_PER_USER) {
    throw new HttpError(409, `每个账号最多 ${MAX_PLAYLISTS_PER_USER} 张歌单，请先删除不用的`)
  }
}

function insertPlaylist(userId, input, now = Date.now()) {
  const id = `pl_${randomBytes(8).toString('hex')}`
  db.prepare(
    `INSERT INTO playlists (id, userId, name, description, tags, coverSongCid, cover, songs, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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
  return toPlaylist(db.prepare('SELECT * FROM playlists WHERE id = ?').get(id))
}

const FEED_PAGE = 60
const FEED_PER_USER = 6

function feedItems() {
  const rows = db
    .prepare(
      `SELECT p.*, u.name AS authorName FROM playlists p JOIN users u ON u.id = p.userId
       WHERE p.publishedAt IS NOT NULL ORDER BY p.publishedAt DESC LIMIT 360`,
    )
    .all()
  // 与线上 Worker 一致：单账号最多占 FEED_PER_USER 张，避免一个人挤满整个广场
  const perUser = new Map()
  const picked = []
  for (const row of rows) {
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

/* ---------- routes ---------- */

async function handleApi(req, res, pathname) {
  const method = req.method || 'GET'
  const parts = pathname.split('/').filter(Boolean) // ['api', ...]

  // --- 曲库（与官方保持同步，无需登录）---
  if (parts[1] === 'catalog') {
    return handleCatalog(req, res, pathname)
  }

  // --- auth ---
  if (parts[1] === 'auth') {
    // 只对会产生算力/写操作的动作计数：GET /me 与 logout 不该吃掉同一条配额
    // （否则共享出口下 20 个用户/分钟打开页面就会把正常用户 429 掉）
    const countedAction = method === 'POST' && (parts[2] === 'register' || parts[2] === 'login')
    if (countedAction && !authAllowed(req)) throw new HttpError(429, '尝试过于频繁，请稍后再试')

    if (parts[2] === 'register' && method === 'POST') {
      const body = await readJson(req)
      const name = clipText(body.name, 40).trim()
      const password = typeof body.password === 'string' ? body.password : ''
      if (name.length < 2 || name.length > 18) throw new HttpError(400, '代号需为 2–18 个字符')
      if (password.length < 6) throw new HttpError(400, '密码至少 6 位')
      const exists = db.prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE').get(name)
      if (exists) throw new HttpError(409, '该代号已被占用')
      const salt = randomBytes(16).toString('hex')
      const { id, handle } = makeIdentity(name)
      try {
        db.prepare('INSERT INTO users (id, name, handle, bio, salt, hash, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          id,
          name,
          handle,
          '',
          salt,
          hashPassword(password, salt),
          Date.now(),
        )
      } catch (error) {
        // check-then-insert 竞态：并发注册同名时 UNIQUE 约束会抛出，语义应当是 409 而不是 500
        if (/UNIQUE|constraint/i.test(String(error?.message ?? error))) {
          throw new HttpError(409, '该代号已被占用')
        }
        throw error
      }
      const token = issueSession(id)
      const user = toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id))
      return json(res, 200, { token, user, userCount: userCount() })
    }

    if (parts[2] === 'login' && method === 'POST') {
      const body = await readJson(req)
      const name = clipText(body.name, 40).trim()
      const password = typeof body.password === 'string' ? body.password : ''
      const row = db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE').get(name)
      // 用户不存在也照样跑一次派生，抹平时间差（否则可枚举用户名）
      const candidate = row ? hashPassword(password, row.salt) : hashPassword(password, DUMMY_SALT)
      const expected = row ? row.hash : DUMMY_HASH
      if (!row || !safeEqual(candidate, expected)) {
        throw new HttpError(401, '代号或密码不正确')
      }
      const token = issueSession(row.id)
      return json(res, 200, { token, user: toUser(row), userCount: userCount() })
    }

    if (parts[2] === 'logout' && method === 'POST') {
      const header = req.headers.authorization || ''
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
      if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(sessionKey(token))
      return json(res, 200, { ok: true })
    }

    if (parts[2] === 'me') {
      if (method === 'GET') {
        const user = requireUser(req)
        return json(res, 200, { user, userCount: userCount() })
      }
      if (method === 'PATCH') {
        const user = requireUser(req)
        const body = await readJson(req)
        const nextName = typeof body.name === 'string' ? body.name.trim() : user.name
        const nextBio = typeof body.bio === 'string' ? body.bio.slice(0, 240) : user.bio
        if (nextName.length < 2 || nextName.length > 18) throw new HttpError(400, '代号需为 2–18 个字符')
        const clash = db.prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE AND id <> ?').get(nextName, user.id)
        if (clash) throw new HttpError(409, '该代号已被占用')
        db.prepare('UPDATE users SET name = ?, handle = ?, bio = ? WHERE id = ?').run(
          nextName,
          nextName.toLowerCase().replace(/\s+/g, '_'),
          nextBio,
          user.id,
        )
        const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)
        return json(res, 200, { user: toUser(row) })
      }
    }
    throw new HttpError(405, '不支持的方法')
  }

  // --- feed ---
  if (parts[1] === 'feed' && method === 'GET') {
    return json(res, 200, { feed: feedItems() })
  }

  // --- playlists ---
  if (parts[1] === 'playlists') {
    if (!parts[2]) {
      if (method === 'GET') {
        const user = requireUser(req)
        const rows = db
          .prepare('SELECT * FROM playlists WHERE userId = ? ORDER BY updatedAt DESC')
          .all(user.id)
        return json(res, 200, { playlists: rows.map(toPlaylist) })
      }
      if (method === 'POST') {
        const user = requireUser(req)
        const body = await readJson(req)
        assertPlaylistQuota(user.id, 1)
        return json(res, 200, { playlist: insertPlaylist(user.id, body) })
      }
      throw new HttpError(405, '不支持的方法')
    }

    if (parts[2] === 'import' && method === 'POST') {
      const user = requireUser(req)
      const body = await readJson(req)
      const list = Array.isArray(body.items) ? body.items.slice(0, 50) : []
      if (!list.length) throw new HttpError(400, '没有可导入的歌单')
      assertPlaylistQuota(user.id, list.length)
      const created = list.map((item, i) => insertPlaylist(user.id, item, Date.now() + i))
      return json(res, 200, { created, count: created.length })
    }

    const id = parts[2]
    const action = parts[3]
    const user = requireUser(req)
    const row = ownPlaylist(user.id, id)

    if (!action) {
      if (method === 'GET') return json(res, 200, { playlist: toPlaylist(row) })
      if (method === 'PATCH') {
        const body = await readJson(req)
        const patch = {}
        if (typeof body.name === 'string') patch.name = body.name.trim().slice(0, 80) || '未命名歌单'
        if (typeof body.description === 'string') patch.description = clipText(body.description)
        if (Array.isArray(body.tags)) patch.tags = tagList(body.tags)
        if (typeof body.coverSongCid === 'string' || body.coverSongCid === null) {
          patch.coverSongCid = songCidOrNull(body.coverSongCid)
        }
        return json(res, 200, { playlist: persist(row, patch) })
      }
      if (method === 'DELETE') {
        db.prepare('DELETE FROM playlists WHERE id = ?').run(id)
        return json(res, 200, { ok: true })
      }
      throw new HttpError(405, '不支持的方法')
    }

    if (action === 'songs') {
      const playlist = toPlaylist(row)
      if (method === 'POST') {
        const body = await readJson(req)
        const incoming = cidList(body.cids)
        const songs = [...playlist.songs]
        let added = 0
        for (const cid of incoming) {
          if (!songs.includes(cid)) {
            songs.push(cid)
            added++
          }
        }
        // 单次只限 500 条不够：循环调用能把单行撑到无界
        if (songs.length > MAX_SONGS_PER_PLAYLIST) {
          throw new HttpError(409, `单张歌单最多 ${MAX_SONGS_PER_PLAYLIST} 首，请先删减`)
        }
        const saved = persist(row, {
          songs,
          coverSongCid: playlist.coverSongCid || songs[0] || null,
        })
        return json(res, 200, { playlist: saved, added })
      }
      if (method === 'DELETE' && parts[4]) {
        let cid
        try {
          cid = decodeURIComponent(parts[4])
        } catch {
          throw new HttpError(400, '曲目编号不合法')
        }
        const songs = playlist.songs.filter((c) => c !== cid)
        const saved = persist(row, {
          songs,
          coverSongCid: playlist.coverSongCid === cid ? songs[0] || null : playlist.coverSongCid,
        })
        return json(res, 200, { playlist: saved })
      }
    }

    if (action === 'order' && method === 'PATCH') {
      const body = await readJson(req)
      const songs = cidList(body.songs)
      const playlist = toPlaylist(row)
      // 只接受与原集合相同的重排结果
      const sameSet =
        songs.length === playlist.songs.length && songs.every((cid) => playlist.songs.includes(cid))
      if (!sameSet) throw new HttpError(400, '曲目顺序不合法')
      return json(res, 200, { playlist: persist(row, { songs }) })
    }

    if (action === 'publish' && method === 'POST') {
      const body = await readJson(req)
      const code = normalizePublishCode(body.code)
      // 与 Worker 一致：占码与更新放在同一条语句里，避免并发发布造成重码
      const claim = db
        .prepare(
          `UPDATE playlists SET publishCode = ? WHERE id = ? AND userId = ?
             AND NOT EXISTS (SELECT 1 FROM playlists WHERE publishCode = ? AND id <> ?)`,
        )
        .run(code, row.id, row.userId, code, row.id)
      if (!claim.changes) throw new HttpError(409, '这个分享码已被其它歌单占用')
      const now = Date.now()
      const patch = { publishedAt: now, publishCode: code, updatedAt: now }
      // 只有显式传了 cover 才动封面：脚本式发布不该把已设好的封面清成 null
      if ('cover' in body) patch.cover = normalizeCover(body.cover)
      const saved = persist(row, patch)
      const entry = feedItems().find((item) => item.code === code) || null
      return json(res, 200, { playlist: saved, entry })
    }

    if (action === 'unpublish' && method === 'POST') {
      const saved = persist(row, { publishedAt: null, publishCode: null, cover: null })
      return json(res, 200, { playlist: saved })
    }

    throw new HttpError(405, '不支持的方法')
  }

  // --- backup：运维备份用的整库导出，必须带 Bearer BACKUP_TOKEN ---
  if (parts[1] === 'backup' && parts[2] === 'dump') {
    const configured = String(process.env.BACKUP_TOKEN || '').trim()
    // 未配置时对所有方法一律 404：先判方法会让 POST 得到 405，等于确认这个隐藏入口存在
    if (configured.length < BACKUP_MIN_TOKEN) throw new HttpError(404, '接口不存在')
    if (method !== 'GET') throw new HttpError(405, '不支持的方法')
    // 限速放在令牌校验之前：否则猜令牌完全不消耗配额
    if (!backupAllowed(req)) throw new HttpError(429, '请求过于频繁，请稍后再试')
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (!token || !safeEqual(token, configured)) throw new HttpError(401, '未授权')
    const dump = dumpDatabase()
    const digest = createHash('sha256').update(dump.sql, 'utf8').digest('hex')
    res.writeHead(200, {
      'Content-Type': 'application/sql; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'Referrer-Policy': 'no-referrer',
      'X-Backup-Sha256': digest,
      'X-Backup-Bytes': String(Buffer.byteLength(dump.sql)),
      'X-Backup-Tables': BACKUP_TABLES.map((t) => `${t}:${dump.counts[t]}`).join(','),
      'X-Backup-At': new Date().toISOString(),
    })
    res.end(dump.sql)
    return
  }

  // --- audio：官方音频地址带时效签名，需在播放时向官方接口换取新地址 ---
  if (parts[1] === 'audio' && parts[2] && (method === 'GET' || method === 'HEAD')) {
    const cid = parts[2]
    if (!/^\d{1,12}$/.test(cid)) throw new HttpError(400, '曲目编号不合法')
    // 匿名出站代理：不限速就变成「拿本站当放大器打官方接口」
    if (!proxyAllowed(req)) throw new HttpError(429, '请求过于频繁，请稍后再试')
    const source = await resolveAudio(cid)
    if (!source) throw new HttpError(502, '无法获取音频地址')
    res.writeHead(302, { Location: source, 'Cache-Control': 'no-store' })
    res.end()
    return
  }

  if (parts[1] === 'lyric' && parts[2] && (method === 'GET' || method === 'HEAD')) {
    const cid = parts[2]
    if (!/^\d{1,12}$/.test(cid)) throw new HttpError(400, '曲目编号不合法')
    if (!proxyAllowed(req)) throw new HttpError(429, '请求过于频繁，请稍后再试')
    const source = await resolveLyric(cid)
    if (!source) {
      // 纯音乐等没有歌词的曲目：返回空内容，避免前端产生错误日志
      res.writeHead(204, { 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    // 与 Worker 一致：同源返回歌词文本，不再 302 到 CDN（否则 CSP connect-src 必须额外放行）
    const lyrics = await fetchLyricText(source)
    if (!lyrics) throw new HttpError(502, '无法获取歌词内容')
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(lyrics),
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(method === 'HEAD' ? undefined : lyrics)
    return
  }

  throw new HttpError(404, '接口不存在')
}

/* ---------- 官方接口 ---------- */

const OFFICIAL = 'https://monster-siren.hypergryph.com'
const SONG_CACHE_MS = 30 * 60 * 1000
const songCache = new Map()

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

/* ---------- static ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.lrc': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: https://web.hycdn.cn https://res01.hycdn.cn; " +
    "media-src 'self' https://res01.hycdn.cn; connect-src 'self' https://monster-siren.hypergryph.com; " +
    "style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'",
}

async function sendFile(res, file, method, cacheControl) {
  const info = await stat(file)
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': cacheControl,
    ...SECURITY_HEADERS,
  })
  if (method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(file).pipe(res)
}

async function serveStatic(req, res, pathname) {
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET'
  let rel
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    rel = '/'
  }
  if (rel.endsWith('/')) rel += 'index.html'
  const file = path.resolve(DIST_DIR, `.${rel}`)
  const indexFile = path.join(DIST_DIR, 'index.html')

  // 必须带路径分隔符才算真的还在 DIST_DIR 内：只判断前缀会让
  // /distX/secret.txt 这类兄弟目录也通过检查（dist-archive/ 同样沦陷）。
  if (file !== DIST_DIR && !file.startsWith(DIST_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden')
    return
  }

  const isAsset = rel.startsWith('/assets/')
  try {
    const info = await stat(file)
    if (info.isFile()) {
      await sendFile(res, file, method, isAsset ? 'public, max-age=31536000, immutable' : 'no-cache')
      return
    }
  } catch {
    // 落到 SPA 兜底
  }

  try {
    await readFile(indexFile)
    await sendFile(res, indexFile, method, 'no-cache')
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('前端尚未构建')
  }
}

/* ---------- server ---------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url.pathname)
      return
    }
    await serveStatic(req, res, url.pathname)
  } catch (error) {
    if (error instanceof HttpError) {
      json(res, error.status, { error: error.message })
      return
    }
    console.error('[siren] 未处理错误', error)
    if (!res.headersSent) json(res, 500, { error: '服务器内部错误' })
  }
})

// 默认只监听回环：避免开发服务器在局域网裸奔。需要对外时显式 HOST=0.0.0.0。
const HOST = process.env.HOST || '127.0.0.1'
server.listen(PORT, HOST, () => {
  console.log(`[siren] http://${HOST}:${PORT}  dist=${DIST_DIR} data=${DATA_DIR}`)
})

// 本地开发同样保持「与官方最新同步」：启动 5 秒后同步一次，之后每 10 分钟一次
startCatalogScheduler()

// 过期会话行只增不减会让 sessions 无限膨胀，定时清扫。
const cleanup = setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expiresAt <= ?').run(Date.now())
}, 6 * 3600_000)
cleanup.unref()

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearInterval(cleanup)
    server.close(() => {
      db.close()
      process.exit(0)
    })
  })
}
