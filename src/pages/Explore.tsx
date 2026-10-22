import { Link } from 'react-router-dom'
import { IconArrow, IconGlobe, IconPlay, IconShare } from '../components/Icons'
import { usePlaylists } from '../state/PlaylistContext'
import { usePlayer } from '../state/PlayerContext'
import { decodeShare } from '../lib/share'
import { formatRelative } from '../lib/format'
import { loadCatalog } from '../lib/catalog'
import type { FeedItem, Song } from '../lib/types'
import { useState } from 'react'
import { toast } from '../lib/toast'

export function Explore() {
  const { feed } = usePlaylists()
  const { playQueue } = usePlayer()
  const [busy, setBusy] = useState<string | null>(null)

  const playFeed = async (item: FeedItem) => {
    setBusy(item.code)
    const payload = decodeShare(item.code)
    if (!payload) {
      toast('分享码已损坏', 'warn')
      setBusy(null)
      return
    }
    const catalog = await loadCatalog()
    const songs = payload.songs.map((cid) => catalog.songs.get(cid)).filter((s): s is Song => Boolean(s))
    if (!songs.length) {
      toast('曲库中找不到这些曲目', 'warn')
      setBusy(null)
      return
    }
    playQueue(songs, 0, `广场 · ${item.name}`)
    setBusy(null)
  }

  return (
    <div className="explore">
      <header className="page-head">
        <div>
          <span className="kicker">PUBLIC SQUARE / 03</span>
          <h1>公开广场</h1>
          <p className="page-sub">
            所有人发布的歌单都会汇入这里。点击卡片即可试听，或打开分享页保存到自己的账号。
          </p>
        </div>
        <div className="page-head-side">
          <span className="mono big">{String(feed.length).padStart(2, '0')}</span>
          <span className="mono">PUBLISHED</span>
        </div>
      </header>

      {feed.length === 0 ? (
        <div className="square-empty">
          <div className="square-empty-visual" aria-hidden="true">
            <IconGlobe size={48} />
            <span />
            <span />
          </div>
          <h2>广场目前没有歌单</h2>
          <p>把一张歌单发布出来，它会成为第一块石碑。</p>
          <div className="hero-actions">
            <Link to="/library" className="btn btn--primary">
              去发布 <IconArrow size={13} />
            </Link>
            <Link to="/archive" className="btn">
              浏览档案
            </Link>
          </div>
          <div className="square-steps">
            <div>
              <span className="mono">01</span>
              <strong>创建</strong>
              <p>在歌单里挑选曲目并排序、命名。</p>
            </div>
            <div>
              <span className="mono">02</span>
              <strong>发布</strong>
              <p>生成只读快照与分享码。</p>
            </div>
            <div>
              <span className="mono">03</span>
              <strong>传播</strong>
              <p>任何人凭链接都能保存这张歌单。</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="feed-grid">
          {feed.map((item, i) => (
            <article className="feed-card" key={item.code}>
              <div className="feed-card-art">
                {item.cover ? <img src={item.cover} alt="" loading="lazy" /> : <span className="mono">SIREN</span>}
                <span className="feed-card-index mono">{String(i + 1).padStart(2, '0')}</span>
                <button className="feed-card-play" onClick={() => void playFeed(item)} disabled={busy === item.code}>
                  <IconPlay size={16} />
                </button>
              </div>
              <div className="feed-card-body">
                <div className="feed-card-head">
                  <h3>{item.name}</h3>
                  <span className="mono">{item.songCount} TR</span>
                </div>
                <p>{item.description || '发布者没有留下说明。'}</p>
                <div className="feed-card-tags">
                  {item.tags.slice(0, 3).map((t) => <span key={t}>#{t}</span>)}
                </div>
                <div className="feed-card-foot">
                  <span>{item.authorName} · {formatRelative(item.at)}</span>
                  <Link to={`/share/${item.code}`} className="text-link">
                    <IconShare size={12} /> 打开分享页
                  </Link>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
