/**
 * 曲库同步内核 —— 与运行时无关的纯逻辑 + 官方接口访问。
 *
 * 为什么单独一层：曲库需要「和官方保持最新」，而站点有两个后端
 * （Cloudflare Worker + D1、本地 Node + node:sqlite）。两端共用同一套
 * 差异计算、合并规则与请求重试，避免「本地能用、线上不同步」。
 *
 * 本文件不 import 任何运行时 API（除全局 fetch / AbortSignal），
 * 存储通过 store 适配器注入，因此可以直接用 node --test 覆盖。
 */

export const OFFICIAL = 'https://monster-siren.hypergryph.com'

/** 后台检查间隔：cron 与本地定时器都用它 */
export const SYNC_INTERVAL_MS = 10 * 60_000
/** 超过这个时间没成功同步，就认为可能过期（触发一次懒同步） */
export const STALE_AFTER_MS = 20 * 60_000
/** 同步租约：防止 cron / 懒同步 / 手动同步同时跑（长轮次会在中途续租） */
export const LEASE_MS = 3 * 60_000
/** 两次同步之间的最小间隔：手动/懒触发都不会比这更频繁，避免被刷成打官方接口的放大器 */
export const MIN_SYNC_GAP_MS = 60_000
/** 单次官方请求超时 */
export const FETCH_TIMEOUT_MS = 15_000
/** 每次同步最多抓多少张新专辑详情（新专辑一次通常只有个位数） */
export const DETAIL_BUDGET = 12
/** 每次同步最多补多少首歌的直链（新歌 + 上次没补上的） */
export const SONG_BUDGET = 24
/** 每次同步滚动复查多少张老专辑（官方会往老专辑里追加曲目） */
export const REFRESH_BUDGET = 4
/** 官方列表一次少这么多就当成上游抖动，不执行下架 */
export const MAX_REMOVAL_RATIO = 0.25
export const MAX_REMOVAL_ABSOLUTE = 3
/** 单轮最多真的删几张：防止「连续小幅截断」的棘轮把曲库一点点删空 */
export const MAX_REMOVALS_PER_RUN = 10
/** 曲库 payload 结构版本，将来改字段时用来判断是否需要重建 */
export const CATALOG_SCHEMA_VERSION = 1

export const USER_AGENT = 'siren-records/1.0 (+https://siren.neolx.ltd)'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 官方 JSON 都是 KB 级；超过这个上限的响应一律当攻击/异常处理，避免被诱导读入超大 body */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

/** 限量读 body：content-length 预检 + 流式累计上限，替代裸 response.json() */
async function readLimitedJson(response, path) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    const error = new Error(`${path} 响应超过 ${MAX_RESPONSE_BYTES} 字节上限`)
    error.retryable = false
    throw error
  }
  const reader = response.body?.getReader?.()
  if (!reader) return response.json()
  const chunks = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > MAX_RESPONSE_BYTES) {
      const error = new Error(`${path} 响应超过 ${MAX_RESPONSE_BYTES} 字节上限`)
      error.retryable = false
      throw error
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(merged))
}

/**
 * 官方 JSON 接口：统一处理 {code:0,data} 信封、超时与重试。
 * 注意官方 404 也是 HTTP 200 + code 104，所以必须看 body.code 而不是 res.ok。
 *
 * 重试策略：只重试「可能自愈」的失败（网络错误 / 5xx / 429 / 408），
 * 404（code 104）与其它业务错误码直接抛出，避免每轮为一个不存在的 cid 白打三次。
 * 退避是指数 + 抖动；上游给了 Retry-After 就听它的（上限 30 秒）。
 */
