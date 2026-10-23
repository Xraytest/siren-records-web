import { useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { SongTable } from '../components/SongTable'
import { IconArrow, IconPlus, IconPlay } from '../components/Icons'
import { useCatalog } from '../lib/catalog'
import { useAuth } from '../state/AuthContext'
import { usePlaylists } from '../state/PlaylistContext'
import { usePlayer } from '../state/PlayerContext'
import { toast } from '../lib/toast'
import { openAuth } from '../lib/authDialog'
import { useNavigate } from 'react-router-dom'

export function AlbumPage() {
  const { cid } = useParams()
  const catalog = useCatalog()
  const { playQueue } = usePlayer()
  const { user } = useAuth()
  const { create } = usePlaylists()
  const navigate = useNavigate()

  const album = cid ? catalog?.albums.get(cid) : undefined
  const songs = useMemo(
    () => (album ? album.songs.map((ref) => catalog?.songs.get(ref.cid)).filter(Boolean) : []),
    [album, catalog],
  )

  if (!catalog) return <div className="empty-block">正在读取档案…</div>
  if (!album) return <div className="empty-block">找不到这张专辑。<Link to="/archive" className="text-link">返回档案</Link></div>

  const trackList = songs as NonNullable<typeof songs[number]>[]

  const collect = async () => {
    if (!user) return openAuth('register')
    const playlist = await create({
      name: album.name,
      description: `自《${album.name}》收录的整张专辑。`,
      songs: album.songs.map((s) => s.cid),
      coverSongCid: album.songs[0]?.cid ?? null,
      tags: ['整张专辑'],
    })
    if (!playlist) return
    toast(`已建歌单《${playlist.name}》`, 'ok')
    navigate(`/playlist/${playlist.id}`)
  }

  return (
    <div className="album-page">
      <nav className="crumbs">
        <Link to="/archive">档案</Link>
        <span>/</span>
        <span>{album.name}</span>
      </nav>

      <header className="album-hero">
        <div className="album-hero-art">
          <img src={album.coverDeUrl || album.coverUrl} alt={album.name} />
          <span className="album-hero-frame" />
          <span className="mono album-hero-id">NO. {album.cid}</span>
        </div>
        <div className="album-hero-copy">
          <span className="kicker">ALBUM / {album.belong.toUpperCase()}</span>
          <h1>{album.name}</h1>
          <p className="album-artistes">{album.artistes.join(' / ') || '塞壬唱片-MSR'}</p>
          <p className="album-intro">{album.intro || '暂无专辑简介。'}</p>
          <div className="album-meta">
            <span>
              <em className="mono">{album.songs.length}</em> 首曲目
            </span>
            <span>
              <em className="mono">{album.songs.filter((s) => catalog.songs.get(s.cid)?.lyricUrl).length}</em> 首带歌词
            </span>
            <span className="mono">CAT #{album.cid}</span>
          </div>
          <div className="hero-actions">
            <button
              className="btn btn--primary"
              onClick={() => trackList.length && playQueue(trackList, 0, album.name)}
            >
              <IconPlay size={13} /> 播放整张
            </button>
            <button className="btn" onClick={collect}>
              <IconPlus size={14} /> 收进歌单
            </button>
            <a className="btn btn--ghost" href={`https://monster-siren.hypergryph.com/album/${album.cid}`} target="_blank" rel="noreferrer">
              官方页 <IconArrow size={13} />
            </a>
          </div>
        </div>
      </header>

      <section className="section section--tight">
        <header className="section-head">
          <div>
            <span className="kicker">TRACKLIST</span>
            <h2>曲目</h2>
          </div>
          <span className="mono">{String(album.songs.length).padStart(2, '0')} TRACKS</span>
        </header>
        <SongTable songs={trackList} label={album.name} />
      </section>
    </div>
  )
}
