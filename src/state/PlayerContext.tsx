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
import { isInstrumental, useSettings } from '../lib/settings'
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

/** 播放器偏好与上次播放记录保存在浏览器本地 */
const STORE_KEY = 'siren:player'

interface StoredPlayer {
  cids: string[]
  index: number
  label: string
  time: number
  shuffle: boolean
  repeat: RepeatMode
  volume: number
  muted: boolean
}

function readStored(): StoredPlayer | null {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as Partial<StoredPlayer>
    if (!Array.isArray(data.cids) || !data.cids.length) return null
    return {
      cids: data.cids.filter((cid): cid is string => typeof cid === 'string'),
      index: Number(data.index) || 0,
      label: typeof data.label === 'string' ? data.label : '',
      time: Number(data.time) || 0,
      shuffle: Boolean(data.shuffle),
      repeat: data.repeat === 'all' || data.repeat === 'one' ? data.repeat : 'off',
      volume: typeof data.volume === 'number' ? data.volume : 0.8,
      muted: Boolean(data.muted),
    }
  } catch {
    return null
  }
}

const initialPlayer = readStored()

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
  const [volume, setVolumeState] = useState(initialPlayer?.volume ?? 0.8)
  const [muted, setMuted] = useState(initialPlayer?.muted ?? false)
  const [shuffle, setShuffle] = useState(initialPlayer?.shuffle ?? false)
  const [repeat, setRepeat] = useState<RepeatMode>(initialPlayer?.repeat ?? 'off')
  const [lyrics, setLyrics] = useState<LyricLine[]>([])
  const [lyricLoading, setLyricLoading] = useState(false)

  const current = queue[index] ?? null
  const { hideInstrumental } = useSettings()
  const pendingSeekRef = useRef<number | null>(initialPlayer?.time ?? null)
  const restoredRef = useRef(false)
  const hadQueueRef = useRef(false)
  const lastSavedRef = useRef(0)

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
      pendingSeekRef.current = null
      hadQueueRef.current = true
      setQueue(songs)
      setIndex(Math.min(Math.max(startIndex, 0), songs.length - 1))
      setContextLabel(label)
      setPlaying(true)
    },
    [],
  )

  // 还原上次的播放队列与进度（保持暂停，不自动出声）
  useEffect(() => {
    if (restoredRef.current || !initialPlayer) return
    restoredRef.current = true
    void loadCatalog().then((c) => {
      const songs = initialPlayer.cids
        .map((cid) => c.songs.get(cid))
        .filter((s): s is Song => Boolean(s))
        .filter((s) => !hideInstrumental || !isInstrumental(s.name))
      if (!songs.length) return
      hadQueueRef.current = true
      setQueue(songs)
      setIndex(Math.min(Math.max(initialPlayer.index, 0), songs.length - 1))
      setContextLabel(initialPlayer.label)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const snapshotRef = useRef({ queue, index, contextLabel, shuffle, repeat, volume, muted, currentTime })
  snapshotRef.current = { queue, index, contextLabel, shuffle, repeat, volume, muted, currentTime }

  const savePlayerState = useCallback(() => {
    const s = snapshotRef.current
    if (!s.queue.length) {
      // 队列被清空时才删除记录，避免挂载瞬间抹掉待还原的数据
      if (hadQueueRef.current) {
        localStorage.removeItem(STORE_KEY)
        hadQueueRef.current = false
      }
      return
    }
    hadQueueRef.current = true
    const data: StoredPlayer = {
      cids: s.queue.map((song) => song.cid),
      index: s.index,
      label: s.contextLabel,
      time: Math.floor(s.currentTime),
      shuffle: s.shuffle,
      repeat: s.repeat,
      volume: s.volume,
      muted: s.muted,
    }
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(data))
    } catch {
      // 存储已满或隐私模式下忽略
    }
  }, [])

  useEffect(() => {
    savePlayerState()
  }, [queue, index, contextLabel, shuffle, repeat, volume, muted, savePlayerState])

  // 播放进度最多每 5 秒写一次，避免频繁写入
  useEffect(() => {
    if (Date.now() - lastSavedRef.current < 5000) return
    lastSavedRef.current = Date.now()
    savePlayerState()
  }, [currentTime, savePlayerState])

  useEffect(() => {
    const flush = () => savePlayerState()
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flush)
    }
  }, [savePlayerState])

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
      const total = Number.isFinite(audio.duration) ? audio.duration : 0
      setDuration(total)
      setLoading(false)
      const resume = pendingSeekRef.current
      if (resume && total > 0) {
        pendingSeekRef.current = null
        // 上次听到的位置：只恢复进度，不自动播放
        if (resume < total - 2) {
          audio.currentTime = resume
          setCurrentTime(resume)
        }
      }
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
  const { hideInstrumental } = useSettings()
  const key = cids.join(',')
  useEffect(() => {
    let alive = true
    loadCatalog().then((c) => {
      if (!alive) return
      const list = key ? key.split(',').map((cid) => c.songs.get(cid)).filter((s): s is Song => Boolean(s)) : []
      setSongs(hideInstrumental ? list.filter((s) => !isInstrumental(s.name)) : list)
    })
    return () => {
      alive = false
    }
  }, [key, hideInstrumental])
  return songs
}
