import { Link } from 'react-router-dom'
import type { Album } from '../lib/types'

export function AlbumTile({ album, index }: { album: Album; index?: number }) {
  return (
    <Link to={`/album/${album.cid}`} className="album-tile">
      <span className="album-tile-art">
        <img src={album.coverUrl} alt={album.name} loading="lazy" />
        <span className="album-tile-veil" />
        {index !== undefined && <span className="album-tile-index mono">{String(index + 1).padStart(3, '0')}</span>}
        <span className="album-tile-go">ENTER ↗</span>
      </span>
      <span className="album-tile-meta">
        <strong>{album.name}</strong>
        <small>{album.artistes.join(' / ') || '塞壬唱片-MSR'}</small>
      </span>
      <span className="album-tile-line" />
    </Link>
  )
}
