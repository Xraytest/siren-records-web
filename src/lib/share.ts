import LZString from 'lz-string'
import type { Playlist, SharePayload, Song } from './types'

export function encodeShare(payload: SharePayload): string {
  return LZString.compressToEncodedURIComponent(JSON.stringify(payload))
}

// 分享码是外部输入：LZString 的展开比没有理论上限（实测 2 万字符的码可解出 4740 万字符、
// 峰值 RSS 150MB），而 `decompressFromEncodedURIComponent` 是"全部解开再返回"，
// 事后检查 `json.length` 时内存已经吃满了。所以这里内置一份带预算的解压器：
// 一旦产出超过 SHARE_JSON_MAX 就立刻中止，绝不把整块结果拼出来。
const CODE_MAX = 20_000
const SHARE_JSON_MAX = 4_000_000
const SHARE_SONGS_MAX = 2_000

// lz-string 的 URI-safe 字母表（压缩端 `compressToEncodedURIComponent` 与解压端必须一致）
const KEY_STR = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$'

/**
 * 带输出预算的 LZString 解压（算法与 lz-string 1.5.0 的 `_decompress` 等价，MIT）。
 * @returns 解压结果；超预算、码损坏或字符越界时返回 null
 */
function decompressWithBudget(input: string, budget: number): string | null {
  const length = input.length
  let index = 1
  let val = KEY_STR.indexOf(input.charAt(0))
  if (val < 0) return null
  let position = 32 // 位掩码，按 5 bit/字符从高位往低位走
  const resetValue = 32

  /** 读 width 位；越界时按原始实现用 0 填充（对应 undefined & mask === 0） */
  const takeBits = (width: number): number => {
    let bits = 0
    let maxpower = 1 << width
    let power = 1
    while (power !== maxpower) {
      const resb = val & position
      position >>= 1
      if (position === 0) {
        position = resetValue
        if (index >= length) {
          val = 0
        } else {
          val = KEY_STR.indexOf(input.charAt(index))
          index += 1
          if (val < 0) return -1
        }
      }
      bits |= (resb > 0 ? 1 : 0) * power
      power <<= 1
    }
    return bits
  }

  const dictionary: (string | number)[] = [0, 1, 2]
  let bits = takeBits(2)
  if (bits < 0) return null
  let c: string
  if (bits === 0) {
    const code = takeBits(8)
    if (code < 0) return null
    c = String.fromCharCode(code)
  } else if (bits === 1) {
    const code = takeBits(16)
    if (code < 0) return null
    c = String.fromCharCode(code)
  } else {
    return ''
  }
  dictionary[3] = c
  let w = c
  const result: string[] = [c]
  let total = c.length

  let enlargeIn = 4
  let dictSize = 4
  let numBits = 3
  while (true) {
    if (index > length) return null
    bits = takeBits(numBits)
    if (bits < 0) return null
    if (bits === 0) {
      const code = takeBits(8)
      if (code < 0) return null
      dictionary[dictSize++] = String.fromCharCode(code)
      bits = dictSize - 1
      enlargeIn -= 1
    } else if (bits === 1) {
      const code = takeBits(16)
      if (code < 0) return null
      dictionary[dictSize++] = String.fromCharCode(code)
      bits = dictSize - 1
      enlargeIn -= 1
    } else if (bits === 2) {
      return result.join('')
    }
    if (enlargeIn === 0) {
      enlargeIn = 1 << numBits
      numBits += 1
    }
    let entry: string
    const found = dictionary[bits]
    if (found !== undefined) entry = String(found)
    else if (bits === dictSize) entry = w + w.charAt(0)
    else return null
    total += entry.length
    // 预算在这里生效：超了就直接放弃，不再继续拼接
    if (total > budget) return null
    result.push(entry)
    dictionary[dictSize++] = w + entry.charAt(0)
    enlargeIn -= 1
    w = entry
    if (enlargeIn === 0) {
      enlargeIn = 1 << numBits
      numBits += 1
    }
  }
}

export function decodeShare(code: string): SharePayload | null {
  try {
    if (typeof code !== 'string' || code.length > CODE_MAX) return null
    // 分享码里的空格等价于 `+`
    const json = decompressWithBudget(code.replace(/ /g, '+'), SHARE_JSON_MAX)
    if (!json) return null
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
