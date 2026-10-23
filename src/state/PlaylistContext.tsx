import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, errorText } from '../lib/api'
import { getSong } from '../lib/catalog'
import { encodeShare, payloadOf, type ImportedPlaylist } from '../lib/share'
import { toast } from '../lib/toast'
import type { FeedItem, Playlist, SharePayload } from '../lib/types'
import { useAuth } from './AuthContext'

interface PlaylistValue {
  playlists: Playlist[]
  feed: FeedItem[]
  create: (input: Partial<Pick<Playlist, 'name' | 'description' | 'tags' | 'songs' | 'coverSongCid'>>) => Promise<Playlist | null>
  update: (id: string, patch: Partial<Pick<Playlist, 'name' | 'description' | 'tags' | 'coverSongCid'>>) => Promise<void>
  remove: (id: string) => Promise<boolean>
  addSongs: (id: string, cids: string[]) => Promise<number | null>
  removeSong: (id: string, cid: string) => Promise<void>
  moveSong: (id: string, from: number, to: number) => Promise<void>
  publish: (id: string) => Promise<FeedItem | null>
  unpublish: (id: string) => Promise<void>
  saveShared: (payload: SharePayload) => Promise<Playlist | null>
  importMany: (list: ImportedPlaylist[]) => Promise<number>
}

const PlaylistContext = createContext<PlaylistValue | null>(null)

