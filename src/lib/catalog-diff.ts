/**
 * 曲库版本差异 —— 纯函数，供前端提示与单元测试共用。
 * 只比较专辑 cid 集合与曲目总数，不读 payload，成本与曲库大小无关。
 */

export interface CatalogShape {
  albums: ReadonlyArray<{ cid: string }>
  songs: number
}

export interface CatalogDiff {
  added: number
  removed: number
  songsAdded: number
  songsRemoved: number
}

export function diffSummary(previous: CatalogShape | null, next: CatalogShape): CatalogDiff {
  if (!previous) {
    return { added: next.albums.length, removed: 0, songsAdded: next.songs, songsRemoved: 0 }
  }
  const before = new Set(previous.albums.map((album) => album.cid))
  const after = new Set(next.albums.map((album) => album.cid))
  let added = 0
  let removed = 0
  for (const cid of after) if (!before.has(cid)) added += 1
  for (const cid of before) if (!after.has(cid)) removed += 1
  return {
    added,
    removed,
    songsAdded: Math.max(0, next.songs - previous.songs),
    songsRemoved: Math.max(0, previous.songs - next.songs),
  }
}

/** 给用户看的一句话；无变化时返回 null，调用方据此决定要不要弹提示 */
export function describeDiff(diff: CatalogDiff): string | null {
  if (!diff.added && !diff.removed && !diff.songsAdded && !diff.songsRemoved) return null
  const parts: string[] = []
  if (diff.added) parts.push(`新增 ${diff.added} 张专辑`)
  if (diff.removed) parts.push(`下架 ${diff.removed} 张专辑`)
  if (diff.songsAdded) parts.push(`+${diff.songsAdded} 首`)
  if (diff.songsRemoved) parts.push(`-${diff.songsRemoved} 首`)
  return `曲库已同步 · ${parts.join(' · ')}`
}

/** 版本号只增不减；缺失/非法时视为 0，避免 NaN 让比较永远为真 */
export function normalizeVersion(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}
