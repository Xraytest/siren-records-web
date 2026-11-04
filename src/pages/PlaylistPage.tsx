import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Modal } from '../components/Modal'
import { SongTable } from '../components/SongTable'
import {
  IconCheck, IconDownload, IconEdit, IconPlay, IconPlus, IconSearch, IconShare, IconTrash,
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

  // 曲目排列模式：自定义 = 手动顺序（可上移/下移），其余只是展示/播放顺序，不改服务端数据
  const [order, setOrder] = useState<'custom' | 'name' | 'album' | 'artist'>('custom')
  const ordered = useMemo(() => {
    if (order === 'custom') return songs
    const list = [...songs]
    const byName = (a: Song, b: Song) => a.name.localeCompare(b.name, 'zh-Hans-CN')
    if (order === 'name') list.sort(byName)
    if (order === 'album') list.sort((a, b) => a.albumName.localeCompare(b.albumName, 'zh-Hans-CN') || byName(a, b))
    if (order === 'artist') list.sort((a, b) => a.artistes.localeCompare(b.artistes, 'zh-Hans-CN') || byName(a, b))
    return list
  }, [songs, order])

  const [editing, setEditing] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
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

  // 私人 ⇄ 公开：公开即发布到广场（含分享码），私人即撤下
  const doPublish = async () => {
    const entry = await publish(playlist.id)
    if (entry) {
      toast(playlist.publishedAt ? '广场内容已更新' : '已设为公开 · 已发布到公开广场', 'ok')
    }
  }

  const doUnpublish = async () => {
    if (!playlist.publishedAt) return
    // 分享码是自包含的（整套歌单压缩在码里），撤下广场只清掉 feed 行，
    // 已经发出去的链接仍然能打开 —— 文案必须说清楚，否则用户会以为撤回后旧链接也失效了
    if (
      !confirm(
        `将《${playlist.name}》设为私人？\n\n它会从公开广场撤下，只有你自己能看到。\n注意：已经发出去的分享链接里内嵌了完整歌单内容，撤下广场不会让旧链接失效。`,
      )
    )
      return
    await unpublish(playlist.id)
    toast('已设为私人 · 已从广场撤下（已发出的分享链接仍可打开）', 'info')
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
          {playlist.publishedAt && <span className="badge badge--accent">公开</span>}
        </div>
        <div className="playlist-hero-copy">
          <span className="kicker">PLAYLIST / {playlist.publishedAt ? 'PUBLIC' : playlist.tags[0]?.toUpperCase() || 'PRIVATE'}</span>
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
              onClick={() => songs.length && playQueue(ordered, 0, playlist.name)}
              disabled={!songs.length}
            >
              <IconPlay size={13} /> 播放
            </button>
            <button className="btn" onClick={() => setPickerOpen(true)}>
              <IconPlus size={14} /> 加入歌单
            </button>
            <button className="btn" onClick={() => setShareOpen(true)}>
              <IconShare size={14} /> 分享
            </button>
            <div className="seg seg--sm" title="歌单可见性：私人仅自己可见，公开进入公开广场">
              <button className={playlist.publishedAt ? '' : 'is-on'} onClick={doUnpublish}>私人</button>
              <button className={playlist.publishedAt ? 'is-on' : ''} onClick={doPublish}>公开</button>
            </div>
            {playlist.publishedAt && (
              <button className="btn" onClick={doPublish} title="把当前曲目与信息重新推送至公开广场">
                更新广场内容
              </button>
            )}
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
          <div className="section-head-side">
            <div className="seg seg--sm" aria-label="曲目排列模式">
              <button className={order === 'custom' ? 'is-on' : ''} onClick={() => setOrder('custom')} title="按歌单里的手动顺序">
                自定义
              </button>
              <button className={order === 'name' ? 'is-on' : ''} onClick={() => setOrder('name')}>名称</button>
              <button className={order === 'album' ? 'is-on' : ''} onClick={() => setOrder('album')}>专辑</button>
              <button className={order === 'artist' ? 'is-on' : ''} onClick={() => setOrder('artist')}>演唱者</button>
            </div>
            <span className="mono">{String(songs.length).padStart(2, '0')} TRACKS</span>
          </div>
        </header>
        <SongTable
          songs={ordered}
          label={playlist.name}
          showAlbum
          onRemove={(cid) => void removeSong(playlist.id, cid)}
          // 只有「自定义」顺序才能手动上移/下移：排序视图里挪动会让人误以为改的是显示顺序
          onMove={
            order === 'custom'
              ? (i, dir) => {
                  // 表格显示的是「曲库能解析到」的子集，下标与 playlist.songs 不一定对齐；
                  // 直接拿显示下标去 splice 会移动错曲目。用 cid 找回原始位置再交换。
                  const fromCid = songs[i]?.cid
                  const toCid = songs[i + dir]?.cid
                  if (!fromCid || !toCid) return
                  const from = playlist.songs.indexOf(fromCid)
                  const to = playlist.songs.indexOf(toCid)
                  if (from < 0 || to < 0) return
                  void moveSong(playlist.id, from, to)
                }
              : undefined
          }
          empty={
            <span>
              歌单还是空的。<button className="text-link" onClick={() => setPickerOpen(true)}>加入歌单</button>
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

      <SongPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        existing={playlist.songs}
        onAdd={async (cids) => {
          const added = await addSongs(playlist.id, cids)
          if (added === null) return
          toast(added ? `已加入 ${added} 首曲目` : '这些曲目已在歌单中', added ? 'ok' : 'info')
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
      kicker="ADD TO PLAYLIST"
      title="加入歌单"
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
