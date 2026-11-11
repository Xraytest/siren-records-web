import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { describeDiff, diffSummary, type CatalogDiff } from './catalog-diff'
import {
  catalogModeFromHeader,
  decideUpdate,
  metaFromCatalog,
  noteForSyncResponse,
  type CatalogMeta,
} from './catalog-meta'
import { isInstrumental, readSettings, useSettings } from './settings'
import { toast } from './toast'
import type { Album, Catalog, Song } from './types'

/**
 * 曲库状态 = 后端 /api/catalog（运行时同步 D1/SQLite）+ 静态快照兜底。
 *
 * 为什么不再是一份构建期 JSON：曲库要「和官方保持最新」，而快照只在构建时生成，
 * 新专辑上架后必须重新部署才看得到。现在前端订阅一个可变更的 store，
 * 每 5 分钟问一次 /api/catalog/meta（几百字节），版本号变了才拉全量曲库。
 * 后端不可用（例如纯静态托管）时自动退回 data/catalog.json，播放不受影响。
 */

export type { CatalogMeta } from './catalog-meta'

export type Built = { catalog: Catalog; albums: Map<string, Album>; songs: Map<string, Song>; all: Song[] }
export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error'

interface CatalogSnapshot {
  built: Built | null
  meta: CatalogMeta | null
  status: CatalogStatus
  error: string | null
  refreshing: boolean
}

const LIVE_TIMEOUT_MS = 12_000
const META_TIMEOUT_MS = 8_000
const MANUAL_TIMEOUT_MS = 30_000
const POLL_MS = 5 * 60_000
const MIN_CHECK_GAP_MS = 20_000

let snapshot: CatalogSnapshot = { built: null, meta: null, status: 'idle', error: null, refreshing: false }
const listeners = new Set<() => void>()
let loading: Promise<Built> | null = null
let refreshing: Promise<RefreshResult> | null = null
let watcherStarted = false
let lastCheckAt = 0

function getSnapshot(): CatalogSnapshot {
  return snapshot
}

function publish(patch: Partial<CatalogSnapshot>) {
  snapshot = { ...snapshot, ...patch }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  startWatcher()
  return () => {
    listeners.delete(listener)
  }
}

function build(catalog: Catalog): Built {
  const albums = new Map<string, Album>()
  const songs = new Map<string, Song>()
  const all: Song[] = []
  for (const album of catalog.albums) {
    albums.set(album.cid, album)
    for (const ref of album.songs) {
      const song: Song = {
        cid: ref.cid,
        name: ref.name,
        artistes: ref.artistes,
        albumCid: album.cid,
        albumName: album.name,
        albumCover: album.coverUrl,
        sourceUrl: ref.sourceUrl || '',
        lyricUrl: ref.lyricUrl || '',
      }
      songs.set(ref.cid, song)
      all.push(song)
    }
  }
  return { catalog, albums, songs, all }
}

/** 屏蔽伴奏时，从档案视图里剔除相关曲目 */
function withoutInstrumental(base: Built): Built {
  const songs = new Map([...base.songs].filter(([, song]) => !isInstrumental(song.name)))
  const albums = new Map(
    [...base.albums].map(([cid, album]) => [
      cid,
      { ...album, songs: album.songs.filter((ref) => !isInstrumental(ref.name)) },
    ]),
  )
  return {
    catalog: { ...base.catalog, albums: [...albums.values()] },
    albums,
    songs,
    all: base.all.filter((song) => !isInstrumental(song.name)),
  }
}

function shape(built: Built) {
  return { albums: built.catalog.albums, songs: built.all.length }
}

async function fetchJson<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`${url} 返回 ${response.status}`)
  return (await response.json()) as T
}

function normalizeCatalog(data: unknown): Catalog | null {
  if (!data || typeof data !== 'object') return null
  const catalog = data as Catalog
  if (!Array.isArray(catalog.albums) || catalog.albums.length === 0) return null
  return catalog
}

