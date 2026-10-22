import { Link, useNavigate } from 'react-router-dom'
import { AlbumTile } from '../components/AlbumTile'
import { IconArrow, IconGlobe, IconPlay, IconPlus } from '../components/Icons'
import { useCatalog } from '../lib/catalog'
import { formatRelative } from '../lib/format'
import { useAuth } from '../state/AuthContext'
import { usePlaylists } from '../state/PlaylistContext'
import { usePlayer, useSongs } from '../state/PlayerContext'

export function Home() {
  const catalog = useCatalog()
  const { user } = useAuth()
  const { playlists, feed, create } = usePlaylists()
  const { playQueue } = usePlayer()
  const navigate = useNavigate()

  const albums = catalog?.catalog.albums ?? []
  const latest = albums.slice(0, 9)
  const feature = albums[0]

  const mySongs = useSongs(playlists[0]?.songs ?? [])

  const startFeatured = () => {
    if (!feature) return
    const songs = catalog?.all.filter((s) => s.albumCid === feature.cid) ?? []
    if (songs.length) playQueue(songs, 0, feature.name)
  }

  const quickPlaylist = () => {
    if (!user) {
      navigate('/account')
      return
    }
    const pool = (catalog?.all ?? []).filter((s) => s.sourceUrl)
    const picks = Array.from({ length: 8 }, () => pool[Math.floor(Math.random() * pool.length)]).filter(Boolean)
    const unique = Array.from(new Map(picks.map((s) => [s.cid, s])).values())
    const date = new Date()
    const name = `漂流采样 ${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`
    const playlist = create({ name, description: '从曲库随机抽取的八首曲子，密封于此刻。', songs: unique.map((s) => s.cid), tags: ['随机', '采样'] })
    navigate(`/playlist/${playlist.id}`)
  }

  return (
    <div className="home">
      <section className="hero">
        <div className="hero-grid">
          <div className="hero-copy">
            <div className="kicker">MONSTER SIREN RECORDS — UNOFFICIAL ARCHIVE</div>
            <h1 className="hero-title">
              <span>SIREN</span>
              <span className="outline">RECORDS</span>
            </h1>
            <p className="hero-lead">
              一座为塞壬唱片建立的私人档案室。检索 {catalog ? catalog.catalog.albums.length : '···'} 张专辑、
              {catalog ? catalog.all.length : '···'} 首曲目，把它们编排成属于你的歌单，再交给下一个人。
            </p>
            <div className="hero-actions">
              <Link to="/archive" className="btn btn--primary">
                进入档案 <IconArrow size={14} />
              </Link>
              <Link to="/library" className="btn">
                我的歌单
              </Link>
            </div>
            <div className="hero-metrics">
              <div>
                <strong className="mono">{catalog ? catalog.catalog.albums.length : '—'}</strong>
                <span>ALBUMS</span>
              </div>
              <div>
                <strong className="mono">{catalog ? catalog.all.length : '—'}</strong>
                <span>TRACKS</span>
              </div>
              <div>
                <strong className="mono">{playlists.length}</strong>
                <span>PLAYLISTS</span>
              </div>
              <div>
                <strong className="mono">{feed.length}</strong>
                <span>PUBLISHED</span>
              </div>
            </div>
          </div>

          {feature && (
            <div className="hero-art">
              <div className="hero-art-frame">
                <img src={feature.coverUrl} alt={feature.name} />
                <span className="hero-art-tl">LATEST / 最新</span>
                <span className="hero-art-id mono">#{feature.cid}</span>
              </div>
              <div className="hero-art-meta">
                <div>
                  <span className="kicker">NOW IN ARCHIVE</span>
                  <h3>{feature.name}</h3>
                  <p>{feature.artistes.join(' / ') || '塞壬唱片-MSR'}</p>
                </div>
                <div className="hero-art-actions">
                  <button className="play-btn play-btn--lg" onClick={startFeatured} aria-label="播放最新专辑">
                    <IconPlay size={18} />
                  </button>
                  <Link className="text-link" to={`/album/${feature.cid}`}>
                    专辑详情
                  </Link>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="section">
        <header className="section-head">
          <div>
            <span className="kicker">01 / LATEST RELEASES</span>
            <h2>最新入库</h2>
          </div>
          <Link to="/archive" className="section-more">
            全部档案 <IconArrow size={13} />
          </Link>
        </header>
        <div className="album-grid">
          {latest.map((album, i) => (
            <AlbumTile key={album.cid} album={album} index={i} />
          ))}
        </div>
      </section>

      <section className="section">
        <header className="section-head">
          <div>
            <span className="kicker">02 / PLAYLISTS</span>
            <h2>{user ? '你的歌单' : '歌单系统'}</h2>
          </div>
          <Link to="/library" className="section-more">
            管理歌单 <IconArrow size={13} />
          </Link>
        </header>
        {user && playlists.length > 0 ? (
          <div className="playlist-strip">
            {playlists.slice(0, 4).map((p) => (
              <Link to={`/playlist/${p.id}`} key={p.id} className="playlist-card">
                <span className="playlist-card-art">
                  {p.songs.slice(0, 4).map((cid) => {
                    const s = catalog?.songs.get(cid)
                    return s ? <img key={cid} src={s.albumCover} alt="" loading="lazy" /> : null
                  })}
                  {p.songs.length === 1 && <img className="solo" src={catalog?.songs.get(p.songs[0])?.albumCover} alt="" />}
                </span>
                <strong>{p.name}</strong>
                <small>{p.songs.length} 首曲目 · {formatRelative(p.updatedAt)}</small>
              </Link>
            ))}
            <button className="playlist-card playlist-card--new" onClick={quickPlaylist}>
              <span className="playlist-new-plus">
                <IconPlus size={22} />
              </span>
              <strong>即刻生成一张</strong>
              <small>随机采样八首，写成新歌单</small>
            </button>
          </div>
        ) : (
          <div className="playlist-empty">
            <div className="playlist-empty-copy">
              <p>登录后即可创建歌单：挑曲、排序、命名、发布，也能把歌单导出成一份可携带的文件。</p>
              <div className="hero-actions">
                {user ? (
                  <Link to="/library" className="btn btn--primary">
                    <IconPlus size={14} /> 新建歌单
                  </Link>
                ) : (
                  <Link to="/account" className="btn btn--primary">
                    建立账号 <IconArrow size={14} />
                  </Link>
                )}
                <button className="btn" onClick={quickPlaylist}>
                  随机采样生成
                </button>
              </div>
            </div>
            <div className="playlist-empty-preview" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="ghost-card" style={{ '--i': i } as React.CSSProperties}>
                  <span />
                  <span />
                  <span />
                </div>
              ))}
            </div>
          </div>
        )}
        {mySongs.length > 0 && (
          <button className="queue-cta" onClick={() => playQueue(mySongs, 0, playlists[0]?.name ?? '歌单')}>
            <IconPlay size={13} /> 播放《{playlists[0]?.name}》
          </button>
        )}
      </section>

      <section className="section">
        <header className="section-head">
          <div>
            <span className="kicker">03 / PUBLIC SQUARE</span>
            <h2>公开歌单</h2>
          </div>
          <Link to="/explore" className="section-more">
            进入广场 <IconGlobe size={13} />
          </Link>
        </header>
        {feed.length ? (
          <div className="feed-preview">
            {feed.slice(0, 3).map((item) => (
              <Link to={`/share/${item.code}`} key={item.code} className="feed-mini">
                <span className="feed-mini-cover">
                  {item.cover ? <img src={item.cover} alt="" loading="lazy" /> : <span className="mono">SIREN</span>}
                </span>
                <span className="feed-mini-meta">
                  <strong>{item.name}</strong>
                  <small>
                    {item.authorName} · {item.songCount} 首 · {formatRelative(item.at)}
                  </small>
                </span>
                <IconArrow size={14} />
              </Link>
            ))}
          </div>
        ) : (
          <div className="empty-block">
            广场尚未有人留下歌单。<Link to="/library" className="text-link">创建一张</Link>并发布，它会出现在这里。
          </div>
        )}
      </section>
    </div>
  )
}
