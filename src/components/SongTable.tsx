import { useState, type ReactNode } from 'react'
import { AddToPlaylist } from './AddToPlaylist'
import { IconPause, IconPlay, IconPlus, IconTrash, IconDown, IconUp } from './Icons'
import { padIndex } from '../lib/format'
import { usePlayer } from '../state/PlayerContext'
import { useAuth } from '../state/AuthContext'
import { openAuth } from '../lib/authDialog'
import type { Song } from '../lib/types'

interface Props {
  songs: Song[]
  label: string
  showAlbum?: boolean
  onRemove?: (cid: string) => void
  onMove?: (index: number, dir: -1 | 1) => void
  empty?: ReactNode
}

export function SongTable({ songs, label, showAlbum, onRemove, onMove, empty }: Props) {
  const { playQueue, current, playing, toggle } = usePlayer()
  const { user } = useAuth()
  const [picked, setPicked] = useState<Song | null>(null)

  if (!songs.length) {
    return <div className="empty-block">{empty ?? '这里还没有曲目。'}</div>
  }

  return (
    <>
      <div className="song-table">
        <div className="song-head">
          <span>#</span>
          <span>曲目 / TRACK</span>
          {showAlbum && <span>所属专辑</span>}
          <span className="song-head-actions">操作</span>
        </div>
        {songs.map((song, i) => {
          const active = current?.cid === song.cid
          return (
            <div className={`song-row ${active ? 'is-active' : ''}`} key={`${song.cid}-${i}`}>
              <button
                className="song-index"
                aria-label={active && playing ? '暂停' : '播放'}
                onClick={() => (active ? toggle() : playQueue(songs, i, label))}
              >
                <span className="song-num">{active && playing ? <Bars /> : padIndex(i)}</span>
              </button>
              <div className="song-main">
                <div className="song-title">
                  <button
                    className="song-name"
                    onClick={() => (active ? toggle() : playQueue(songs, i, label))}
                  >
                    {song.name}
                  </button>
                  <span className="song-play-mark">
                    {active && playing ? <IconPause size={12} /> : <IconPlay size={12} />}
                  </span>
                </div>
                <div className="song-sub">
                  <span>{song.artistes}</span>
                  <span className="dot">·</span>
                  <span className="mono">WAV / {song.cid}</span>
                </div>
              </div>
              {showAlbum && (
                <div className="song-album">
                  <img src={song.albumCover} alt="" loading="lazy" />
                  <span>{song.albumName}</span>
                </div>
              )}
              <div className="song-actions">
                {onMove && (
                  <>
                    <button
                      className="icon-btn icon-btn--sm"
                      title="上移"
                      disabled={i === 0}
                      onClick={() => onMove(i, -1)}
                    >
                      <IconUp size={13} />
                    </button>
                    <button
                      className="icon-btn icon-btn--sm"
                      title="下移"
                      disabled={i === songs.length - 1}
                      onClick={() => onMove(i, 1)}
                    >
                      <IconDown size={13} />
                    </button>
                  </>
                )}
                <button
                  className="icon-btn icon-btn--sm"
                  title="加入歌单"
                  onClick={() => (user ? setPicked(song) : openAuth('login'))}
                >
                  <IconPlus size={13} />
                </button>
                {onRemove && (
                  <button className="icon-btn icon-btn--sm" title="移出歌单" onClick={() => onRemove(song.cid)}>
                    <IconTrash size={13} />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <AddToPlaylist song={picked} onClose={() => setPicked(null)} />
    </>
  )
}

function Bars() {
  return (
    <span className="bars" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  )
}
