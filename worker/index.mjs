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

async function readJson(request) {
  const text = await request.text()
  if (text.length > 2 * 1024 * 1024) throw new HttpError(413, '请求体过大')
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

function cidList(value) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.filter((v) => typeof v === 'string' && v.length < 64))).slice(0, 500)
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
const COVER_MAX = 200_000
const OFFICIAL_IMAGE_PREFIX = 'https://web.hycdn.cn/siren/pic/'
function normalizeCover(value) {
  if (typeof value !== 'string' || !value) return null
  const cover = value.slice(0, COVER_MAX)
  if (cover.startsWith('data:image/')) return cover
  if (cover.startsWith(OFFICIAL_IMAGE_PREFIX)) return cover
  return null
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

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
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

function authAllowed(request) {
  const key = request.headers.get('CF-Connecting-IP') || 'unknown'
  const now = Date.now()
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

/* ---------- 数据库导出（供 NetCenter 定期备份拉取） ---------- */

// 令牌由 `wrangler secret put BACKUP_TOKEN` 注入；未配置时接口直接 404，等于不存在。
const BACKUP_MIN_TOKEN = 32
const BACKUP_WINDOW_MS = 60 * 60_000
const BACKUP_MAX_PER_WINDOW = 10
const backupHits = new Map()

function backupAllowed(request) {
  const key = request.headers.get('CF-Connecting-IP') || 'unknown'
  const now = Date.now()
  const hit = backupHits.get(key)
  if (!hit || hit.reset < now) {
    backupHits.set(key, { reset: now + BACKUP_WINDOW_MS, n: 1 })
    return true
  }
  hit.n += 1
  return hit.n <= BACKUP_MAX_PER_WINDOW
}

const BACKUP_TABLES = ['users', 'sessions', 'playlists']
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
    // keyset 分页（rowid > last）而不是 OFFSET：备份期间有新行插入时不会跳行/重复
    let lastRowid = -1
    let count = 0
    for (;;) {
      const { results } = await env.DB.prepare(
        `SELECT rowid AS __rowid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      )
        .bind(lastRowid, BACKUP_PAGE)
        .all()
      const rows = results || []
      for (const row of rows) {
        lastRowid = row.__rowid
        count++
        const cols = Object.keys(row).filter((c) => c !== '__rowid')
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

async function currentUser(request, env) {
  const token = bearerToken(request)
  if (!token) return null
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.userId
     WHERE s.token = ? AND s.expiresAt > ?`,
  )
    .bind(token, Date.now())
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
    .bind(token, userId, now, now + SESSION_DAYS * 86400_000)
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
      typeof input.coverSongCid === 'string' ? input.coverSongCid : null,
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

async function feedItems(env) {
  const { results } = await env.DB.prepare(
    `SELECT p.*, u.name AS authorName FROM playlists p JOIN users u ON u.id = p.userId
     WHERE p.publishedAt IS NOT NULL ORDER BY p.publishedAt DESC LIMIT 60`,
  ).all()
  return (results || []).map((row) => ({
    code: row.publishCode,
    name: row.name,
    description: row.description,
    authorName: row.authorName,
    authorId: row.userId,
    songCount: parseJson(row.songs, []).length,
    cover: row.cover || null,
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

/* ---------- 路由 ---------- */

async function handleApi(request, env, url) {
  const method = request.method || 'GET'
  const parts = url.pathname.split('/').filter(Boolean) // ['api', ...]

  // --- auth ---
  if (parts[1] === 'auth') {
    if (!authAllowed(request)) throw new HttpError(429, '尝试过于频繁，请稍后再试')

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
      await env.DB.prepare(
        'INSERT INTO users (id, name, handle, bio, salt, hash, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(id, name, handle, '', salt, await hashPassword(password, salt), Date.now())
        .run()
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
      if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
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
          patch.coverSongCid = body.coverSongCid
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
      const code = typeof body.code === 'string' ? body.code.slice(0, 12000) : ''
      if (!code) throw new HttpError(400, '缺少分享码')
      const now = Date.now()
      const saved = await persist(env, row, {
        publishedAt: now,
        publishCode: code,
        cover: normalizeCover(body.cover),
        updatedAt: now,
      })
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
    if (method !== 'GET') throw new HttpError(405, '不支持的方法')
    const configured = typeof env.BACKUP_TOKEN === 'string' ? env.BACKUP_TOKEN.trim() : ''
    // 没配密钥时按「接口不存在」处理，不泄露这个入口的存在
    if (configured.length < BACKUP_MIN_TOKEN) throw new HttpError(404, '接口不存在')
    const token = bearerToken(request)
    if (!token || !safeEqual(token, configured)) throw new HttpError(401, '未授权')
    if (!backupAllowed(request)) throw new HttpError(429, '请求过于频繁，请稍后再试')
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
    const source = await resolveAudio(cid)
    if (!source) throw new HttpError(502, '无法获取音频地址')
    return redirect(source)
  }

  if (parts[1] === 'lyric' && parts[2] && (method === 'GET' || method === 'HEAD')) {
    const cid = parts[2]
    if (!/^\d{1,12}$/.test(cid)) throw new HttpError(400, '曲目编号不合法')
    const source = await resolveLyric(cid)
    if (!source) {
      // 纯音乐等没有歌词的曲目：返回空内容，避免前端产生错误日志
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
    }
    return redirect(source)
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    // 过期会话行只增不减会让 sessions 无限膨胀；每 6 小时顺带清扫一次，不阻塞当前请求。
    if (!env.SESSION_SWEEP_DONE || Date.now() - env.SESSION_SWEEP_DONE > 6 * 3600_000) {
      env.SESSION_SWEEP_DONE = Date.now()
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
