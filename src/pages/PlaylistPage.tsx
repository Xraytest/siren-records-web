import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Modal } from '../components/Modal'
import { SongTable } from '../components/SongTable'
import {
  IconCheck, IconDownload, IconEdit, IconGlobe, IconPlay, IconPlus, IconSearch, IconShare, IconTrash,
} from '../components/Icons'
import { useAuth } from '../state/AuthContext'
import { usePlaylists } from '../state/PlaylistContext'
import { usePlayer } from '../state/PlayerContext'
import { useCatalog } from '../lib/catalog'
import { formatDate } from '../lib/format'
import { downloadJson, encodeShare, exportPlaylists, payloadOf, shareUrl } from '../lib/share'
import { getSong } from '../lib/catalog'
import { toast } from '../lib/toast'
import type { Song } from '../lib/types'

export function PlaylistPage() {
  const { id } = useParams()
  const { user } = useAuth()
  const { playlists, update, remove, removeSong, moveSong, addSongs, publish, unpublish } = usePlaylists()
  const { playQueue } = usePlayer()
  const catalog = useCatalog()
  const navigate = useNavigate()

  const playlist = playlists.find((p) => p.id === id)
  const songs = useMemo(
    () =>
      playlist
        ? playlist.songs.map((cid) => catalog?.songs.get(cid)).filter((s): s is Song => Boolean(s))
        : [],
    [playlist, catalog],
  )

  const [editing, setEditing] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [publishOpen, setPublishOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [form, setForm] = useState({ name: '', description: '', tags: '' })

  if (!playlist) {
    return (
      <div className="empty-block">
        歌单不存在或已被删除。<Link to="/library" className="text-link">返回歌单</Link>
      </div>
    )
  }

  const shareCode = encodeShare(payloadOf(playlist, user?.name ?? '匿名'))
  const link = shareUrl(shareCode)

  const startEdit = () => {
    setForm({ name: playlist.name, description: playlist.description, tags: playlist.tags.join(' ') })
    setEditing(true)
  }

  const saveEdit = async () => {
    await update(playlist.id, {
      name: form.name.trim() || '未命名歌单',
      description: form.description.trim(),
      tags: form.tags.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean).slice(0, 6),
    })
    setEditing(false)
    toast('歌单信息已更新', 'ok')
  }

  const doPublish = async () => {
    const entry = await publish(playlist.id)
    if (entry) {
      toast('已发布到公开广场', 'ok')
      setPublishOpen(false)
    }
  }

  const doExport = () => {
    downloadJson(`siren-playlist-${playlist.name}.json`, exportPlaylists([playlist], getSong))
    toast('已导出 JSON 文件', 'ok')
  }

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast(`${label}已复制`, 'ok')
    } catch {
      toast('复制失败，请手动选择文本', 'warn')
    }
  }

  return (
    <div className="playlist-page">
      <nav className="crumbs">
        <Link to="/library">歌单</Link>
        <span>/</span>
        <span>{playlist.name}</span>
      </nav>

      <header className="playlist-hero">
        <div className="playlist-hero-art">
          {songs.length ? (
            <MosaicLarge songs={songs.slice(0, 4)} />
          ) : (
            <span className="playlist-hero-blank mono">EMPTY PLAYLIST</span>
          )}
          {playlist.publishedAt && <span className="badge badge--accent">已发布</span>}
        </div>
        <div className="playlist-hero-copy">
          <span className="kicker">PLAYLIST / {playlist.tags[0]?.toUpperCase() || 'PRIVATE'}</span>
          <h1>{playlist.name}</h1>
          <p className="album-intro">{playlist.description || '这张歌单还没有描述。'}</p>
          <div className="album-meta">
            <span>{songs.length} 首曲目</span>
            <span className="mono">CREATED {formatDate(playlist.createdAt)}</span>
            <span className="mono">BY {user?.name ?? '匿名'}</span>
          </div>
          <div className="playlist-hero-tags">
            {playlist.tags.map((t) => (
              <span key={t}>#{t}</span>
            ))}
          </div>
          <div className="hero-actions">
            <button
              className="btn btn--primary"
              onClick={() => songs.length && playQueue(songs, 0, playlist.name)}
              disabled={!songs.length}
            >
              <IconPlay size={13} /> 播放
            </button>
            <button className="btn" onClick={() => setPickerOpen(true)}>
              <IconPlus size={14} /> 添加曲目
            </button>
            <button className="btn" onClick={() => setShareOpen(true)}>
              <IconShare size={14} /> 分享
            </button>
            <button className="btn" onClick={() => setPublishOpen(true)}>
              <IconGlobe size={14} /> {playlist.publishedAt ? '发布管理' : '发布'}
            </button>
            <button className="btn btn--ghost" onClick={doExport}>
              <IconDownload size={14} /> 导出
            </button>
            <button className="icon-btn" onClick={startEdit} title="编辑信息">
              <IconEdit size={15} />
            </button>
            <button
              className="icon-btn"
              title="删除歌单"
              onClick={async () => {
                if (confirm(`删除《${playlist.name}》？`)) {
                  if (await remove(playlist.id)) navigate('/library')
                }
              }}
            >
              <IconTrash size={15} />
            </button>
          </div>
        </div>
      </header>

      <section className="section section--tight">
        <header className="section-head">
          <div>
            <span className="kicker">TRACKLIST</span>
            <h2>曲目编排</h2>
          </div>
          <span className="mono">{String(songs.length).padStart(2, '0')} TRACKS</span>
        </header>
        <SongTable
          songs={songs}
          label={playlist.name}
          showAlbum
          onRemove={(cid) => void removeSong(playlist.id, cid)}
          onMove={(i, dir) => void moveSong(playlist.id, i, i + dir)}
          empty={
            <span>
              歌单还是空的。<button className="text-link" onClick={() => setPickerOpen(true)}>添加曲目</button>
            </span>
          }
        />
      </section>

      <Modal
        open={editing}
        onClose={() => setEditing(false)}
        kicker="EDIT PLAYLIST"
        title="编辑歌单"
        footer={
          <>
            <button className="btn" onClick={() => setEditing(false)}>取消</button>
            <button className="btn btn--primary" onClick={saveEdit}>保存</button>
          </>
        }
      >
        <div className="auth-form">
          <label>
            <span>名称</span>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            <span>描述</span>
            <textarea
              rows={4}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </label>
          <label>
            <span>标签</span>
            <input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
          </label>
        </div>
      </Modal>

      <Modal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        kicker="SHARE / 分享"
        title="把歌单交出去"
        wide
        footer={
          <button className="btn" onClick={() => setShareOpen(false)}>关闭</button>
        }
      >
        <p className="hint">
          分享链接内嵌了完整歌单数据，无需服务器即可跨设备打开。收到链接的人可以一键保存成自己的歌单。
        </p>
        <div className="copy-field">
          <span className="mono">LINK</span>
          <input readOnly value={link} onFocus={(e) => e.target.select()} />
          <button className="btn btn--primary btn--sm" onClick={() => copy(link, '链接')}>
            复制
          </button>
        </div>
        <div className="copy-field">
          <span className="mono">CODE</span>
          <input readOnly value={shareCode} onFocus={(e) => e.target.select()} />
          <button className="btn btn--sm" onClick={() => copy(shareCode, '分享码')}>
            复制
          </button>
        </div>
        <div className="share-preview">
          <span className="share-preview-label mono">PREVIEW</span>
          <strong>{playlist.name}</strong>
          <small>{playlist.description || '没有描述'}</small>
          <small className="mono">{playlist.songs.length} TRACKS · BY {user?.name}</small>
        </div>
      </Modal>

      <Modal
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        kicker="PUBLISH / 发布"
        title={playlist.publishedAt ? '已发布到广场' : '发布到公开广场'}
        footer={
          playlist.publishedAt ? (
            <>
              <button
                className="btn"
                onClick={() => {
                  void unpublish(playlist.id)
                  toast('已从广场撤下', 'info')
                  setPublishOpen(false)
                }}
              >
                撤下
              </button>
              <button className="btn btn--primary" onClick={doPublish}>
                更新发布内容
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => setPublishOpen(false)}>取消</button>
              <button className="btn btn--primary" onClick={doPublish}>
                确认发布
              </button>
            </>
          )
        }
      >
        <p className="hint">
          发布后，歌单会以只读形式出现在公开广场，并生成分享码。广场索引保存在本机浏览器中——这是无后端版本的取舍，导入分享码仍然可以跨设备传播歌单。
        </p>
        {playlist.publishedAt && (
          <div className="publish-status">
            <IconCheck size={16} />
            <span>发布于 {formatDate(playlist.publishedAt)} · 分享码已生成</span>
          </div>
        )}
        <div className="publish-facts">
          <span>曲目 <em className="mono">{playlist.songs.length}</em></span>
          <span>标签 <em className="mono">{playlist.tags.length}</em></span>
          <span>作者 <em>{user?.name}</em></span>
        </div>
      </Modal>

      <SongPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        existing={playlist.songs}
        onAdd={async (cids) => {
          const added = await addSongs(playlist.id, cids)
          if (added === null) return
          toast(added ? `已添加 ${added} 首曲目` : '这些曲目已在歌单中', added ? 'ok' : 'info')
          setPickerOpen(false)
        }}
      />
    </div>
  )
}