export async function fetchOfficialJson(path, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = FETCH_TIMEOUT_MS,
    attempts = 3,
    retryDelayMs = 400,
  } = options
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(`${OFFICIAL}${path}`, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
        // 官方接口不该有重定向：被 3xx 导去别处时直接当失败，不跟进。
        // 注意 Workers 的 fetch 不支持 redirect:'error'（会直接抛 TypeError），
        // 边缘环境统一用 'manual' + 下面显式判定，Node 侧行为一致。
        redirect: 'manual',
      })
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        const error = new Error(`${path} 出现意外重定向（HTTP ${response.status}）`)
        error.retryable = false
        throw error
      }
      if (!response.ok) {
        const error = new Error(`${path} HTTP ${response.status}`)
        error.retryable =
          response.status === 408 || response.status === 429 || response.status >= 500
        if (response.status === 429 || response.status === 503) {
          const retryAfter = Number(response.headers.get('retry-after'))
          if (Number.isFinite(retryAfter) && retryAfter > 0) {
            error.retryAfterMs = Math.min(retryAfter * 1000, 30_000)
          }
        }
        throw error
      }
      // Content-Type 宽松校验：缺失时放行（兼容本仓库测试替身），声明了就必须是 JSON
      const contentType = String(response.headers.get('content-type') || '')
      if (contentType && !contentType.toLowerCase().includes('json')) {
        const error = new Error(`${path} 响应不是 JSON（Content-Type: ${contentType}）`)
        error.retryable = false
        throw error
      }
      const body = await readLimitedJson(response, path)
      if (body?.code === 104) {
        const error = new Error(`${path} 不存在（code 104）`)
        error.notFound = true
        throw error
      }
      if (!body || body.code !== 0) {
        const error = new Error(`${path} code ${body?.code ?? '?'}`)
        error.retryable = false
        throw error
      }
      return body.data
    } catch (error) {
      lastError = error
      if (error?.notFound || error?.retryable === false) throw error
      if (attempt < attempts) {
        const backoff = error?.retryAfterMs ?? Math.min(retryDelayMs * 2 ** (attempt - 1), 5_000)
        await sleep(backoff + Math.floor(Math.random() * Math.min(200, backoff || 1)))
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** 官方专辑列表：一次性返回全部专辑（无分页），顺序为「最新在前」 */
export async function fetchAlbumList(fetchImpl = globalThis.fetch, options = {}) {
  const data = await fetchOfficialJson('/api/albums', { fetchImpl, ...options })
  if (!Array.isArray(data)) throw new Error('官方专辑列表格式异常')
  return data
    .filter((item) => item && item.cid !== undefined && item.cid !== null)
    .map((item) => ({
      cid: String(item.cid),
      name: String(item.name || ''),
      coverUrl: String(item.coverUrl || ''),
      artistes: Array.isArray(item.artistes) ? item.artistes.map(String) : [],
    }))
}

/** 专辑详情：含 songs[]，但不含每首歌的直链 */
export async function fetchAlbumDetail(fetchImpl, cid, options = {}) {
  const data = await fetchOfficialJson(`/api/album/${cid}/detail`, { fetchImpl, ...options })
  if (!data || String(data.cid ?? '') !== String(cid)) throw new Error(`专辑 ${cid} 详情不匹配`)
  return data
}

/** 单曲直链：sourceUrl 带 3 小时签名，歌词与封面不带签名 */
export async function fetchSongInfo(fetchImpl, cid, options = {}) {
  const data = await fetchOfficialJson(`/api/song/${cid}`, { fetchImpl, ...options })
  return {
    sourceUrl: typeof data?.sourceUrl === 'string' ? data.sourceUrl : '',
    lyricUrl: typeof data?.lyricUrl === 'string' ? data.lyricUrl : '',
    artists: Array.isArray(data?.artists) ? data.artists.map(String) : [],
  }
}

/** 详情里的 artistes 是数组，快照里是 'A / B' 字符串，统一成后者 */
export function joinArtistes(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join(' / ')
  if (typeof value === 'string') return value
  return ''
}

/**
 * 把「专辑详情 + 上次的专辑对象 + 新抓到的歌曲直链」合成本站曲库里的专辑对象。
 * 关键点：官方详情不含 sourceUrl / lyricUrl，必须从上一版继承，
 * 否则每次复查都会把已有直链清空、曲库里的可播放标记全灭。
 */
export function buildAlbum(detail, previous = null, songInfo = new Map(), listEntry = null) {
  const cid = String(detail.cid)
  const coverUrl = detail.coverUrl || listEntry?.coverUrl || previous?.coverUrl || ''
  const previousSongs = new Map((previous?.songs || []).map((song) => [String(song.cid), song]))
  // 官方偶尔会返回空 songs（上游抖动）；这时沿用上一版，绝不能把整张专辑清空
  const detailSongs = Array.isArray(detail.songs) && detail.songs.length ? detail.songs : previous?.songs || []
  const songs = detailSongs.map((song) => {
    const songCid = String(song.cid)
    const prev = previousSongs.get(songCid)
    const info = songInfo.get(songCid)
    return {
      cid: songCid,
      name: String(song.name || prev?.name || ''),
      // 空数组也是 truthy：官方偶尔在单曲信息里回空 artists，不能让它把上一版继承来的名单抹掉
      artistes: joinArtistes(info?.artists?.length ? info.artists : song.artistes?.length ? song.artistes : prev?.artistes),
      albumCid: cid,
      albumName: String(detail.name || previous?.name || ''),
      albumCover: coverUrl,
      sourceUrl: info?.sourceUrl || prev?.sourceUrl || '',
      lyricUrl: info?.lyricUrl || prev?.lyricUrl || '',
    }
  })
  return {
    cid,
    name: String(detail.name || previous?.name || ''),
    intro: String(detail.intro || ''),
    belong: String(detail.belong || ''),
    coverUrl,
    coverDeUrl: String(detail.coverDeUrl || ''),
    artistes: Array.isArray(listEntry?.artistes) && listEntry.artistes.length
      ? listEntry.artistes.map(String)
      : Array.isArray(previous?.artistes)
        ? previous.artistes
        : [],
    songs,
  }
}

/**
 * 计算这一轮要做什么：新增、下架、滚动复查。
 * 官方列表如果突然变短（上游抖动/返回半截），不执行下架，避免一次抖动清空曲库。
 */
export function planSync({ officialList, knownAlbums, budgets = {} }) {
  const refreshBudget = budgets.refresh ?? REFRESH_BUDGET
  const maxRemovalRatio = budgets.maxRemovalRatio ?? MAX_REMOVAL_RATIO
  const maxRemovalAbsolute = budgets.maxRemovalAbsolute ?? MAX_REMOVAL_ABSOLUTE

  const officialCids = officialList.map((album) => String(album.cid))
  const officialSet = new Set(officialCids)
  const knownCids = knownAlbums.map((album) => String(album.cid))
  const knownSet = new Set(knownCids)

  const added = officialList.filter((album) => !knownSet.has(String(album.cid)))
  const missing = knownCids.filter((cid) => !officialSet.has(cid))
  const removalLimit = Math.max(
    maxRemovalAbsolute,
    Math.ceil(knownCids.length * maxRemovalRatio),
  )
  const suspicious =
    missing.length > removalLimit ||
    (knownCids.length > 0 && officialCids.length < knownCids.length * 0.75)
  const removed = suspicious ? [] : missing

  const addedSet = new Set(added.map((album) => String(album.cid)))
  const refresh = knownAlbums
    .filter((album) => officialSet.has(String(album.cid)) && !addedSet.has(String(album.cid)))
    .slice()
    .sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0))
    .slice(0, refreshBudget)

  return {
    officialCids,
    added,
    removed,
    refresh,
    missing,
    suspicious,
    removalLimit,
  }
}

