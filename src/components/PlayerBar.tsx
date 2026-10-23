import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  IconClose, IconDown, IconLyrics, IconMute, IconNext, IconPause, IconPlay, IconPlus, IconPrev,
  IconQueue, IconRepeat, IconRepeatOne, IconShuffle, IconTrash, IconVolume,
} from './Icons'
import { AddToPlaylist } from './AddToPlaylist'
import { formatDuration } from '../lib/format'
import { usePlayer } from '../state/PlayerContext'
import { useAuth } from '../state/AuthContext'
import { openAuth } from '../lib/authDialog'
import type { Song } from '../lib/types'

export function PlayerBar() {
  const p = usePlayer()
  const { user } = useAuth()
  const [expanded, setExpanded] = useState(false)
  const [panel, setPanel] = useState<'lyrics' | 'queue'>('lyrics')
  const [hovering, setHovering] = useState(false)
  const [picked, setPicked] = useState<Song | null>(null)

  const progress = p.duration > 0 ? (p.currentTime / p.duration) * 100 : 0

  if (!p.current) return null

  const collect = (song: Song) => {
    if (!user) {
      openAuth('login')
      return
    }
    setPicked(song)
  }

  return (
    <>
      <div className={`playerbar ${hovering ? 'is-hot' : ''}`} onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)}>
        <div className="playerbar-progress">
          <div className="playerbar-progress-fill" style={{ width: `${progress}%` }} />
          <input
            className="playerbar-seek"
            type="range"
            min={0}
            max={p.duration || 0}
            step={0.1}
            value={Math.min(p.currentTime, p.duration || 0)}
            onChange={(e) => p.seek(Number(e.target.value))}
            aria-label="播放进度"
          />
        </div>
        <div className="playerbar-inner">
          <button className="playerbar-track" onClick={() => setExpanded(true)}>
            <span className="playerbar-cover">
              <img src={p.current.albumCover} alt="" />
              <span className="playerbar-cover-wire" />
            </span>
            <span className="playerbar-meta">
              <strong>{p.current.name}</strong>
              <small>
                {p.current.artistes} · {p.contextLabel || p.current.albumName}
              </small>
            </span>
          </button>

          <div className="playerbar-controls">
            <button className={`icon-btn ${p.shuffle ? 'is-on' : ''}`} onClick={p.toggleShuffle} title="随机播放">
              <IconShuffle size={16} />
            </button>
            <button className="icon-btn" onClick={p.prev} title="上一首">
              <IconPrev size={16} />
            </button>
            <button className="play-btn" onClick={p.toggle} aria-label={p.playing ? '暂停' : '播放'}>
              {p.playing ? <IconPause size={18} /> : <IconPlay size={18} />}
            </button>
            <button className="icon-btn" onClick={p.next} title="下一首">
              <IconNext size={16} />
            </button>
            <button
              className={`icon-btn ${p.repeat !== 'off' ? 'is-on' : ''}`}
              onClick={p.cycleRepeat}
              title={`循环：${p.repeat === 'off' ? '关闭' : p.repeat === 'all' ? '列表' : '单曲'}`}
            >
              {p.repeat === 'one' ? <IconRepeatOne size={16} /> : <IconRepeat size={16} />}
            </button>
          </div>

          <div className="playerbar-extras">
            <span className="playerbar-time mono">
              {formatDuration(p.currentTime)} / {formatDuration(p.duration)}
            </span>
            <button className="icon-btn" onClick={() => p.setVolume(p.volume > 0 ? 0 : 0.8)} title="音量">
              {p.muted || p.volume === 0 ? <IconMute size={16} /> : <IconVolume size={16} />}
            </button>
            <input
              className="volume"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={p.muted ? 0 : p.volume}
              onChange={(e) => p.setVolume(Number(e.target.value))}
              aria-label="音量"
            />
            <button className="icon-btn" onClick={() => { setPanel('lyrics'); setExpanded(true) }} title="歌词">
              <IconLyrics size={16} />
            </button>
            <button className="icon-btn" onClick={() => collect(p.current as Song)} title="加入歌单">
              <IconPlus size={16} />
            </button>
            <button className="icon-btn" onClick={() => { setPanel('queue'); setExpanded(true) }} title="播放队列">
              <IconQueue size={16} />
            </button>
            <Visualizer analyser={p.analyser} active={p.playing} />
          </div>
        </div>
      </div>

      {expanded && (
        <div className="player-view">
          <div className="player-view-bg" style={{ backgroundImage: `url(${p.current.albumCover})` }} />
          <header className="player-view-head">
            <div>
              <div className="kicker">NOW PLAYING / 正在播放</div>
              <h2>{p.current.name}</h2>
            </div>
            <button className="icon-btn" onClick={() => setExpanded(false)} aria-label="收起">
              <IconDown size={18} />
            </button>
          </header>
          <div className="player-view-body">
            <div className="player-view-art">
              <img src={p.current.albumCover} alt={p.current.albumName} />
              <div className="player-view-art-meta">
                <span>{p.current.albumName}</span>
                <Link to={`/album/${p.current.albumCid}`} onClick={() => setExpanded(false)}>
                  查看专辑
                </Link>
              </div>
            </div>
            <div className="player-view-panel">
              <div className="seg">
                <button className={panel === 'lyrics' ? 'is-on' : ''} onClick={() => setPanel('lyrics')}>歌词</button>
                <button className={panel === 'queue' ? 'is-on' : ''} onClick={() => setPanel('queue')}>队列 {p.queue.length}</button>
              </div>
              {panel === 'lyrics' ? <Lyrics /> : <QueuePanel onCollect={collect} />}
            </div>
          </div>
          <div className="player-view-foot">
            <span className="mono">{p.current.artistes}</span>
            <span className="mono">{p.current.cid}</span>
            <button className="btn btn--ghost" onClick={() => setExpanded(false)}>
              <IconClose size={13} /> 收起
            </button>
          </div>
        </div>
      )}
      <AddToPlaylist songs={picked ? [picked] : []} onClose={() => setPicked(null)} />
    </>
  )
}