function MosaicLarge({ songs }: { songs: Song[] }) {
  return (
    <span className={`mosaic mosaic--${Math.min(songs.length, 4)} mosaic--lg`}>
      {songs.map((s) => (
        <img key={s.cid} src={s.albumCover} alt="" loading="lazy" />
      ))}
    </span>
  )
}

function SongPicker({
  open,
  onClose,
  existing,
  onAdd,
}: {
  open: boolean
  onClose: () => void
  existing: string[]
  onAdd: (cids: string[]) => void
}) {
  const catalog = useCatalog()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>([])

  const results = useMemo(() => {
    const pool = catalog?.all ?? []
    const q = query.trim().toLowerCase()
    const list = q
      ? pool.filter((s) => s.name.toLowerCase().includes(q) || s.artistes.toLowerCase().includes(q) || s.albumName.toLowerCase().includes(q))
      : pool
    return list.slice(0, 40)
  }, [catalog, query])

  if (!open) return null

  const toggle = (cid: string) => setSelected((s) => (s.includes(cid) ? s.filter((x) => x !== cid) : [...s, cid]))

  return (
    <Modal
      open={open}
      onClose={onClose}
      kicker="ADD TRACKS"
      title="添加曲目"
      wide
      footer={
        <>
          <span className="hint hint--xs">已选 {selected.length} 首</span>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn--primary" disabled={!selected.length} onClick={() => onAdd(selected)}>
            加入歌单
          </button>
        </>
      }
    >
      <label className="field field--search">
        <IconSearch size={15} />
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索曲目 / 音乐人 / 专辑…" />
      </label>
      <div className="picker-list">
        {results.map((s) => {
          const already = existing.includes(s.cid)
          const on = selected.includes(s.cid)
          return (
            <button
              key={s.cid}
              className={`picker-row ${on ? 'is-on' : ''} ${already ? 'is-disabled' : ''}`}
              disabled={already}
              onClick={() => toggle(s.cid)}
            >
              <span className="picker-cover">
                <img src={s.albumCover} alt="" loading="lazy" />
              </span>
              <span className="picker-meta">
                <strong>{s.name}</strong>
                <small>{s.artistes} · {s.albumName}</small>
              </span>
              <span className="picker-mark">
                {already ? <span className="mono">已存在</span> : on ? <IconCheck size={14} /> : <IconPlus size={14} />}
              </span>
            </button>
          )
        })}
        {!results.length && <div className="empty-block">没有匹配的曲目。</div>}
      </div>
    </Modal>
  )
}