export function PlaylistProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [feed, setFeed] = useState<FeedItem[]>([])
  const playlistsRef = useRef<Playlist[]>(playlists)
  playlistsRef.current = playlists

  const replaceOne = useCallback((playlist: Playlist) => {
    setPlaylists((prev) => prev.map((p) => (p.id === playlist.id ? playlist : p)))
  }, [])

  const loadFeed = useCallback(async () => {
    try {
      const data = await api<{ feed: FeedItem[] }>('/feed')
      setFeed(data.feed)
    } catch {
      setFeed([])
    }
  }, [])

  useEffect(() => {
    void loadFeed()
  }, [loadFeed])

  useEffect(() => {
    if (!userId) {
      setPlaylists([])
      return
    }
    let alive = true
    api<{ playlists: Playlist[] }>('/playlists')
      .then((data) => alive && setPlaylists(data.playlists))
      .catch((error) => alive && toast(errorText(error, '歌单读取失败'), 'warn'))
    return () => {
      alive = false
    }
  }, [userId])

  const create = useCallback<PlaylistValue['create']>(async (input) => {
    try {
      const data = await api<{ playlist: Playlist }>('/playlists', {
        method: 'POST',
        body: {
          name: input.name ?? '',
          description: input.description ?? '',
          tags: input.tags ?? [],
          songs: input.songs ?? [],
          coverSongCid: input.coverSongCid ?? input.songs?.[0] ?? null,
        },
      })
      setPlaylists((prev) => [data.playlist, ...prev])
      return data.playlist
    } catch (error) {
      toast(errorText(error, '创建歌单失败'), 'warn')
      return null
    }
  }, [])

  const update = useCallback<PlaylistValue['update']>(async (id, patch) => {
    try {
      const data = await api<{ playlist: Playlist }>(`/playlists/${id}`, { method: 'PATCH', body: patch })
      replaceOne(data.playlist)
    } catch (error) {
      toast(errorText(error, '歌单更新失败'), 'warn')
    }
  }, [replaceOne])

  const remove = useCallback<PlaylistValue['remove']>(async (id) => {
    try {
      await api(`/playlists/${id}`, { method: 'DELETE' })
      setPlaylists((prev) => prev.filter((p) => p.id !== id))
      return true
    } catch (error) {
      toast(errorText(error, '删除失败'), 'warn')
      return false
    }
  }, [])

  const addSongs = useCallback<PlaylistValue['addSongs']>(async (id, cids) => {
    try {
      const data = await api<{ playlist: Playlist; added: number }>(`/playlists/${id}/songs`, {
        method: 'POST',
        body: { cids },
      })
      replaceOne(data.playlist)
      return data.added
    } catch (error) {
      toast(errorText(error, '添加曲目失败'), 'warn')
      return null
    }
  }, [replaceOne])

  const removeSong = useCallback<PlaylistValue['removeSong']>(async (id, cid) => {
    try {
      const data = await api<{ playlist: Playlist }>(`/playlists/${id}/songs/${encodeURIComponent(cid)}`, {
        method: 'DELETE',
      })
      replaceOne(data.playlist)
    } catch (error) {
      toast(errorText(error, '移除曲目失败'), 'warn')
    }
  }, [replaceOne])

  const moveSong = useCallback<PlaylistValue['moveSong']>(async (id, from, to) => {
    const current = playlistsRef.current.find((p) => p.id === id)
    if (!current || to < 0 || to >= current.songs.length) return
    const songs = [...current.songs]
    const [moved] = songs.splice(from, 1)
    songs.splice(to, 0, moved)
    setPlaylists((prev) => prev.map((p) => (p.id === id ? { ...p, songs } : p)))
    try {
      const data = await api<{ playlist: Playlist }>(`/playlists/${id}/order`, { method: 'PATCH', body: { songs } })
      replaceOne(data.playlist)
    } catch (error) {
      toast(errorText(error, '排序保存失败'), 'warn')
      const fresh = await api<{ playlists: Playlist[] }>('/playlists').catch(() => null)
      if (fresh) setPlaylists(fresh.playlists)
    }
  }, [replaceOne])

  const publish = useCallback<PlaylistValue['publish']>(
    async (id) => {
      const playlist = playlistsRef.current.find((p) => p.id === id)
      if (!playlist || !user) return null
      const code = encodeShare(payloadOf(playlist, user.name))
      const cover = playlist.coverSongCid ? getSong(playlist.coverSongCid)?.albumCover ?? null : null
      try {
        const data = await api<{ playlist: Playlist; entry: FeedItem | null }>(`/playlists/${id}/publish`, {
          method: 'POST',
          body: { code, cover },
        })
        replaceOne(data.playlist)
        if (data.entry) {
          setFeed((prev) => [data.entry as FeedItem, ...prev.filter((f) => f.code !== data.entry?.code)].slice(0, 60))
        }
        return data.entry
      } catch (error) {
        toast(errorText(error, '发布失败'), 'warn')
        return null
      }
    },
    [replaceOne, user],
  )

  const unpublish = useCallback<PlaylistValue['unpublish']>(
    async (id) => {
      try {
        const data = await api<{ playlist: Playlist }>(`/playlists/${id}/unpublish`, { method: 'POST' })
        replaceOne(data.playlist)
        await loadFeed()
      } catch (error) {
        toast(errorText(error, '取消发布失败'), 'warn')
      }
    },
    [replaceOne, loadFeed],
  )

  const saveShared = useCallback<PlaylistValue['saveShared']>(
    async (payload) => {
      try {
        const data = await api<{ playlist: Playlist }>('/playlists', {
          method: 'POST',
          body: {
            name: payload.name,
            description: payload.desc,
            tags: payload.tags,
            songs: payload.songs,
            coverSongCid: payload.cover,
          },
        })
        setPlaylists((prev) => [data.playlist, ...prev])
        return data.playlist
      } catch (error) {
        toast(errorText(error, '保存失败'), 'warn')
        return null
      }
    },
    [],
  )

  const importMany = useCallback<PlaylistValue['importMany']>(async (list) => {
    try {
      const data = await api<{ created: Playlist[]; count: number }>('/playlists/import', {
        method: 'POST',
        body: { items: list },
      })
      setPlaylists((prev) => [...data.created, ...prev])
      return data.count
    } catch (error) {
      toast(errorText(error, '导入失败'), 'warn')
      return 0
    }
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
