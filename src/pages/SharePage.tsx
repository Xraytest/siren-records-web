import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { IconCheck, IconDownload, IconPlay, IconShare, IconUser } from '../components/Icons'
import { decodeShare, downloadJson, encodeShare } from '../lib/share'
import { useAuth } from '../state/AuthContext'
import { usePlaylists } from '../state/PlaylistContext'
import { usePlayer } from '../state/PlayerContext'
import { useCatalog } from '../lib/catalog'
import { openAuth } from '../lib/authDialog'
import { formatDate } from '../lib/format'
import { toast } from '../lib/toast'
import type { Song } from '../lib/types'

export function SharePage() {
  const { code = '' } = useParams()
  const payload = useMemo(() => decodeShare(code), [code])
  const catalog = useCatalog()
  const { user } = useAuth()
  const { playlists, saveShared } = usePlaylists()
  const { playQueue } = usePlayer()
  const navigate = useNavigate()
  const [copied, setCopied] = useState(false)

  const songs = useMemo(
    () =>
      payload
        ? payload.songs.map((cid) => catalog?.songs.get(cid)).filter((s): s is Song => Boolean(s))
        : [],
    [payload, catalog],
  )

  if (!payload) {
    return (
      <div className="login-gate">
        <span className="kicker">INVALID LINK / 损坏的链接</span>
        <h1>分享码无法解析</h1>
        <p>链接可能被截断，或来自旧版本。请向分享者索取完整链接。</p>
        <Link to="/explore" className="btn btn--primary">前往广场</Link>
      </div>
    )
  }

  const save = () => {
    if (!user) return openAuth('register')
    const playlist = saveShared(payload)
    toast(`已保存《${playlist.name}》到歌单`, 'ok')
    navigate(`/playlist/${playlist.id}`)
  }

  const forkAndEdit = () => {
    if (!user) return openAuth('register')
    const playlist = saveShared(payload)
    navigate(`/playlist/${playlist.id}`)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(location.href)
      setCopied(true)
      toast('链接已复制', 'ok')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast('复制失败', 'warn')
    }
  }

  const own = playlists.some((p) => p.name === payload.name && p.songs.join() === payload.songs.join())

  return (
    <div className="share-page">
      <div className="share-hero">
        <div className="share-art">
          {songs[0] ? <img src={songs[0].albumCover} alt="" /> : <span className="mono">SIREN</span>}
          <span className="badge">SHARED PLAYLIST</span>
        </div>
        <div className="share-copy">
          <span className="kicker">INCOMING TRANSMISSION / 有人交给你一张歌单</span>
          <h1>{payload.name}</h1>
          <p className="album-intro">{payload.desc || '分享者没有留下说明。'}</p>
          <div className="album-meta">
            <span>{payload.songs.length} 首曲目</span>
            <span className="mono">FROM {payload.author}</span>
            <span className="mono">{formatDate(payload.at)}</span>
          </div>
          <div className="playlist-hero-tags">
            {payload.tags.map((t) => <span key={t}>#{t}</span>)}
          </div>
          <div className="hero-actions">
            <button className="btn btn--primary" onClick={save} disabled={own}>
              {own ? <><IconCheck size={14} /> 已保存</> : <><IconDownload size={14} /> 保存到我的歌单</>}
            </button>
            <button
              className="btn"
              onClick={() => songs.length && playQueue(songs, 0, `分享 · ${payload.name}`)}
              disabled={!songs.length}
            >
              <IconPlay size={13} /> 试听
            </button>
            <button className="btn btn--ghost" onClick={copy}>
              <IconShare size={13} /> {copied ? '已复制' : '复制链接'}
            </button>
            {own && (
              <button className="btn btn--ghost" onClick={forkAndEdit}>
                再存一份
              </button>
            )}
          </div>
          <p className="hint hint--xs">
            保存后可以自由编辑、排序、再次发布。原始分享码保持不变。
          </p>
        </div>
      </div>

      <section className="section section--tight">
        <header className="section-head">
          <div>
            <span className="kicker">TRANSMISSION CONTENT</span>
            <h2>歌单内容</h2>
          </div>
          <span className="mono">{songs.length} / {payload.songs.length} 解析成功</span>
        </header>
        <div className="share-tracks">
          {songs.map((s, i) => (
            <button key={`${s.cid}-${i}`} className="share-track" onClick={() => playQueue(songs, i, payload.name)}>
              <span className="mono">{String(i + 1).padStart(2, '0')}</span>
              <img src={s.albumCover} alt="" loading="lazy" />
              <span>
                <strong>{s.name}</strong>
                <small>{s.artistes} · {s.albumName}</small>
              </span>
              <IconPlay size={13} />
            </button>
          ))}
          {!songs.length && <div className="empty-block">曲库中未能匹配这些曲目，可能来自更旧的版本。</div>}
        </div>
        {payload.songs.length !== songs.length && (
          <p className="hint hint--xs">
            有 {payload.songs.length - songs.length} 首曲目在当前曲库中不存在，保存时会自动跳过。
          </p>
        )}
      </section>

      <div className="share-footnote">
        <IconUser size={14} />
        <span>
          收到歌单的是你：{user ? user.name : '未登录的访客'}。分享码 <span className="mono">{code.slice(0, 18)}…</span>
        </span>
        <button
          className="text-link"
          onClick={() => downloadJson(`siren-shared-${payload.name}.json`, { code, ...payload })}
        >
          下载原始数据
        </button>
        <span className="mono">RE-ENCODE {encodeShare(payload).length} CHARS</span>
      </div>
    </div>
  )
}
