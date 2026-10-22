import LZString from 'lz-string'
import type { Playlist, SharePayload, Song } from './types'

export function encodeShare(payload: SharePayload): string {
  return LZString.compressToEncodedURIComponent(JSON.stringify(payload))
}

export function decodeShare(code: string): SharePayload | null {
  try {
    const json = LZString.decompressFromEncodedURIComponent(code)
    if (!json) return null
    const data = JSON.parse(json) as SharePayload
    if (data?.t !== 'siren-playlist' || !Array.isArray(data.songs)) return null
    return {
      ...data,
      name: typeof data.name === 'string' ? data.name : '未命名歌单',
      desc: typeof data.desc === 'string' ? data.desc : '',
      author: typeof data.author === 'string' ? data.author : '匿名',
      tags: Array.isArray(data.tags) ? data.tags.filter((t) => typeof t === 'string') : [],
      cover: typeof data.cover === 'string' ? data.cover : null,
      songs: data.songs.filter((c): c is string => typeof c === 'string'),
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

export interface ImportedPlaylist {
  name: string
  description: string
  tags: string[]
  cover: string | null
  songs: string[]
}

/** 解析导入文件：兼容本应用的曲库包与外部 {name, songs:[cid]} 结构 */
export function parseImport(raw: string): ImportedPlaylist[] {
  const data = JSON.parse(raw) as unknown
  const list = Array.isArray(data) ? data : [data]
  const out: ImportedPlaylist[] = []
  for (const item of list as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object') continue
    const songs = item.songs
    if (!Array.isArray(songs)) continue
    const cids = songs
      .map((s) => {
        if (typeof s === 'string') return s
        if (s && typeof s === 'object' && 'cid' in s) return String((s as { cid: unknown }).cid)
        return null
      })
      .filter((c): c is string => Boolean(c))
    if (!cids.length) continue
    out.push({
      name: typeof item.name === 'string' && item.name.trim() ? item.name : '导入的歌单',
      description: typeof item.description === 'string' ? item.description : '',
      tags: Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === 'string') : [],
      cover: typeof item.cover === 'string' ? item.cover : null,
      songs: cids,
    })
  }
  return out
}
