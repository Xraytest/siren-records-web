import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { toast } from '../lib/toast'
import { loadCatalog } from '../lib/catalog'
import type { LyricLine, Song } from '../lib/types'

type RepeatMode = 'off' | 'all' | 'one'

interface PlayerValue {
  queue: Song[]
  index: number
  current: Song | null
  playing: boolean
  loading: boolean
  currentTime: number
  duration: number
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: RepeatMode
  lyrics: LyricLine[]
  lyricLoading: boolean
  analyser: AnalyserNode | null
  contextLabel: string
  playQueue: (songs: Song[], startIndex?: number, label?: string) => void
  toggle: () => void
  next: () => void
  prev: () => void
  seek: (time: number) => void
  setVolume: (v: number) => void
  toggleMute: () => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  enqueue: (songs: Song[]) => void
  removeFromQueue: (cid: string) => void
}

const PlayerContext = createContext<PlayerValue | null>(null)

function parseLrc(text: string): LyricLine[] {
  const lines: LyricLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)]
    if (!stamps.length) continue
    const content = raw.replace(/\[[^\]]+\]/g, '').trim()
    for (const m of stamps) {
      const min = Number(m[1])
      const sec = Number(m[2])
      const frac = m[3] ? Number(`0.${m[3]}`) : 0
      lines.push({ time: min * 60 + sec + frac, text: content })
    }
  }
  return lines.sort((a, b) => a.time - b.time)
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const loadedCidRef = useRef<string | null>(null)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)

  const [queue, setQueue] = useState<Song[]>([])
  const [index, setIndex] = useState(0)
  const [contextLabel, setContextLabel] = useState('')
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolumeState] = useState(0.8)
  const [muted, setMuted] = useState(false)
  const [shuffle, setShuffle] = useState(false)
  const [repeat, setRepeat] = useState<RepeatMode>('off')
  const [lyrics, setLyrics] = useState<LyricLine[]>([])
  const [lyricLoading, setLyricLoading] = useState(false)

  const current = queue[index] ?? null

  const getAudio = useCallback(() => {
    if (!audioRef.current) {
      const audio = new Audio()
      audio.preload = 'metadata'
      audio.crossOrigin = 'anonymous'
      audio.volume = volume
      audioRef.current = audio
    }
    return audioRef.current
  }, [volume])

  const ensureAnalyser = useCallback((audio: HTMLAudioElement) => {
    if (analyserRef.current) return
    try {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctor()
      const source = ctx.createMediaElementSource(audio)
      const node = ctx.createAnalyser()
      node.fftSize = 256
      node.smoothingTimeConstant = 0.82
      source.connect(node)
      node.connect(ctx.destination)
      audioCtxRef.current = ctx
      analyserRef.current = node
      setAnalyser(node)
    } catch {
      // 某些浏览器在跨域策略下拒绝 Web Audio，播放器会退回静态波形
    }
  }, [])

  const playQueue = useCallback(
    (songs: Song[], startIndex = 0, label = '') => {
      if (!songs.length) return
      setQueue(songs)
      setIndex(Math.min(Math.max(startIndex, 0), songs.length - 1))
      setContextLabel(label)
      setPlaying(true)
    },
    [],
  )

  useEffect(() => {
    const audio = getAudio()
    if (!current?.cid) return
    // 官方音频地址带时效签名，改由服务端在播放时换取新地址后 302 跳转
    if (loadedCidRef.current !== current.cid) {
      loadedCidRef.current = current.cid
      audio.src = `/api/audio/${current.cid}`
      setCurrentTime(0)
      setDuration(0)
      setLoading(true)
    }
    ensureAnalyser(audio)
    if (playing) {
      audioCtxRef.current?.resume().catch(() => undefined)
      audio.play().catch(() => {
        setPlaying(false)
        setLoading(false)
        toast('音频加载失败，请检查网络或稍后重试', 'warn')
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.cid])

  useEffect(() => {
    const audio = getAudio()
    if (playing) {
      audioCtxRef.current?.resume().catch(() => undefined)
      audio.play().catch(() => setPlaying(false))
    } else {
      audio.pause()
    }
  }, [playing, getAudio])

  useEffect(() => {
    const audio = getAudio()
    audio.volume = volume
    audio.muted = muted
  }, [volume, muted, getAudio])

  useEffect(() => {
    const audio = getAudio()
    const onTime = () => setCurrentTime(audio.currentTime)
    const onMeta = () => {
      setDuration(Number.isFinite(audio.duration) ? audio.duration : 0)
      setLoading(false)
    }
    const onWaiting = () => setLoading(true)
    const onPlaying = () => setLoading(false)
    const onEnded = () => {
      if (repeat === 'one') {
        audio.currentTime = 0
        void audio.play()
        return
      }
      if (shuffle) {
        setIndex((i) => (queue.length > 1 ? Math.floor(Math.random() * (queue.length - 1)) : i))
        return
      }
      if (index < queue.length - 1) {
        setIndex((i) => i + 1)
      } else if (repeat === 'all') {
        setIndex(0)
      } else {
        setPlaying(false)
      }
    }
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('waiting', onWaiting)
    audio.addEventListener('playing', onPlaying)
    audio.addEventListener('ended', onEnded)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('waiting', onWaiting)
      audio.removeEventListener('playing', onPlaying)
      audio.removeEventListener('ended', onEnded)
    }
  }, [getAudio, repeat, shuffle, index, queue.length])

  useEffect(() => {
    if (!current?.cid) {
      setLyrics([])
      return
    }
    let alive = true
    setLyricLoading(true)
    fetch(`/api/lyric/${current.cid}`)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error('no lyric'))))
      .then((text) => {
        if (alive) setLyrics(parseLrc(text))
      })
      .catch(() => {
        if (alive) setLyrics([])
      })
      .finally(() => {
        if (alive) setLyricLoading(false)
      })
    return () => {
      alive = false
    }
  }, [current?.cid])

  useEffect(() => {
    if (!current || !('mediaSession' in navigator)) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.name,
      artist: current.artistes,
      album: current.albumName,
      artwork: [{ src: current.albumCover, sizes: '512x512', type: 'image/jpeg' }],
    })
  }, [current])

  const next = useCallback(() => {
    if (!queue.length) return
    if (shuffle) {
      setIndex((i) => (queue.length > 1 ? (i + 1 + Math.floor(Math.random() * (queue.length - 1))) % queue.length : i))
      setPlaying(true)
      return
    }
    if (index < queue.length - 1) {
      setIndex((i) => i + 1)
    } else if (repeat === 'all') {
      setIndex(0)
    } else {
      setPlaying(false)
    }
  }, [queue.length, index, shuffle, repeat])

  const prev = useCallback(() => {
    const audio = getAudio()
    if (audio.currentTime > 4) {
      audio.currentTime = 0
      return
    }
    setIndex((i) => Math.max(i - 1, 0))
  }, [getAudio])

  const toggle = useCallback(() => {
    if (!current) return
    setPlaying((p) => !p)
  }, [current])

  const seek = useCallback(
    (time: number) => {
      const audio = getAudio()
      if (Number.isFinite(time)) audio.currentTime = time
      setCurrentTime(time)
    },
    [getAudio],
  )

  const setVolume = useCallback((v: number) => {
    setVolumeState(v)
    if (v > 0) setMuted(false)
  }, [])

  const enqueue = useCallback((songs: Song[]) => {
    setQueue((prev) => {
      const existing = new Set(prev.map((s) => s.cid))
      const additions = songs.filter((s) => !existing.has(s.cid))
      return [...prev, ...additions]
    })
  }, [])

  const removeFromQueue = useCallback(
    (cid: string) => {
      setQueue((prev) => {
        const at = prev.findIndex((s) => s.cid === cid)
        if (at === -1) return prev
        const nextQueue = prev.filter((s) => s.cid !== cid)
        if (at < index) setIndex((i) => i - 1)
        if (!nextQueue.length) setPlaying(false)
        return nextQueue
      })
    },
    [index],
  )

  const value = useMemo<PlayerValue>(
    () => ({
      queue,
      index,
      current,
      playing,
      loading,
      currentTime,
      duration,
      volume,
      muted,
      shuffle,
      repeat,
      lyrics,
      lyricLoading,
      analyser,
      contextLabel,
      playQueue,
      toggle,
      next,
      prev,
      seek,
      setVolume,
      toggleMute: () => setMuted((m) => !m),
      toggleShuffle: () => setShuffle((s) => !s),
      cycleRepeat: () => setRepeat((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off')),
      enqueue,
      removeFromQueue,
    }),
    [
      queue, index, current, playing, loading, currentTime, duration, volume, muted, shuffle,
      repeat, lyrics, lyricLoading, analyser, contextLabel, playQueue, toggle, next, prev, seek,
      setVolume, enqueue, removeFromQueue,
    ],
  )

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>
}

export function usePlayer() {
  const ctx = useContext(PlayerContext)
  if (!ctx) throw new Error('usePlayer 必须在 PlayerProvider 内使用')
  return ctx
}

export function useSongs(cids: string[]): Song[] {
  const [songs, setSongs] = useState<Song[]>([])
  const key = cids.join(',')
  useEffect(() => {
    let alive = true
    loadCatalog().then((c) => {
      if (!alive) return
      setSongs(key ? key.split(',').map((cid) => c.songs.get(cid)).filter((s): s is Song => Boolean(s)) : [])
    })
    return () => {
      alive = false
    }
  }, [key])
  return songs
}
