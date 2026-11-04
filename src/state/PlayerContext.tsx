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
import { advanceTrack, retreatTrack, type RepeatMode } from '../lib/player-queue'
import { STALL_MS, canRetry, retryDelay, shouldClearRetry } from '../lib/retry-policy'
import type { LyricLine, Song } from '../lib/types'

export type { RepeatMode }

interface PlayerValue {
  queue: Song[]
  index: number
  current: Song | null
  playing: boolean
  loading: boolean
  /** >0 表示当前曲目正在第 n 次自动重连（网络抖动时的自愈状态） */
  retrying: number
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
  retryNow: () => void
  enqueue: (songs: Song[]) => void
  removeFromQueue: (cid: string) => void
}

const PlayerContext = createContext<PlayerValue | null>(null)

/** 播放器偏好与上次播放记录保存在浏览器本地 */
const STORE_KEY = 'siren:player'

/**
 * 自动重连的常量与判定见 lib/retry-policy.ts：
 * 「算一次成功」的门槛是连续稳定播放 STABLE_MS（10s），而不是一 resolve 就清零。
 */

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
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)

  const [queue, setQueue] = useState<Song[]>([])
  const [index, setIndex] = useState(0)
  const [contextLabel, setContextLabel] = useState('')
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [retrying, setRetrying] = useState(0)
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

  /**
   * 命令式状态镜像：音频事件与重连定时器都在 React 渲染之外回调，
   * 只能读 ref，读 state 会拿到上一帧的旧值（这正是旧版循环停在队尾的成因之一）。
   */
  const live = useRef<{
    queue: Song[]
    index: number
    playing: boolean
    shuffle: boolean
    repeat: RepeatMode
    volume: number
    muted: boolean
    label: string
  }>({
    queue: [],
    index: 0,
    playing: false,
    shuffle: Boolean(initialPlayer?.shuffle),
    repeat: (initialPlayer?.repeat ?? 'off') as RepeatMode,
    volume: initialPlayer?.volume ?? 0.8,
    muted: Boolean(initialPlayer?.muted),
    label: initialPlayer?.label ?? '',
  })

  const pendingSeekRef = useRef<number | null>(initialPlayer?.time ?? null)
  const restoredRef = useRef(false)
  const hadQueueRef = useRef(false)
  const lastSavedRef = useRef(0)
  const epochRef = useRef(0)
  const retryCountRef = useRef(0)
  const retryTimerRef = useRef<number | null>(null)
  /** 本次「稳定播放」起点：只有连续播满 STABLE_MS 才允许清零重试计数 */
  const stableSinceRef = useRef(0)
  const playedRef = useRef<Set<number>>(new Set())
  const progressAtRef = useRef(0)
  const recoveredRef = useRef(false)
  const loadedCidRef = useRef<string | null>(null)

  const getAudio = useCallback(() => {
    if (!audioRef.current) {
      const audio = new Audio()
      audio.preload = 'metadata'
      audio.crossOrigin = 'anonymous'
      audio.volume = live.current.volume
      audio.muted = live.current.muted
      audioRef.current = audio
    }
    return audioRef.current
  }, [])

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

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
  }, [])

  // tryPlay 与 scheduleRetry 互相引用：用 ref 打破初始化顺序依赖
  const scheduleRetryRef = useRef<() => void>(() => undefined)

  const setPlayingBoth = useCallback((value: boolean) => {
    live.current.playing = value
    setPlaying(value)
  }, [])

  /** 发起播放；失败时按退避重试，而不是直接停播 */
  const tryPlay = useCallback(() => {
    const audio = getAudio()
    const epoch = epochRef.current
    audio.play().then(
      () => {
        if (epochRef.current !== epoch) return
        // 注意：这里不能清零 retryCount —— play() 在「刚开始出声」时就 resolve，
        // 而这时流可能马上又被掐断。清零只发生在连续稳定播放 STABLE_MS 之后（见 onTime）。
        if (recoveredRef.current) {
          recoveredRef.current = false
          toast('网络波动，已自动恢复播放', 'info')
        }
      },
      (error: unknown) => {
        if (epochRef.current !== epoch) return
        const name = (error as { name?: string } | null)?.name
        // 切歌或暂停打断 play() 属于正常中断，不当作故障
        if (name === 'AbortError') return
        // 浏览器自动播放策略拦截：交给用户手势，不重试
        if (name === 'NotAllowedError') {
          setPlayingBoth(false)
          setLoading(false)
          return
        }
        scheduleRetryRef.current()
      },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getAudio, setPlayingBoth])

  /** 网络类故障的自动重连：换一次新签名地址并从断点续播 */
  const scheduleRetry = useCallback(() => {
    const audio = getAudio()
    if (!live.current.playing) return
    // 同一次加载失败通常会同时触发 <audio> 的 error 事件与 play() 的 rejection，
    // 两者都调到这里；若不合并就会「一次故障消耗两次预算」，实测 4 次预算只够 2 次故障。
    if (retryTimerRef.current !== null) return
    if (!canRetry(retryCountRef.current)) {
      clearRetryTimer()
      setPlayingBoth(false)
      setLoading(false)
      setRetrying(0)
      // 放弃自动重连后把预算清空：用户下一次手动播放/重试重新获得完整的 4 次
      retryCountRef.current = 0
      stableSinceRef.current = 0
      toast('音频连续加载失败，已暂停。网络恢复后点击播放即可继续', 'warn')
      return
    }
    retryCountRef.current += 1
    const attempt = retryCountRef.current
    recoveredRef.current = true
    setRetrying(attempt)
    setLoading(true)
    clearRetryTimer()
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null
      if (!live.current.playing) return
      const song = live.current.queue[live.current.index]
      if (!song) return
      const resume = audio.currentTime > 0 ? audio.currentTime : 0
      pendingSeekRef.current = resume > 0 ? resume : null
      // 旧签名可能已过期：加时间戳让 Worker 重新 302 到新地址
      epochRef.current += 1
      loadedCidRef.current = song.cid
      audio.src = `/api/audio/${song.cid}?r=${Date.now()}`
      audio.load()
      progressAtRef.current = Date.now()
      void tryPlay()
    }, retryDelay(attempt))
  }, [clearRetryTimer, getAudio, setPlayingBoth, tryPlay])

  scheduleRetryRef.current = scheduleRetry

  /** 从队列指定位置起播（唯一入口：切歌、循环、重连都走这里） */
  const startAt = useCallback(
    (songs: Song[], pos: number, opts: { autoplay: boolean; seek?: number; label?: string }) => {
      const song = songs[Math.min(Math.max(pos, 0), Math.max(songs.length - 1, 0))]
      if (!song) return
      const audio = getAudio()
      clearRetryTimer()
      retryCountRef.current = 0
      recoveredRef.current = false
      setRetrying(0)
      epochRef.current += 1
      playedRef.current.add(pos)

      live.current.queue = songs
      live.current.index = pos
      setQueue(songs)
      setIndex(pos)
      if (opts.label !== undefined) {
        live.current.label = opts.label
        setContextLabel(opts.label)
      }
      setCurrentTime(opts.seek ?? 0)
      setDuration(0)
      setLoading(true)
      pendingSeekRef.current = opts.seek && opts.seek > 0 ? opts.seek : null
      loadedCidRef.current = song.cid
      audio.src = `/api/audio/${song.cid}`
      audio.load()
      progressAtRef.current = Date.now()
      ensureAnalyser(audio)
      if (opts.autoplay) {
        live.current.playing = true
        setPlaying(true)
        audioCtxRef.current?.resume().catch(() => undefined)
        void tryPlay()
      } else {
        setPlayingBoth(false)
        audio.pause()
      }
    },
    [clearRetryTimer, ensureAnalyser, getAudio, setPlayingBoth, tryPlay],
  )

  /** 当前曲目结束后的推进 */
  const handleEnded = useCallback(() => {
    const audio = getAudio()
    const state = live.current
    const result = advanceTrack({
      repeat: state.repeat,
      shuffle: state.shuffle,
      index: state.index,
      length: state.queue.length,
      played: playedRef.current,
    })
    if (result.kind === 'stop') {
      setPlayingBoth(false)
      setLoading(false)
      return
    }
    // restart 只表示「从 0 秒重放」；列表循环绕回队首时 result.index 已经变了，
    // 必须走 startAt 换曲，否则会把队尾那首一直重播（「选了列表循环但还是原地循环」的根因）。
    if (result.restart && result.index === state.index) {
      playedRef.current.add(state.index)
      retryCountRef.current = 0
      setRetrying(0)
      epochRef.current += 1
      audio.currentTime = 0
      setCurrentTime(0)
      void tryPlay()
      return
    }
    startAt(state.queue, result.index, { autoplay: true })
  }, [getAudio, setPlayingBoth, startAt, tryPlay])

  const playQueue = useCallback(
    (songs: Song[], startIndex = 0, label = '') => {
      if (!songs.length) return
      playedRef.current = new Set()
      startAt(songs, Math.min(Math.max(startIndex, 0), songs.length - 1), { autoplay: true, label })
    },
    [startAt],
  )

  /** 登出/会话失效：清空队列与本地记录，避免共享设备上残留上个账号的私人歌单名与断点 */
  const resetPlayer = useCallback(() => {
    const audio = getAudio()
    clearRetryTimer()
    epochRef.current += 1
    audio.pause()
    audio.removeAttribute('src')
    loadedCidRef.current = null
    try {
      audio.load()
    } catch {
      // 部分浏览器对空 src 调 load 会抛错，忽略即可
    }
    playedRef.current = new Set()
    pendingSeekRef.current = null
    retryCountRef.current = 0
    stableSinceRef.current = 0
    recoveredRef.current = false
    hadQueueRef.current = false
    live.current.queue = []
    live.current.index = 0
    live.current.label = ''
    live.current.playing = false
    setQueue([])
    setIndex(0)
    setContextLabel('')
    setPlaying(false)
    setLoading(false)
    setRetrying(0)
    setCurrentTime(0)
    setDuration(0)
    setLyrics([])
    try {
      localStorage.removeItem(STORE_KEY)
    } catch {
      // 隐私模式下忽略
    }
  }, [clearRetryTimer, getAudio])

  useEffect(() => {
    const onLogout = () => resetPlayer()
    window.addEventListener('siren:logout', onLogout)
    return () => window.removeEventListener('siren:logout', onLogout)
  }, [resetPlayer])

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
      const pos = Math.min(Math.max(initialPlayer.index, 0), songs.length - 1)
      startAt(songs, pos, { autoplay: false, seek: initialPlayer.time, label: initialPlayer.label })
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

  // 音量/静音直接同步到元素
  useEffect(() => {
    const audio = getAudio()
    live.current.volume = volume
    live.current.muted = muted
    audio.volume = volume
    audio.muted = muted
  }, [volume, muted, getAudio])

  // 播放/暂停：从任意入口把 playing 置真时，补一次 play（幂等）
  useEffect(() => {
    const audio = getAudio()
    live.current.playing = playing
    if (!playing) {
      audio.pause()
      return
    }
    if (!audio.src || !audio.paused) return
    audioCtxRef.current?.resume().catch(() => undefined)
    void tryPlay()
  }, [playing, getAudio, tryPlay])

  // 音频事件统一绑定一次，全部读 ref，不随 state 变化反复重绑
  useEffect(() => {
    const audio = getAudio()
    const onTime = () => {
      progressAtRef.current = Date.now()
      setCurrentTime(audio.currentTime)
      // 连续播满 STABLE_MS 才算这次连接真的成功，此时才把重试预算还给用户
      if (shouldClearRetry(retryCountRef.current, stableSinceRef.current, Date.now())) {
        retryCountRef.current = 0
        setRetrying(0)
      }
    }
    const onMeta = () => {
      const total = Number.isFinite(audio.duration) ? audio.duration : 0
      setDuration(total)
      setLoading(false)
      const resume = pendingSeekRef.current
      if (resume && total > 0) {
        pendingSeekRef.current = null
        // 上次听到的位置：只恢复进度，不自动播放
        if (resume < total - 2) {
          try {
            audio.currentTime = resume
          } catch {
            // 元数据刚就绪时个别浏览器仍拒绝定位，忽略即可
          }
          setCurrentTime(resume)
        }
      }
    }
    const onWaiting = () => {
      if (live.current.playing) setLoading(true)
    }
    const onPlaying = () => {
      progressAtRef.current = Date.now()
      // 每次重新出声都重置「稳定窗口」起点，但不清零重试计数（见 STABLE_MS 的说明）
      stableSinceRef.current = Date.now()
      setLoading(false)
    }
    const onCanPlay = () => setLoading(false)
    const onEnded = () => handleEnded()
    const onError = () => {
      // 只有正在播放时才自动重连；用户暂停时的错误留给手动操作
      if (!live.current.playing) {
        setLoading(false)
        return
      }
      scheduleRetry()
    }
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('waiting', onWaiting)
    audio.addEventListener('canplay', onCanPlay)
    audio.addEventListener('playing', onPlaying)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onError)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('waiting', onWaiting)
      audio.removeEventListener('canplay', onCanPlay)
      audio.removeEventListener('playing', onPlaying)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
    }
  }, [getAudio, handleEnded, scheduleRetry])

  // 卡死看门狗：播放中长时间无进度且未缓冲完成，主动重连
  useEffect(() => {
    const id = window.setInterval(() => {
      const audio = getAudio()
      if (!live.current.playing || audio.paused) return
      if (audio.readyState >= 3) return
      if (Date.now() - progressAtRef.current < STALL_MS) return
      scheduleRetry()
    }, 5000)
    return () => window.clearInterval(id)
  }, [getAudio, scheduleRetry])

  // 组件卸载时清掉重连定时器
  useEffect(() => () => clearRetryTimer(), [clearRetryTimer])

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
    const state = live.current
    if (!state.queue.length) return
    const result = advanceTrack({
      repeat: state.repeat,
      shuffle: state.shuffle,
      index: state.index,
      length: state.queue.length,
      played: playedRef.current,
    })
    if (result.kind === 'stop') {
      setPlayingBoth(false)
      return
    }
    playedRef.current.add(state.index)
    startAt(state.queue, result.index, { autoplay: true })
  }, [setPlayingBoth, startAt])

  const prev = useCallback(() => {
    const audio = getAudio()
    if (audio.currentTime > 4) {
      audio.currentTime = 0
      setCurrentTime(0)
      return
    }
    const state = live.current
    if (!state.queue.length) return
    const result = retreatTrack({ index: state.index, length: state.queue.length, repeat: state.repeat })
    if (result.kind === 'stop') return
    startAt(state.queue, result.index, { autoplay: state.playing })
  }, [getAudio, startAt])

  const toggle = useCallback(() => {
    if (!live.current.queue.length) return
    const audio = getAudio()
    if (live.current.playing) {
      setPlayingBoth(false)
      audio.pause()
      return
    }
    live.current.playing = true
    setPlaying(true)
    clearRetryTimer()
    retryCountRef.current = 0
    setRetrying(0)
    audioCtxRef.current?.resume().catch(() => undefined)
    void tryPlay()
  }, [clearRetryTimer, getAudio, setPlayingBoth, tryPlay])

  /** 手动重试：用户点击「重连」时立刻换签重载，不等退避 */
  const retryNow = useCallback(() => {
    const song = live.current.queue[live.current.index]
    if (!song) return
    const audio = getAudio()
    clearRetryTimer()
    retryCountRef.current = 0
    setRetrying(0)
    pendingSeekRef.current = audio.currentTime > 0 ? audio.currentTime : null
    epochRef.current += 1
    loadedCidRef.current = song.cid
    audio.src = `/api/audio/${song.cid}?r=${Date.now()}`
    audio.load()
    progressAtRef.current = Date.now()
    live.current.playing = true
    setPlaying(true)
    setLoading(true)
    void tryPlay()
  }, [clearRetryTimer, getAudio, tryPlay])

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
    live.current.volume = v
    if (v > 0) {
      live.current.muted = false
      setMuted(false)
    }
  }, [])

  const toggleShuffle = useCallback(() => {
    const next = !live.current.shuffle
    live.current.shuffle = next
    playedRef.current = new Set()
    setShuffle(next)
  }, [])

  const cycleRepeat = useCallback(() => {
    const next: RepeatMode = live.current.repeat === 'off' ? 'all' : live.current.repeat === 'all' ? 'one' : 'off'
    live.current.repeat = next
    playedRef.current = new Set()
    setRepeat(next)
  }, [])

  const enqueue = useCallback((songs: Song[]) => {
    const state = live.current
    const existing = new Set(state.queue.map((s) => s.cid))
    const additions = songs.filter((s) => !existing.has(s.cid))
    if (!additions.length) return
    const merged = [...state.queue, ...additions]
    live.current.queue = merged
    setQueue(merged)
  }, [])

  const removeFromQueue = useCallback(
    (cid: string) => {
      const state = live.current
      const at = state.queue.findIndex((s) => s.cid === cid)
      if (at === -1) return
      const nextQueue = state.queue.filter((s) => s.cid !== cid)
      if (!nextQueue.length) {
        live.current.queue = []
        setQueue([])
        setPlayingBoth(false)
        const audio = getAudio()
        audio.pause()
        audio.removeAttribute('src')
        loadedCidRef.current = null
        return
      }
      if (at === state.index) {
        // 删掉的正是当前曲目：接着放原位置的下一首
        playedRef.current = new Set()
        startAt(nextQueue, Math.min(at, nextQueue.length - 1), { autoplay: state.playing })
        return
      }
      const nextIndex = at < state.index ? state.index - 1 : state.index
      live.current.queue = nextQueue
      live.current.index = nextIndex
      setQueue(nextQueue)
      setIndex(nextIndex)
    },
    [getAudio, setPlayingBoth, startAt],
  )

  const value = useMemo<PlayerValue>(
    () => ({
      queue,
      index,
      current,
      playing,
      loading,
      retrying,
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
      toggleMute: () => {
        live.current.muted = !live.current.muted
        setMuted((m) => !m)
      },
      toggleShuffle,
      cycleRepeat,
      retryNow,
      enqueue,
      removeFromQueue,
    }),
    [
      queue, index, current, playing, loading, retrying, currentTime, duration, volume, muted,
      shuffle, repeat, lyrics, lyricLoading, analyser, contextLabel, playQueue, toggle, next, prev,
      seek, setVolume, toggleShuffle, cycleRepeat, retryNow, enqueue, removeFromQueue,
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