function Lyrics() {
  const { lyrics, currentTime, lyricLoading, current, seek } = usePlayer()
  const activeRef = useRef<HTMLParagraphElement | null>(null)
  const active = useMemo(() => {
    let idx = -1
    for (let i = 0; i < lyrics.length; i++) {
      if (lyrics[i].time <= currentTime + 0.2) idx = i
      else break
    }
    return idx
  }, [lyrics, currentTime])

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [active])

  if (lyricLoading) return <div className="lyrics-empty">正在载入歌词…</div>
  if (!lyrics.length) {
    return (
      <div className="lyrics-empty">
        <IconLyrics size={28} />
        <p>暂无歌词</p>
        <small>{current?.name} 未提供歌词或为纯音乐</small>
      </div>
    )
  }

  return (
    <div className="lyrics">
      {lyrics.map((line, i) => (
        <p
          key={`${line.time}-${i}`}
          ref={i === active ? activeRef : null}
          className={i === active ? 'is-active' : ''}
          onClick={() => seek(line.time)}
        >
          {line.text || '♪'}
        </p>
      ))}
    </div>
  )
}

function QueuePanel({ onCollect }: { onCollect: (song: Song) => void }) {
  const { queue, index, playQueue, removeFromQueue, contextLabel } = usePlayer()
  return (
    <div className="queue">
      <div className="queue-head">
        <span>{contextLabel || '播放队列'}</span>
        <span className="mono">{queue.length} TRACKS</span>
      </div>
      {queue.map((song, i) => (
        <div key={`${song.cid}-${i}`} className={`queue-row ${i === index ? 'is-active' : ''}`}>
          <button className="queue-main" onClick={() => playQueue(queue, i, contextLabel)}>
            <span className="mono">{String(i + 1).padStart(2, '0')}</span>
            <span>
              <strong>{song.name}</strong>
              <small>{song.artistes}</small>
            </span>
          </button>
          <button className="icon-btn icon-btn--sm" onClick={() => onCollect(song)} title="加入歌单">
            <IconPlus size={13} />
          </button>
          <button className="icon-btn icon-btn--sm" onClick={() => removeFromQueue(song.cid)} title="移除">
            <IconTrash size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}

function Visualizer({ analyser, active }: { analyser: AnalyserNode | null; active: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0
    const data = analyser ? new Uint8Array(analyser.frequencyBinCount) : null
    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const w = 64
      const h = 28
      if (canvas.width !== w * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = active ? 'rgba(160,237,255,0.85)' : 'rgba(160,237,255,0.25)'
      const bars = 16
      if (analyser && data) {
        analyser.getByteFrequencyData(data)
        for (let i = 0; i < bars; i++) {
          const v = data[Math.floor((i / bars) * 60)] / 255
          const barH = Math.max(1.5, v * h)
          ctx.fillRect(i * 4, h - barH, 2, barH)
        }
      } else {
        const t = Date.now() / 400
        for (let i = 0; i < bars; i++) {
          const v = active ? (Math.sin(t + i * 0.7) + 1) / 2 * 0.7 + 0.15 : 0.12
          const barH = Math.max(1.5, v * h)
          ctx.fillRect(i * 4, h - barH, 2, barH)
        }
      }
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [analyser, active])
  return <canvas ref={ref} className="viz" width={64} height={28} aria-hidden="true" />
}
