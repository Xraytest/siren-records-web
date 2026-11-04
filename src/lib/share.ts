import LZString from 'lz-string'
import type { Playlist, SharePayload, Song } from './types'

export function encodeShare(payload: SharePayload): string {
  return LZString.compressToEncodedURIComponent(JSON.stringify(payload))
}

// 分享码是外部输入：LZString 的展开比很高，几 KB 的码可以解出上百 MB，
// 因此解码前先按码长与解压后长度双重限流，避免一个链接就把标签页撑爆。
const CODE_MAX = 20_000
const SHARE_JSON_MAX = 4_000_000
const SHARE_SONGS_MAX = 2_000

export function decodeShare(code: string): SharePayload | null {
  try {
    if (typeof code !== 'string' || code.length > CODE_MAX) return null
    const json = LZString.decompressFromEncodedURIComponent(code)
    if (!json || json.length > SHARE_JSON_MAX) return null
    const data = JSON.parse(json) as SharePayload
    if (data?.t !== 'siren-playlist' || !Array.isArray(data.songs)) return null
    return {
      ...data,
      name: typeof data.name === 'string' ? data.name.slice(0, 80) : '未命名歌单',
      desc: typeof data.desc === 'string' ? data.desc.slice(0, 400) : '',
      author: typeof data.author === 'string' ? data.author.slice(0, 40) : '匿名',
      tags: Array.isArray(data.tags) ? data.tags.filter((t) => typeof t === 'string').slice(0, 6) : [],
      cover: typeof data.cover === 'string' ? data.cover : null,
      songs: data.songs.filter((c): c is string => typeof c === 'string').slice(0, SHARE_SONGS_MAX),
    }
  } catch {
    return null
  }
}

export function payloadOf(playlist: Playlist, author: string): SharePayload {
  return {
    v: 1,
    t: 'siren-playlist',
    name: playlist.name,
    desc: playlist.description,
    author,
    tags: playlist.tags,
    cover: playlist.coverSongCid,
    songs: playlist.songs,
    at: playlist.createdAt,
  }
}

export function shareUrl(code: string): string {
  const base = `${location.origin}${location.pathname}`
  return `${base}#/share/${code}`
}

/** 从任意文本中提取分享码：支持完整链接、hash 或裸码 */
export function extractCode(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  const fromUrl = text.match(/#\/share\/([^?\s]+)/)
  if (fromUrl) return fromUrl[1]
  if (/^[A-Za-z0-9+\-$.%]+$/.test(text) && text.length > 12) return text
  return null
}

export interface PortablePlaylist {
  format: 'siren-playlist-pack'
  version: 1
  exportedAt: string
  playlists: {
    name: string
    description: string
    tags: string[]
    cover: string | null
    createdAt: number
    publishedAt: number | null
    songs: Song[]
  }[]
}

/** 导出单张歌单，附带完整曲目信息，换设备也能导入 */
export function exportPlaylists(playlists: Playlist[], songsOf: (cid: string) => Song | null): PortablePlaylist {
  return {
    format: 'siren-playlist-pack',
    version: 1,
    exportedAt: new Date().toISOString(),
    playlists: playlists.map((p) => ({
      name: p.name,
      description: p.description,
      tags: p.tags,
      cover: p.coverSongCid,
      createdAt: p.createdAt,
      publishedAt: p.publishedAt,
      songs: p.songs.map((cid) => songsOf(cid)).filter((s): s is Song => Boolean(s)),
    })),
  }
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

const IMPORT_MAX = 8_000_000
const IMPORT_MAX_PLAYLISTS = 50
const IMPORT_MAX_SONGS = 2_000

export interface ImportedPlaylist {
  name: string
  description: string
  tags: string[]
  cover: string | null
  songs: string[]
}

/** 解析导入文件：兼容本应用导出的曲库包（{playlists:[...]}）与外部 {name, songs:[cid]} 结构 */
export function parseImport(raw: string): ImportedPlaylist[] {
  // 导入文件同样是外部输入：限制原文长度、歌单数与单张曲目数
  if (typeof raw !== 'string' || raw.length > IMPORT_MAX) throw new Error('文件过大')
  const data = JSON.parse(raw) as unknown
  const unpack = (value: unknown): unknown[] => {
    if (Array.isArray(value)) return value
    if (value && typeof value === 'object') {
      const list = (value as { playlists?: unknown }).playlists
      // 本应用导出的包：顶层是 {format, version, exportedAt, playlists}
      if (Array.isArray(list)) return list
      return [value]
    }
    return []
  }
  const list = unpack(data).slice(0, IMPORT_MAX_PLAYLISTS)
  const out: ImportedPlaylist[] = []
  for (const item of list as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object') continue
    const songs = item.songs
    if (!Array.isArray(songs)) continue
    const cids = songs
      .slice(0, IMPORT_MAX_SONGS)
      .map((s) => {
        if (typeof s === 'string') return s
        if (s && typeof s === 'object' && 'cid' in s) return String((s as { cid: unknown }).cid)
        return null
      })
      .filter((c): c is string => Boolean(c))
    if (!cids.length) continue
    out.push({
      name: typeof item.name === 'string' && item.name.trim() ? item.name.slice(0, 80) : '导入的歌单',
      description: typeof item.description === 'string' ? item.description.slice(0, 400) : '',
      tags: Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === 'string').slice(0, 6) : [],
      cover: typeof item.cover === 'string' ? item.cover : null,
      songs: cids,
    })
  }
  return out
}