/** 把一行行 payload 按 order 拼成完整曲库 JSON；payload 原样拼接，不做二次解析 */
export function buildCatalogBody({ generatedAt, source, version, syncedAt, lastCheckAt, albums, order }) {
  const byCid = new Map()
  for (const album of albums) byCid.set(String(album.cid), album.payload)
  const parts = []
  const used = new Set()
  for (const cid of order || []) {
    const payload = byCid.get(String(cid))
    if (payload === undefined || used.has(String(cid))) continue
    used.add(String(cid))
    parts.push(payload)
  }
  // 兜底：order 里没有的行也要输出，否则一次元数据损坏就会静默丢专辑
  for (const [cid, payload] of byCid) {
    if (used.has(cid)) continue
    used.add(cid)
    parts.push(payload)
  }
  return (
    `{"generatedAt":${JSON.stringify(generatedAt || '')}` +
    `,"source":${JSON.stringify(source || OFFICIAL)}` +
    `,"schema":${CATALOG_SCHEMA_VERSION}` +
    `,"version":${Number(version) || 0}` +
    `,"syncedAt":${JSON.stringify(syncedAt || '')}` +
    `,"lastCheckAt":${JSON.stringify(lastCheckAt || '')}` +
    `,"albums":[${parts.join(',')}]}`
  )
}

