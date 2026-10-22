import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Modal } from './Modal'
import { IconPlus } from './Icons'
import { useAuth } from '../state/AuthContext'
import { usePlaylists } from '../state/PlaylistContext'
import { toast } from '../lib/toast'
import type { Song } from '../lib/types'

interface Props {
  song: Song | null
  onClose: () => void
}

export function AddToPlaylist({ song, onClose }: Props) {
  const { user } = useAuth()
  const { playlists, create, addSongs } = usePlaylists()
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)

  if (!song) return null

  const add = (id: string, label: string) => {
    const added = addSongs(id, [song.cid])
    toast(added ? `已加入《${label}》` : `《${label}》中已存在该曲目`, added ? 'ok' : 'info')
    onClose()
  }

  const submitNew = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    const playlist = create({ name: trimmed, songs: [song.cid], coverSongCid: song.cid })
    toast(`已创建《${playlist.name}》并加入`, 'ok')
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      kicker="ADD TO PLAYLIST"
      title={song.name}
      footer={
        !user ? (
          <Link className="btn btn--primary" to="/account">
            前往登录
          </Link>
        ) : (
          <button className="btn" onClick={() => setCreating((v) => !v)}>
            <IconPlus size={14} /> 新建歌单
          </button>
        )
      }
    >
      {!user ? (
        <p className="hint">歌单属于账号资产，登录后即可把曲目收进自己的歌单。</p>
      ) : (
        <>
          {creating && (
            <div className="inline-form">
              <input
                autoFocus
                value={name}
                placeholder="歌单名称"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitNew()}
              />
              <button className="btn btn--primary" onClick={submitNew}>
                创建
              </button>
            </div>
          )}
          <div className="pick-list">
            {playlists.length === 0 && <p className="hint">还没有歌单，先新建一个。</p>}
            {playlists.map((p) => (
              <button key={p.id} className="pick-row" onClick={() => add(p.id, p.name)}>
                <span className="pick-cover">
                  {p.coverSongCid ? (
                    <img src={song.albumCover} alt="" />
                  ) : (
                    <span className="pick-empty" />
                  )}
                </span>
                <span className="pick-meta">
                  <strong>{p.name}</strong>
                  <small>{p.songs.length} 首曲目</small>
                </span>
                <span className="pick-add">
                  <IconPlus size={14} />
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}
