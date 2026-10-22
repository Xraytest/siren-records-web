import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { getSong } from '../lib/catalog'
import { encodeShare, payloadOf, type ImportedPlaylist } from '../lib/share'
import { read, uid, write } from '../lib/storage'
import type { FeedItem, Playlist, SharePayload } from '../lib/types'
import { useAuth } from './AuthContext'

interface PlaylistValue {
  playlists: Playlist[]
  feed: FeedItem[]
  create: (input: Partial<Pick<Playlist, 'name' | 'description' | 'tags' | 'songs' | 'coverSongCid'>>) => Playlist
  update: (id: string, patch: Partial<Playlist>) => void
  remove: (id: string) => void
  addSongs: (id: string, cids: string[]) => number
  removeSong: (id: string, cid: string) => void
  moveSong: (id: string, from: number, to: number) => void
  publish: (id: string) => FeedItem | null
  unpublish: (id: string) => void
  saveShared: (payload: SharePayload) => Playlist
  importMany: (list: ImportedPlaylist[]) => number
}

const PlaylistContext = createContext<PlaylistValue | null>(null)

function loadPlaylists(userId: string | null): Playlist[] {
  if (!userId) return []
  const data = read<Playlist[]>(`playlists:${userId}`, [])
  return Array.isArray(data) ? data : []
}

function loadFeed(): FeedItem[] {
  const data = read<FeedItem[]>('feed', [])
  return Array.isArray(data) ? data : []
}

export function PlaylistProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const [playlists, setPlaylists] = useState<Playlist[]>(() => loadPlaylists(userId))
  const [feed, setFeed] = useState<FeedItem[]>(loadFeed)

  useEffect(() => {
    setPlaylists(loadPlaylists(userId))
  }, [userId])

  useEffect(() => {
    if (userId) write(`playlists:${userId}`, playlists)
  }, [playlists, userId])

  useEffect(() => {
    write('feed', feed)
  }, [feed])

  const create = useCallback<PlaylistValue['create']>((input) => {
    const now = Date.now()
    const playlist: Playlist = {
      id: uid(),
      name: input.name?.trim() || '未命名歌单',
      description: input.description || '',
      tags: input.tags || [],
      coverSongCid: input.coverSongCid ?? input.songs?.[0] ?? null,
      songs: Array.from(new Set(input.songs || [])),
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
      publishCode: null,
    }
    setPlaylists((prev) => [playlist, ...prev])
    return playlist
  }, [])

  const update = useCallback<PlaylistValue['update']>((id, patch) => {
    setPlaylists((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p)),
    )
  }, [])

  const remove = useCallback<PlaylistValue['remove']>((id) => {
    setPlaylists((prev) => prev.filter((p) => p.id !== id))
  }, [])

  const addSongs = useCallback<PlaylistValue['addSongs']>((id, cids) => {
    let added = 0
    setPlaylists((prev) =>
      prev.map((p) => {
        if (p.id !== id) return p
        const next = [...p.songs]
        for (const cid of cids) {
          if (!next.includes(cid)) {
            next.push(cid)
            added++
          }
        }
        return {
          ...p,
          songs: next,
          coverSongCid: p.coverSongCid ?? next[0] ?? null,
          updatedAt: Date.now(),
        }
      }),
    )
    return added
  }, [])

  const removeSong = useCallback<PlaylistValue['removeSong']>((id, cid) => {
    setPlaylists((prev) =>
      prev.map((p) =>
        p.id === id
          ? {
              ...p,
              songs: p.songs.filter((c) => c !== cid),
              coverSongCid: p.coverSongCid === cid ? (p.songs.find((c) => c !== cid) ?? null) : p.coverSongCid,
              updatedAt: Date.now(),
            }
          : p,
      ),
    )
  }, [])

  const moveSong = useCallback<PlaylistValue['moveSong']>((id, from, to) => {
    setPlaylists((prev) =>
      prev.map((p) => {
        if (p.id !== id || to < 0 || to >= p.songs.length) return p
        const songs = [...p.songs]
        const [moved] = songs.splice(from, 1)
        songs.splice(to, 0, moved)
        return { ...p, songs, updatedAt: Date.now() }
      }),
    )
  }, [])

  const publish = useCallback<PlaylistValue['publish']>(
    (id) => {
      const playlist = playlists.find((p) => p.id === id)
      if (!playlist || !user) return null
      const code = encodeShare(payloadOf(playlist, user.name))
      const coverSong = playlist.coverSongCid ? getSong(playlist.coverSongCid) : null
      const entry: FeedItem = {
        code,
        name: playlist.name,
        description: playlist.description,
        authorName: user.name,
        authorId: user.id,
        songCount: playlist.songs.length,
        cover: coverSong?.albumCover ?? null,
        tags: playlist.tags,
        at: Date.now(),
      }
      setFeed((prev) => [entry, ...prev.filter((f) => f.code !== code)].slice(0, 60))
      setPlaylists((prev) =>
        prev.map((p) => (p.id === id ? { ...p, publishedAt: Date.now(), publishCode: code } : p)),
      )
      return entry
    },
    [playlists, user],
  )

  const unpublish = useCallback<PlaylistValue['unpublish']>(
    (id) => {
      const playlist = playlists.find((p) => p.id === id)
      if (playlist?.publishCode) {
        setFeed((prev) => prev.filter((f) => f.code !== playlist.publishCode))
      }
      setPlaylists((prev) =>
        prev.map((p) => (p.id === id ? { ...p, publishedAt: null, publishCode: null } : p)),
      )
    },
    [playlists],
  )

  const saveShared = useCallback<PlaylistValue['saveShared']>(
    (payload) => {
      const now = Date.now()
      const playlist: Playlist = {
        id: uid(),
        name: payload.name,
        description: payload.desc,
        tags: payload.tags,
        coverSongCid: payload.cover,
        songs: Array.from(new Set(payload.songs)),
        createdAt: now,
        updatedAt: now,
        publishedAt: null,
        publishCode: null,
      }
      setPlaylists((prev) => [playlist, ...prev])
      return playlist
    },
    [],
  )

  const importMany = useCallback<PlaylistValue['importMany']>((list) => {
    const now = Date.now()
    const created = list.map((item) => ({
      id: uid(),
      name: item.name,
      description: item.description,
      tags: item.tags,
      coverSongCid: item.cover,
      songs: Array.from(new Set(item.songs)),
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
      publishCode: null,
    }))
    setPlaylists((prev) => [...created, ...prev])
    return created.length
  }, [])

  const value = useMemo<PlaylistValue>(
    () => ({ playlists, feed, create, update, remove, addSongs, removeSong, moveSong, publish, unpublish, saveShared, importMany }),
    [playlists, feed, create, update, remove, addSongs, removeSong, moveSong, publish, unpublish, saveShared, importMany],
  )

  return <PlaylistContext.Provider value={value}>{children}</PlaylistContext.Provider>
}

export function usePlaylists() {
  const ctx = useContext(PlaylistContext)
  if (!ctx) throw new Error('usePlaylists 必须在 PlaylistProvider 内使用')
  return ctx
}