/** 曲库统计（专辑数 / 曲目数） */
export function catalogStats(albums) {
  let songs = 0
  for (const album of albums) songs += Array.isArray(album.songs) ? album.songs.length : 0
  return { albums: albums.length, songs }
}

/** 用静态快照把空库一次性铺满（快照里已含官方全部专辑与曲目） */
export async function seedFromBaseline(store, baseline, now = Date.now()) {
  const albums = Array.isArray(baseline?.albums) ? baseline.albums : []
  if (!albums.length) return 0
  const rows = albums
    // 形状校验：一行坏数据会拼出非法 JSON，让整个 /api/catalog 不可用，宁可少一张
    .filter((album) => album && album.cid !== undefined && album.cid !== null && Array.isArray(album.songs))
    .map((album) => ({
      cid: String(album.cid),
      payload: JSON.stringify(album),
      songCount: Array.isArray(album.songs) ? album.songs.length : 0,
      updatedAt: now,
    }))
  await store.putAlbums(rows)
  await store.setMeta({
    version: '1',
    schema: String(CATALOG_SCHEMA_VERSION),
    generatedAt: String(baseline.generatedAt || new Date(now).toISOString()),
    syncedAt: String(baseline.generatedAt || new Date(now).toISOString()),
    lastCheckAt: '0',
    order: JSON.stringify(rows.map((row) => row.cid)),
    albums: String(rows.length),
    songs: String(rows.reduce((total, row) => total + row.songCount, 0)),
    source: String(baseline.source || OFFICIAL),
    lastError: '',
    lastErrorAt: '',
  })
  return rows.length
}

