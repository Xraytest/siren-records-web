import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlbumTile } from '../components/AlbumTile'
import { IconGrid, IconPlay, IconSearch } from '../components/Icons'
import { useCatalog } from '../lib/catalog'
import { padIndex } from '../lib/format'
import { usePlayer } from '../state/PlayerContext'

type Sort = 'default' | 'name' | 'tracks'

export function Archive() {
  const catalog = useCatalog()
  const { playQueue } = usePlayer()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('default')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [limit, setLimit] = useState(24)

  const albums = useMemo(() => {
    const base = catalog?.catalog.albums ?? []
    const q = query.trim().toLowerCase()
    const filtered = q
      ? base.filter(
          (a) =>
            a.name.toLowerCase().includes(q) ||
            a.artistes.join(' ').toLowerCase().includes(q) ||
            a.songs.some((s) => s.name.toLowerCase().includes(q)),
        )
      : [...base]
    if (sort === 'name') filtered.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    if (sort === 'tracks') filtered.sort((a, b) => b.songs.length - a.songs.length)
    return filtered
  }, [catalog, query, sort])

  const shuffleAll = () => {
    const pool = catalog?.all.filter((s) => s.sourceUrl) ?? []
    if (!pool.length) return
    const picked = [...pool].sort(() => Math.random() - 0.5).slice(0, 30)
    playQueue(picked, 0, '档案随机 30')
  }

  return (
    <div className="archive">
      <header className="page-head">
        <div>
          <span className="kicker">ARCHIVE / 01</span>
          <h1>全部档案</h1>
          <p className="page-sub">
            自 2019 年起，塞壬唱片发行的全部专辑都在这里。按名称、曲目数量重新编排，或直接进入检索。
          </p>
        </div>
        <div className="page-head-side">
          <span className="mono big">{String(albums.length).padStart(3, '0')}</span>
          <span className="mono">ALBUMS INDEXED</span>
        </div>
      </header>

      <div className="toolbar">
        <label className="field field--search">
          <IconSearch size={15} />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setLimit(24)
            }}
            placeholder="搜索专辑或曲目…"
          />
          {query && <button className="field-clear" onClick={() => setQuery('')}>清除</button>}
        </label>
        <div className="toolbar-right">
          <div className="seg seg--sm">
            <button className={sort === 'default' ? 'is-on' : ''} onClick={() => setSort('default')}>最新</button>
            <button className={sort === 'name' ? 'is-on' : ''} onClick={() => setSort('name')}>名称</button>
            <button className={sort === 'tracks' ? 'is-on' : ''} onClick={() => setSort('tracks')}>曲目数</button>
          </div>
          <button className="icon-btn" onClick={() => setView(view === 'grid' ? 'list' : 'grid')} title="切换视图">
            <IconGrid size={16} />
          </button>
          <button className="btn btn--sm" onClick={shuffleAll}>
            <IconPlay size={12} /> 随机 30 首
          </button>
        </div>
      </div>

      {!catalog && <div className="empty-block">正在读取曲库档案…</div>}

      {catalog && view === 'grid' && (
        <>
          <div className="album-grid album-grid--dense">
            {albums.slice(0, limit).map((album) => (
              <AlbumTile key={album.cid} album={album} />
            ))}
          </div>
          {albums.length > limit && (
            <div className="load-more">
              <button className="btn" onClick={() => setLimit((l) => l + 24)}>
                载入更多 · 剩余 {albums.length - limit}
              </button>
            </div>
          )}
        </>
      )}

      {catalog && view === 'list' && (
        <div className="album-list">
          {albums.slice(0, limit).map((album, i) => (
            <Link to={`/album/${album.cid}`} key={album.cid} className="album-list-row">
              <span className="mono">{padIndex(i)}</span>
              <img src={album.coverUrl} alt="" loading="lazy" />
              <span className="album-list-name">
                <strong>{album.name}</strong>
                <small>{album.artistes.join(' / ')}</small>
              </span>
              <span className="mono album-list-count">{album.songs.length} TRACKS</span>
              <span className="mono album-list-id">#{album.cid}</span>
            </Link>
          ))}
          {albums.length > limit && (
            <div className="load-more">
              <button className="btn" onClick={() => setLimit((l) => l + 24)}>
                载入更多 · 剩余 {albums.length - limit}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
