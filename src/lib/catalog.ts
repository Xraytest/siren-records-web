import { useEffect, useState } from 'react'
import type { Album, Catalog, Song } from './types'

let cache: { catalog: Catalog; albums: Map<string, Album>; songs: Map<string, Song>; all: Song[] } | null = null

function build(catalog: Catalog) {
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

let pending: Promise<ReturnType<typeof build>> | null = null

export function loadCatalog() {
  if (cache) return Promise.resolve(cache)
  if (!pending) {
    pending = fetch(`${import.meta.env.BASE_URL}data/catalog.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`曲库载入失败 (${res.status})`)
        return res.json() as Promise<Catalog>
      })
      .then((catalog) => {
        cache = build(catalog)
        return cache
      })
  }
  return pending
}

export function useCatalog() {
  const [state, setState] = useState(cache)
  useEffect(() => {
    let alive = true
    loadCatalog()
      .then((c) => alive && setState({ ...c }))
      .catch(() => alive && setState(null))
    return () => {
      alive = false
    }
  }, [])
  return state
}

export function getSong(cid: string) {
  return cache?.songs.get(cid) ?? null
}

export function getAlbum(cid: string) {
  return cache?.albums.get(cid) ?? null
}

export async function ensureSong(cid: string) {
  const c = await loadCatalog()
  return c.songs.get(cid) ?? null
}

export function searchAll(keyword: string) {
  if (!cache) return { songs: [] as Song[], albums: [] as Album[] }
  const q = keyword.trim().toLowerCase()
  if (!q) return { songs: [], albums: [] }
  const songs = cache.all
    .filter((s) => s.name.toLowerCase().includes(q) || s.artistes.toLowerCase().includes(q) || s.albumName.toLowerCase().includes(q))
    .slice(0, 24)
  const albums = cache.catalog.albums
    .filter((a) => a.name.toLowerCase().includes(q) || a.artistes.join(' ').toLowerCase().includes(q))
    .slice(0, 8)
  return { songs, albums }
}