function clip(value, max = 300) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function parseCidList(value) {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/**
 * 跑一轮同步。store 适配器需要提供：
 *   readSyncState()                  -> { meta: object, albums: [{cid, updatedAt}] }
 *   readMetaKeys(keys)               -> { key: value }（可选；只读少量 meta 行，缺省退回 readSyncState）
 *   getAlbumPayload(cid)             -> string | null
 *   putAlbums(rows)                  -> rows: [{cid, payload, songCount, updatedAt}]
 *   deleteAlbums(cids)
 *   setMeta(patch)
 *   stats()                          -> { albums, songs }
 *   acquireLease(now, ttlMs, token)  -> boolean
 *   renewLease(token, now, ttlMs)    -> boolean（可选；缺省视为续租成功）
 *   releaseLease(token)
 */
export async function syncCatalog({
  store,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  reason = 'manual',
  budgets = {},
  http = {},
  minGapMs = MIN_SYNC_GAP_MS,
  bootstrap = null,
}) {
  const budget = {
    detail: budgets.detail ?? DETAIL_BUDGET,
    song: budgets.song ?? SONG_BUDGET,
    refresh: budgets.refresh ?? REFRESH_BUDGET,
  }
  const httpOptions = {
    attempts: http.attempts ?? 3,
    retryDelayMs: http.retryDelayMs ?? 400,
  }
  const startedAt = Date.now()
  const leaseToken = `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`

  // 0) 最便宜的一眼：只读两行 meta 判断「是不是刚查过」，不扫专辑表也不写任何东西。
  //    放在抢租约之前，被拦下的请求只付 2 行读，不能变成打库/打官方接口的放大器。
  const peekMeta =
    typeof store.readMetaKeys === 'function'
      ? await store.readMetaKeys(['lastCheckAt', 'version']).catch(() => null)
      : null
  if (peekMeta) {
    const lastCheck = Date.parse(peekMeta.lastCheckAt || '')
    if (reason !== 'cli' && Number.isFinite(lastCheck) && now - lastCheck < minGapMs) {
      return {
        ok: true,
        skipped: 'fresh',
        changed: false,
        reason,
        version: Number(peekMeta.version || 0),
        durationMs: Date.now() - startedAt,
      }
    }
  }

  const acquired = await store.acquireLease(now, LEASE_MS, leaseToken)
  if (!acquired) return { ok: true, skipped: 'busy', changed: false, reason }

  let meta = {}
  let version = 0
  let warnings = []
  let leaseLost = false
  let lastRenewAt = Date.now()

  /** 长轮次续租：续不上说明别的实例已经接手，立刻停手，避免两轮互相覆盖 */
  async function keepLease() {
    if (typeof store.renewLease !== 'function') return
    if (Date.now() - lastRenewAt < 30_000) return
    const alive = await store.renewLease(leaseToken, Date.now(), LEASE_MS)
    if (!alive) {
      leaseLost = true
      throw new Error('同步租约已被其他实例接管，本轮中止')
    }
    lastRenewAt = Date.now()
  }

  try {
    let state = await store.readSyncState()
    // 空库时先用静态快照铺底：官方全量详情要 300+ 次请求，不可能在一轮里抓完，
    // 不铺底的话首次上线会有几个小时只能看到十几张专辑。
    if (!state.albums?.length && typeof bootstrap === 'function') {
      const seeded = await bootstrap()
      // 铺底失败必须整轮失败：否则会拿「只有十几张」的残缺曲库顶替快照对外服务
      if (!seeded) throw new Error('曲库为空且静态快照铺底失败')
      state = await store.readSyncState()
    }
    meta = state.meta || {}
    version = Number(meta.version || 0)
    if (!peekMeta) {
      // 适配器没提供 readMetaKeys 时退回这里判断（逻辑一致，只是多读一次状态）
      const lastCheck = Date.parse(meta.lastCheckAt || '')
      if (reason !== 'cli' && Number.isFinite(lastCheck) && now - lastCheck < minGapMs) {
        return { ok: true, skipped: 'fresh', changed: false, reason, version, durationMs: Date.now() - startedAt }
      }
    }

    // 先把「已检查」落下来：即使这轮被超时取消，下一次触发也不会立刻重打一遍
    await store.setMeta({ lastCheckAt: new Date(now).toISOString() })

    const known = Array.isArray(state.albums) ? state.albums : []
    const list = await fetchAlbumList(fetchImpl, httpOptions)
    if (!list.length) throw new Error('官方专辑列表为空')

    const plan = planSync({ officialList: list, knownAlbums: known, budgets: budget })
    if (plan.suspicious) {
      warnings.push(
        `官方列表疑似抖动（本地 ${known.length} 张 / 官方 ${plan.officialCids.length} 张 / 缺失 ${plan.missing.length} 张），本轮不执行下架`,
      )
    }

    let contentChanged = false
    let addedSongs = 0
    let refreshedChanged = 0
    let refreshedOk = 0
    let songBudget = budget.song
    const listByCid = new Map(list.map((entry) => [entry.cid, entry]))

    // 单曲直链按需补：只补「新歌」与「上次没抓到直链的歌」，老歌沿用旧值
    async function fillSongInfo(album, previous) {
      const prevSongs = new Set((previous?.songs || []).map((song) => String(song.cid)))
      const needed = album.songs
        .filter((song) => !prevSongs.has(song.cid) || !song.sourceUrl)
        .map((song) => song.cid)
        .slice(0, Math.max(0, songBudget))
      songBudget -= needed.length
      const info = new Map()
      let failed = 0
      for (const cid of needed) {
        // 长轮次逐首续租：续租失败从这里直接向上抛（不进单曲 try），上层凭 leaseLost 中止整轮，
        // 否则被接管的这轮还会继续往库里写，与接管方互相覆盖
        await keepLease()
        try {
          info.set(cid, await fetchSongInfo(fetchImpl, cid, httpOptions))
        } catch {
          // 单曲失败不阻塞整轮：下一轮复查时还会再试
          failed += 1
        }
      }
      if (failed) warnings.push(`专辑 ${album.cid} 有 ${failed}/${needed.length} 首歌信息抓取失败`)
      return info
    }

    // 1) 新专辑：优先补详情，单轮有上限，剩下的留给下一轮
    const freshTargets = plan.added.slice(0, budget.detail)
    let freshAdded = 0
    for (const entry of freshTargets) {
      await keepLease()
      try {
        const detail = await fetchAlbumDetail(fetchImpl, entry.cid, httpOptions)
        const draft = buildAlbum(detail, null, new Map(), entry)
        const info = await fillSongInfo(draft, null)
        const album = buildAlbum(detail, null, info, entry)
        // 逐张落库：一轮被超时打断时，已抓到的专辑不会白丢
        await store.putAlbums([
          { cid: album.cid, payload: JSON.stringify(album), songCount: album.songs.length, updatedAt: now },
        ])
        addedSongs += album.songs.length
        freshAdded += 1
        contentChanged = true
      } catch (error) {
        if (leaseLost) throw error
        // 单张专辑失败不拖垮整轮：下一轮「新增」还会包含它
        warnings.push(`新专辑 ${entry.cid} 抓取失败：${error?.message || error}`)
      }
    }

    // 2) 滚动复查：官方确实会往老专辑里追加曲目（历史上 936 首里 96 首晚于封面日期）
    for (const entry of plan.refresh) {
      await keepLease()
      const cid = String(entry.cid)
      let previous = null
      const prevPayload = await store.getAlbumPayload(cid)
      if (prevPayload) {
        try {
          previous = JSON.parse(prevPayload)
        } catch {
          previous = null
        }
      }
      try {
        const detail = await fetchAlbumDetail(fetchImpl, cid, httpOptions)
        const draft = buildAlbum(detail, previous, new Map(), listByCid.get(cid))
        const info = await fillSongInfo(draft, previous)
        const album = buildAlbum(detail, previous, info, listByCid.get(cid))
        const payload = JSON.stringify(album)
        const changed = payload !== prevPayload
        if (changed) {
          refreshedChanged += 1
          contentChanged = true
          const before = new Set((previous?.songs || []).map((song) => String(song.cid)))
          const gained = album.songs.filter((song) => !before.has(song.cid)).length
          addedSongs += gained
        }
        // 即使内容没变也要写回 updatedAt：否则复查游标永远停在同一张老专辑上
        await store.putAlbums([{ cid, payload, songCount: album.songs.length, updatedAt: now }])
        refreshedOk += 1
      } catch (error) {
        if (leaseLost) throw error
        warnings.push(`复查专辑 ${cid} 失败：${error?.message || error}`)
        // 复查失败也要推进游标，否则一张坏专辑会永久占住复查名额
        if (prevPayload) {
          await store.putAlbums([{ cid, payload: prevPayload, songCount: previous?.songs?.length || 0, updatedAt: now }])
        }
      }
    }

    // 3) 下架：连续两轮确认同一批缺失才真删，且单轮有上限。
    //    官方几乎不删专辑，这里宁可慢一轮，也不能让一次上游截断把曲库删空。
    const pendingBefore = parseCidList(meta.pendingRemoval)
    let toDelete = []
    let pendingNext = []
    if (plan.removed.length) {
      const pendingSet = new Set(pendingBefore)
      const sameSet =
        pendingBefore.length === plan.removed.length && plan.removed.every((cid) => pendingSet.has(cid))
      if (sameSet && plan.removed.length <= MAX_REMOVALS_PER_RUN) {
        toDelete = plan.removed
      } else {
        pendingNext = plan.removed
        warnings.push(
          plan.removed.length > MAX_REMOVALS_PER_RUN
            ? `拟下架 ${plan.removed.length} 张，超过单轮上限 ${MAX_REMOVALS_PER_RUN}，转为待确认`
            : `拟下架 ${plan.removed.length} 张，需下一轮再次确认后才执行`,
        )
      }
    }
    if (toDelete.length) {
      await store.deleteAlbums(toDelete)
      contentChanged = true
    }

    const orderJson = JSON.stringify(plan.officialCids)
    if ((meta.order || '') !== orderJson) contentChanged = true
    const nextVersion = contentChanged ? version + 1 : version
    const stats = await store.stats()
    const iso = new Date(now).toISOString()
    const warningText = clip(warnings.join('；'))
    await keepLease()
    await store.setMeta({
      version: String(nextVersion),
      schema: String(CATALOG_SCHEMA_VERSION),
      generatedAt: contentChanged ? iso : String(meta.generatedAt || iso),
      syncedAt: iso,
      lastCheckAt: iso,
      order: orderJson,
      albums: String(stats.albums),
      songs: String(stats.songs),
      source: OFFICIAL,
      lastError: '',
      lastErrorAt: '',
      lastWarning: warningText,
      lastWarningAt: warningText ? iso : '',
      pendingRemoval: JSON.stringify(pendingNext),
      lastRemoved: String(toDelete.length),
      lastRemovedAt: toDelete.length ? iso : '',
      lastReason: reason,
    })

    return {
      ok: true,
      changed: contentChanged,
      partial: warnings.length > 0,
      reason,
      version: nextVersion,
      added: freshAdded,
      addedPending: Math.max(0, plan.added.length - freshAdded),
      failed: warnings.length,
      removed: toDelete.length,
      removedPending: pendingNext.length,
      refreshed: refreshedOk,
      refreshedChanged,
      addedSongs,
      albums: stats.albums,
      songs: stats.songs,
      durationMs: Date.now() - startedAt,
      warnings,
    }
  } catch (error) {
    const message = clip(error instanceof Error ? error.message : error)
    if (leaseLost) {
      // 不是错误：别的实例接手了，本轮已经落库的部分照常生效，剩下的它会做完
      return { ok: true, skipped: 'lease-lost', changed: false, reason, version, durationMs: Date.now() - startedAt, warnings }
    }
    const iso = new Date(now).toISOString()
    try {
      await store.setMeta({
        lastError: message,
        lastErrorAt: iso,
        lastCheckAt: iso,
        lastReason: reason,
      })
    } catch {
      // 连错误都写不进去时只能放弃：保持上一次成功的曲库继续服务
    }
    return {
      ok: false,
      changed: false,
      reason,
      error: message,
      version,
      durationMs: Date.now() - startedAt,
      warnings,
    }
  } finally {
    try {
      await store.releaseLease(leaseToken)
    } catch {
      // 租约到期会自动失效，忽略
    }
  }
}

/** 从一组 meta 行里取布尔/数字，避免各端重复写解析逻辑 */
export function metaNumber(meta, key, fallback = 0) {
  const value = Number(meta?.[key])
  return Number.isFinite(value) ? value : fallback
}

/**
 * 判断 If-None-Match 是否命中。按 RFC 9110 用弱比较、支持逗号列表与 `*`，
 * 否则反向代理把 ETag 弱化成 W/"x"、或客户端发多值列表时，304 永远不会命中。
 */
export function matchesEtag(ifNoneMatch, etag) {
  const target = String(etag || '').trim()
  if (!ifNoneMatch || !target) return false
  for (const raw of String(ifNoneMatch).split(',')) {
    const value = raw.trim()
    if (!value) continue
    if (value === '*') return true
    if (value === target) return true
    if (value.replace(/^W\//i, '') === target.replace(/^W\//i, '')) return true
  }
  return false
}

export function isStale(meta, now = Date.now(), staleAfterMs = STALE_AFTER_MS) {
  const syncedAt = Date.parse(meta?.syncedAt || '')
  if (!Number.isFinite(syncedAt)) return true
  return now - syncedAt > staleAfterMs
}
