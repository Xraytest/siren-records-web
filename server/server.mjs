import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'

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
`)

/* ---------- helpers ---------- */

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex')
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
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
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function cidList(value) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.filter((v) => typeof v === 'string' && v.length < 64))).slice(0, 500)
}

function tagList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim().slice(0, 24)).slice(0, 6)
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

function issueSession(userId) {
  const token = randomBytes(32).toString('hex')
  const now = Date.now()
  db.prepare('INSERT INTO sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)').run(
    token,
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
    .get(token, Date.now())
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
    typeof input.coverSongCid === 'string' ? input.coverSongCid : null,
    typeof input.cover === 'string' ? input.cover : null,
    JSON.stringify(cidList(input.songs)),
    now,
    now,
  )
  return toPlaylist(db.prepare('SELECT * FROM playlists WHERE id = ?').get(id))
}

function feedItems() {
  const rows = db
    .prepare(
      `SELECT p.*, u.name AS authorName FROM playlists p JOIN users u ON u.id = p.userId
       WHERE p.publishedAt IS NOT NULL ORDER BY p.publishedAt DESC LIMIT 60`,
    )
    .all()
  return rows.map((row) => ({
    code: row.publishCode,
    name: row.name,
    description: row.description,
    authorName: row.authorName,
    authorId: row.userId,
    songCount: JSON.parse(row.songs).length,
    cover: row.cover || null,
    tags: JSON.parse(row.tags),
    at: row.publishedAt,
  }))
}

/* ---------- routes ---------- */

async function handleApi(req, res, pathname) {
  const method = req.method || 'GET'
  const parts = pathname.split('/').filter(Boolean) // ['api', ...]

  // --- auth ---
  if (parts[1] === 'auth') {
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
      db.prepare('INSERT INTO users (id, name, handle, bio, salt, hash, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        id,
        name,
        handle,
        '',
        salt,
        hashPassword(password, salt),
        Date.now(),
      )
      const token = issueSession(id)
      const user = toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id))
      return json(res, 200, { token, user, userCount: userCount() })
    }

    if (parts[2] === 'login' && method === 'POST') {
      const body = await readJson(req)
      const name = clipText(body.name, 40).trim()
      const password = typeof body.password === 'string' ? body.password : ''
      const row = db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE').get(name)
      if (!row || !safeEqual(hashPassword(password, row.salt), row.hash)) {
        throw new HttpError(401, '代号或密码不正确')
      }
      const token = issueSession(row.id)
      return json(res, 200, { token, user: toUser(row), userCount: userCount() })
    }

    if (parts[2] === 'logout' && method === 'POST') {
      const header = req.headers.authorization || ''
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
      if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
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
        return json(res, 200, { playlist: insertPlaylist(user.id, body) })
      }
      throw new HttpError(405, '不支持的方法')
    }

    if (parts[2] === 'import' && method === 'POST') {
      const user = requireUser(req)
      const body = await readJson(req)
      const list = Array.isArray(body.items) ? body.items.slice(0, 50) : []
      if (!list.length) throw new HttpError(400, '没有可导入的歌单')
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
          patch.coverSongCid = body.coverSongCid
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
        const saved = persist(row, {
          songs,
          coverSongCid: playlist.coverSongCid || songs[0] || null,
        })
        return json(res, 200, { playlist: saved, added })
      }
      if (method === 'DELETE' && parts[4]) {
        const cid = decodeURIComponent(parts[4])
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
      const code = typeof body.code === 'string' ? body.code.slice(0, 12000) : ''
      if (!code) throw new HttpError(400, '缺少分享码')
      const now = Date.now()
      const saved = persist(row, {
        publishedAt: now,
        publishCode: code,
        cover: typeof body.cover === 'string' ? body.cover : null,
        updatedAt: now,
      })
      const entry = feedItems().find((item) => item.code === code) || null
      return json(res, 200, { playlist: saved, entry })
    }

    if (action === 'unpublish' && method === 'POST') {
      const saved = persist(row, { publishedAt: null, publishCode: null, cover: null })
      return json(res, 200, { playlist: saved })
    }

    throw new HttpError(405, '不支持的方法')
  }

  // --- audio：官方音频地址带时效签名，需在播放时向官方接口换取新地址 ---
  if (parts[1] === 'audio' && parts[2] && (method === 'GET' || method === 'HEAD')) {
    const cid = parts[2]
    if (!/^\d{1,12}$/.test(cid)) throw new HttpError(400, '曲目编号不合法')
    const source = await resolveAudio(cid)
    if (!source) throw new HttpError(502, '无法获取音频地址')
    res.writeHead(302, { Location: source, 'Cache-Control': 'no-store' })
    res.end()
    return
  }

  if (parts[1] === 'lyric' && parts[2] && (method === 'GET' || method === 'HEAD')) {
    const cid = parts[2]
    if (!/^\d{1,12}$/.test(cid)) throw new HttpError(400, '曲目编号不合法')
    const source = await resolveLyric(cid)
    if (!source) {
      // 纯音乐等没有歌词的曲目：返回空内容，避免前端产生错误日志
      res.writeHead(204, { 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    res.writeHead(302, { Location: source, 'Cache-Control': 'no-store' })
    res.end()
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

async function sendFile(res, file, method, cacheControl) {
  const info = await stat(file)
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
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

  if (!file.startsWith(DIST_DIR)) {
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[siren] http://0.0.0.0:${PORT}  dist=${DIST_DIR} data=${DATA_DIR}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close()
      process.exit(0)
    })
  })
}
