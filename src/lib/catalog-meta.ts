/**
 * 曲库元信息的纯逻辑 —— 不碰 fetch / React / import.meta，可直接被 node --test 导入。
 *
 * 这些判断以前埋在 catalog.ts 里，和网络、订阅、模块级状态搅在一起，只能靠手点页面验证。
 * 抽出来以后，「快照模式不能每 5 分钟重拉全量」「版本号只增不减」「限流不能说成已是最新」
 * 这几条规则都能被测试钉住。
 */

import { normalizeVersion } from './catalog-diff.ts'

export { normalizeVersion }

export interface CatalogMeta {
  version: number
  generatedAt: string
  syncedAt: string
  lastCheckAt: string
  albums: number
  songs: number
  mode: 'live' | 'snapshot'
  stale: boolean
  source: string
  lastError: string
  lastWarning?: string
  lastWarningAt?: string
  pendingRemoval?: number
  lastRemoved?: number
  lastReason?: string
}

/** metaFromCatalog 只需要这几项，用结构化类型避免把 ./types 拖进来 */
export interface CatalogLike {
  version?: unknown
  generatedAt?: string
  syncedAt?: string
  lastCheckAt?: string
  source?: string
  albums: ReadonlyArray<{ songs?: ReadonlyArray<unknown> | null }>
}

export type CatalogMode = 'live' | 'snapshot'

/** 后端在「还没铺底 / D1 不可用」时会把静态快照当曲库返回，靠响应头说明真实模式 */
export function catalogModeFromHeader(value: string | null | undefined): CatalogMode {
  return String(value || '').toLowerCase() === 'snapshot' ? 'snapshot' : 'live'
}

/**
 * 由曲库正文推出元信息。
 * syncedAt / lastCheckAt 逐级回退，保证界面上不会出现空时间；
 * 只有真正走了静态快照才算 stale（live 但过期是后端的 stale 字段说了算）。
 */
export function metaFromCatalog(catalog: CatalogLike, mode: CatalogMode, syncedAtHeader?: string | null): CatalogMeta {
  const songs = catalog.albums.reduce((total, album) => total + (album.songs?.length || 0), 0)
  const meta: CatalogMeta = {
    version: normalizeVersion(catalog.version),
    generatedAt: catalog.generatedAt || '',
    syncedAt: catalog.syncedAt || catalog.generatedAt || '',
    lastCheckAt: catalog.lastCheckAt || catalog.syncedAt || catalog.generatedAt || '',
    albums: catalog.albums.length,
    songs,
    mode,
    stale: mode === 'snapshot',
    source: catalog.source || '',
    lastError: '',
  }
  // 响应头里的时间比正文新（正文是缓存的快照体，头是本次同步时间）
  const headerSyncedAt = String(syncedAtHeader || '').trim()
  if (headerSyncedAt) meta.syncedAt = headerSyncedAt
  return meta
}

/** /api/catalog/meta 的正文规范化：字段缺省就填默认值，不让 undefined 漏进界面 */
export function normalizeMeta(raw: unknown): CatalogMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  const count = (value: unknown) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
  }
  return {
    version: normalizeVersion(data.version),
    generatedAt: text(data.generatedAt),
    syncedAt: text(data.syncedAt),
    lastCheckAt: text(data.lastCheckAt),
    albums: count(data.albums),
    songs: count(data.songs),
    mode: data.mode === 'snapshot' ? 'snapshot' : 'live',
    stale: Boolean(data.stale),
    source: text(data.source),
    lastError: text(data.lastError),
    ...(typeof data.lastWarning === 'string' ? { lastWarning: data.lastWarning } : {}),
    ...(typeof data.lastWarningAt === 'string' ? { lastWarningAt: data.lastWarningAt } : {}),
    ...(typeof data.pendingRemoval === 'number' ? { pendingRemoval: data.pendingRemoval } : {}),
    ...(typeof data.lastRemoved === 'number' ? { lastRemoved: data.lastRemoved } : {}),
    ...(typeof data.lastReason === 'string' ? { lastReason: data.lastReason } : {}),
  }
}

export type UpdateDecision = { action: 'ignore' } | { action: 'reload' } | { action: 'meta'; meta: CatalogMeta }

/**
 * 轮询 /api/catalog/meta 之后要不要重拉全量曲库。
 *
 * 关键约束：快照模式说明后端没有可用数据库，曲库不会在运行期变化 ——
 * 这时绝不能因为「快照里的 version 与 meta 接口的 0 不相等」每 5 分钟重拉一次 484 KB。
 * 只有模式切换（live ⇄ snapshot）或 live 模式下版本号真的变了才重拉。
 */
export function decideUpdate(previous: { version: number; mode: CatalogMode } | null, raw: unknown): UpdateDecision {
  const meta = normalizeMeta(raw)
  if (!meta) return { action: 'ignore' }
  const previousMode: CatalogMode = previous?.mode ?? 'live'
  const previousVersion = previous ? normalizeVersion(previous.version) : -1
  if (meta.mode !== previousMode) return { action: 'reload' }
  if (meta.mode === 'live' && meta.version !== previousVersion) return { action: 'reload' }
  return { action: 'meta', meta }
}

/**
 * 手动同步接口的说明文案。返回空串表示「没什么要额外说的」，由调用方决定提示什么。
 * 限流 / 后端失败 / 部分专辑失败都必须说出来，不能落进「曲库已是最新」。
 */
export function noteForSyncResponse(status: number, payload: unknown): string {
  if (status === 429) return '官方接口刚查过，请稍后再试'
  const body = payload && typeof payload === 'object' ? (payload as { ok?: boolean; error?: string; warnings?: unknown }) : null
  if (status < 200 || status >= 300) return String(body?.error || `同步接口返回 ${status}`)
  if (body?.ok === false) return String(body.error || '后端同步失败')
  const warnings = Array.isArray(body?.warnings) ? body.warnings : []
  if (warnings.length) return `部分专辑暂未更新（${warnings.length} 条）`
  return ''
}
