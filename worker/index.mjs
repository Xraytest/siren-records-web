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

function json(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
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
  return typeof value === 'string' ? value.slice(0, max) : ''
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

function makeIdentity(name) {
  return {
    id: `u_${randomHex(8)}`,
    handle: name.toLowerCase().replace(/\s+/g, '_'),
  }
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
      typeof input.cover === 'string' ? input.cover : null,
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
      if (!row || !safeEqual(await hashPassword(password, row.salt), row.hash)) {
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
        return json(200, { playlist: await insertPlaylist(env, user.id, body) })
      }
      throw new HttpError(405, '不支持的方法')
    }

    if (parts[2] === 'import' && method === 'POST') {
      const user = await requireUser(request, env)
      const body = await readJson(request)
      const list = Array.isArray(body.items) ? body.items.slice(0, 50) : []
      if (!list.length) throw new HttpError(400, '没有可导入的歌单')
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
        const cid = decodeURIComponent(parts[4])
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
        cover: typeof body.cover === 'string' ? body.cover : null,
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url)
      } catch (error) {
        if (error instanceof HttpError) return json(error.status, { error: error.message })
        console.error('[siren] 未处理错误', error)
        return json(500, { error: '服务器内部错误' })
      }
    }

    // 其余请求交给静态资源绑定；SPA 走 index.html 兜底
    if (env.ASSETS) {
      return env.ASSETS.fetch(request)
    }

    return new Response('前端尚未构建', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  },
}