async function fetchLive(): Promise<{ catalog: Catalog; meta: CatalogMeta }> {
  const response = await fetch('/api/catalog', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`/api/catalog 返回 ${response.status}`)
  const catalog = normalizeCatalog(await response.json())
  if (!catalog) throw new Error('曲库接口数据异常')
  // 后端在「还没铺底 / D1 不可用」时会把静态快照当曲库返回，并用响应头说明真实模式。
  // 不看头的话前端永远以为自己在 live 模式，快照模式下每 5 分钟都会白拉一次全量。
  const mode = catalogModeFromHeader(response.headers.get('x-catalog-mode'))
  const meta = metaFromCatalog(catalog, mode, response.headers.get('x-catalog-synced-at'))
  return { catalog, meta }
}

async function fetchSnapshot(): Promise<{ catalog: Catalog; meta: CatalogMeta }> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/catalog.json`, { cache: 'no-cache' })
  if (!response.ok) throw new Error(`曲库载入失败 (${response.status})`)
  const catalog = normalizeCatalog(await response.json())
  if (!catalog) throw new Error('曲库快照数据异常')
  return { catalog, meta: metaFromCatalog(catalog, 'snapshot') }
}

function announce(previous: Built | null, next: Built) {
  if (!previous) return
  const text = describeDiff(diffSummary(shape(previous), shape(next)))
  if (text) toast(text, 'ok')
}

/**
 * 载入曲库。默认只载入一次；force=true 强制重拉（版本变化或手动同步）。
 * 失败时保留已有数据：宁可显示上一版，也不要把界面清空。
 */
export function loadCatalog(force = false, options: { announce?: boolean } = {}): Promise<Built> {
  if (snapshot.built && !force) return Promise.resolve(snapshot.built)
  if (loading) return loading
  if (!snapshot.built) publish({ status: 'loading' })

  loading = (async () => {
    try {
      const { catalog, meta } = await fetchLive()
      const built = build(catalog)
      const previous = snapshot.built
      publish({ built, meta, status: 'ready', error: null })
      if (options.announce !== false) announce(previous, built)
      return built
    } catch (liveError) {
      if (snapshot.built) {
        publish({ error: String(liveError), status: 'ready' })
        return snapshot.built
      }
      const { catalog, meta } = await fetchSnapshot()
      const built = build(catalog)
      publish({ built, meta, status: 'ready', error: String(liveError) })
      return built
    } finally {
      loading = null
      lastCheckAt = Date.now()
    }
  })()

  loading.catch((error) => {
    publish({ status: 'error', error: error instanceof Error ? error.message : String(error) })
  })
  return loading
}

/** 只拉几百字节的元信息，版本变了才去拉全量曲库 */
async function checkForUpdate(reason: 'poll' | 'focus' | 'online' | 'manual') {
  if (reason !== 'manual' && !readSettings().autoSyncCatalog) return
  if (typeof document !== 'undefined' && document.hidden) return
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return
  const now = Date.now()
  if (now - lastCheckAt < MIN_CHECK_GAP_MS) return
  lastCheckAt = now

  // 上次载入失败（例如页面比后端先起来）时也要借这次检查重试，否则只能等用户手动刷新
  if (!snapshot.built) {
    await loadCatalog().catch(() => {
      /* 仍然失败就继续等下一次检查 */
    })
    return
  }

  try {
    const payload = await fetchJson<unknown>('/api/catalog/meta', { cache: 'no-store' }, META_TIMEOUT_MS)
    // 快照模式说明后端没有可用数据库，曲库不会在运行期变化：只更新元信息，
    // 不能因为「快照里的 version 与 meta 接口的 0 不相等」就每 5 分钟重拉一次 484 KB。
    const decision = decideUpdate(snapshot.meta, payload)
    if (decision.action === 'ignore') return
    if (decision.action === 'reload') {
      await loadCatalog(true)
      return
    }
    publish({ meta: { ...(snapshot.meta as CatalogMeta), ...decision.meta } })
  } catch {
    // 后端不可用（纯静态托管 / 离线）：静默保留当前曲库
  }
}

function startWatcher() {
  if (watcherStarted || typeof window === 'undefined') return
  watcherStarted = true
  window.setInterval(() => {
    if (!document.hidden) void checkForUpdate('poll')
  }, POLL_MS)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void checkForUpdate('focus')
  })
  window.addEventListener('online', () => void checkForUpdate('online'))
}

export interface RefreshResult {
  ok: boolean
  diff: CatalogDiff
  error?: string
  /** 后端同步接口的说明（限流、部分失败、无同步接口等），用于给出准确提示 */
  note?: string
}

/**
 * 手动同步：先让后端去官方拉一次，再重拉曲库；后端不支持时退化为重拉。
 * 同一时刻只跑一份：页脚和设置页的按钮共享同一个 Promise 与 refreshing 状态。
 */
export function refreshCatalog(): Promise<RefreshResult> {
  if (refreshing) return refreshing
  const before = snapshot.built
  publish({ refreshing: true })
  refreshing = (async (): Promise<RefreshResult> => {
    let note = ''
    try {
      const response = await fetch('/api/catalog/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(MANUAL_TIMEOUT_MS),
      })
      // 429 时不读正文（后端只回了限流说明，没必要再解析一次）
      const payload = response.status === 429 ? null : await response.json().catch(() => null)
      note = noteForSyncResponse(response.status, payload)
    } catch {
      // 后端没有同步接口（纯静态托管）或超时：下面照常重拉，能拿到多少算多少
    }
    try {
      await loadCatalog(true, { announce: false })
    } catch (error) {
      return {
        ok: false,
        diff: diffSummary(before ? shape(before) : null, { albums: [], songs: 0 }),
        error: error instanceof Error ? error.message : String(error),
        note,
      }
    }
    const after = snapshot.built
    if (!after) return { ok: false, diff: { added: 0, removed: 0, songsAdded: 0, songsRemoved: 0 }, error: '曲库不可用', note }
    return { ok: true, diff: diffSummary(before ? shape(before) : null, shape(after)), note }
  })().finally(() => {
    refreshing = null
    publish({ refreshing: false })
  })
  return refreshing
}

export function useCatalog(): Built | null {
  const { hideInstrumental } = useSettings()
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useEffect(() => {
    void loadCatalog().catch(() => {
      /* 失败时 store 里已是 error 状态，界面按空曲库降级 */
    })
  }, [])
  return useMemo(
    () => (state.built && hideInstrumental ? withoutInstrumental(state.built) : state.built),
    [state.built, hideInstrumental],
  )
}

/** 曲库同步状态 + 手动同步动作，供页脚 / 设置页使用 */
export function useCatalogSync() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const refresh = useCallback(async () => {
    const result = await refreshCatalog()
    if (!result.ok) {
      toast(result.error || '同步失败，已保留本地曲库', 'warn')
      return
    }
    const text = describeDiff(result.diff)
    if (text) {
      toast(text, 'ok')
      return
    }
    // 没有差异时也要如实说明：限流 / 部分失败不能说成「已是最新」
    if (result.note) {
      toast(result.note, 'info')
      return
    }
    toast('曲库已是最新', 'info')
  }, [])
  return {
    meta: state.meta,
    status: state.status,
    error: state.error,
    refreshing: state.refreshing,
    refresh,
  }
}

/** 曲库版本号：需要随曲库更新而重算的 useMemo/useEffect 把它放进依赖 */
export function useCatalogVersion(): number {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return state.meta?.version ?? 0
}

export function getSong(cid: string) {
  return snapshot.built?.songs.get(cid) ?? null
}

export function getAlbum(cid: string) {
  return snapshot.built?.albums.get(cid) ?? null
}

export async function ensureSong(cid: string) {
  const catalog = await loadCatalog()
  return catalog.songs.get(cid) ?? null
}

export function searchAll(keyword: string, hideInstrumental = false, source: Built | null = snapshot.built) {
  const built = source
  if (!built) return { songs: [] as Song[], albums: [] as Album[] }
  const q = keyword.trim().toLowerCase()
  if (!q) return { songs: [], albums: [] }
  const songs = built.all
    .filter((s) => !hideInstrumental || !isInstrumental(s.name))
    .filter((s) => s.name.toLowerCase().includes(q) || s.artistes.toLowerCase().includes(q) || s.albumName.toLowerCase().includes(q))
    .slice(0, 24)
  const albums = built.catalog.albums
    .filter((a) => a.name.toLowerCase().includes(q) || a.artistes.join(' ').toLowerCase().includes(q))
    .slice(0, 8)
  return { songs, albums }
}
