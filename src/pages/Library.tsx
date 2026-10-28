import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Modal } from '../components/Modal'
import { IconCheck, IconDownload, IconPlus, IconTrash, IconUpload, IconPlay, IconGlobe } from '../components/Icons'
import { useAuth } from '../state/AuthContext'
import { usePlaylists } from '../state/PlaylistContext'
import { openAuth } from '../lib/authDialog'
import { getSong } from '../lib/catalog'
import { downloadJson, exportPlaylists, parseImport } from '../lib/share'
import { formatRelative } from '../lib/format'
import { toast } from '../lib/toast'

export function Library() {
  const { user } = useAuth()
  const { playlists, create, remove, importMany } = usePlaylists()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [tags, setTags] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)

  if (!user) {
    return (
      <div className="login-gate">
        <span className="kicker">ACCESS DENIED / 需要身份</span>
        <h1>构建你的专属声学序列</h1>
        <p>自由跨专辑挑曲、重排轨序、命名封存。支持一键发布至公共信标，或导出为本地便携档案文件。</p>
        <div className="hero-actions">
          <button className="btn btn--primary" onClick={() => openAuth('register')}>
            登记船员身份
          </button>
          <button className="btn" onClick={() => openAuth('login')}>
            已有身份登录
          </button>
        </div>
      </div>
    )
  }

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    const playlist = await create({
      name: trimmed,
      description: desc.trim(),
      tags: tags.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean).slice(0, 5),
    })
    if (!playlist) return
    setCreating(false)
    setName('')
    setDesc('')
    setTags('')
    navigate(`/playlist/${playlist.id}`)
  }

  const importFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const list = parseImport(await file.text())
      if (!list.length) throw new Error('empty')
      const n = await importMany(list)
      toast(`✓ 已解析并载入 ${n} 组声学序列，轨序完整还原`, 'ok')
    } catch {
      toast('档案无法解析：需要包含 songs 列表的歌单文件，或他人分享的快照码', 'warn')
    }
  }

  const exportAll = () => {
    if (!playlists.length) return
    downloadJson(`siren-playlists-${user.handle}.json`, exportPlaylists(playlists, getSong))
    toast('✓ 歌单档案已封装导出。可用于离线备份，或发送给其他博士直接导入', 'ok')
  }

  return (
    <div className="library">
      <header className="page-head">
        <div>
          <span className="kicker">PLAYLISTS / 02</span>
          <h1>我的歌单</h1>
          <p className="page-sub">
            <strong>100% 自由流转的私人声学序列。</strong>
            跨专辑挑曲、重排轨序、命名封存。你的歌单不被任何单一平台绑架——支持随时导出为便携档案文件离线保存、一键导入还原，或生成只读快照与分享码跨端传递。
          </p>
        </div>
        <div className="toolbar-right">
          <button className="btn btn--sm" onClick={() => fileRef.current?.click()}>
            <IconUpload size={13} /> 📥 导入档案 / 分享码
          </button>
          <button className="btn btn--sm" onClick={exportAll} disabled={!playlists.length}>
            <IconDownload size={13} /> 📤 导出便携文件
          </button>
          <button className="btn btn--primary btn--sm" onClick={() => setCreating(true)}>
            <IconPlus size={13} /> 新建序列
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              void importFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </div>
      </header>

      <div className="playlist-grid">
        <button className="playlist-card playlist-card--new" onClick={() => setCreating(true)}>
          <span className="playlist-new-plus">
            <IconPlus size={22} />
          </span>
          <strong>新建歌单</strong>
          <small>从空白频段开始编织</small>
        </button>

        {playlists.map((p) => (
          <div key={p.id} className="playlist-card">
            <Link to={`/playlist/${p.id}`} className="playlist-card-art playlist-card-art--link">
              {p.songs.length ? (
                <Mosaic cids={p.songs.slice(0, 4)} />
              ) : (
                <span className="playlist-card-blank mono">EMPTY</span>
              )}
            </Link>
            <div className="playlist-card-body">
              <Link to={`/playlist/${p.id}`} className="playlist-card-title">
                <strong>{p.name}</strong>
              </Link>
              <small>
                {p.songs.length} 首 · {formatRelative(p.updatedAt)}
                {p.publishedAt ? ' · 已发布' : ''}
              </small>
              <div className="playlist-card-tags">
                {p.tags.slice(0, 3).map((t) => (
                  <span key={t}>#{t}</span>
                ))}
              </div>
              <div className="playlist-card-actions">
                <Link to={`/playlist/${p.id}`} className="icon-btn icon-btn--sm" title="打开">
                  <IconPlay size={13} />
                </Link>
                {p.publishedAt && (
                  <Link to="/explore" className="icon-btn icon-btn--sm" title="已发布">
                    <IconGlobe size={13} />
                  </Link>
                )}
                <button
                  className="icon-btn icon-btn--sm"
                  title="删除"
                  onClick={async () => {
                    if (confirm(`删除《${p.name}》？此操作不可撤销。`)) {
                      if (await remove(p.id)) toast('歌单已删除', 'ok')
                    }
                  }}
                >
                  <IconTrash size={13} />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {!playlists.length && (
        <div className="empty-block">
          还没有声学序列。新建一张，或从
          <Link to="/archive" className="text-link">档案</Link>
          里把喜欢的专辑整张收进来。
        </div>
      )}

      <section className="section section--tight">
        <div className="settings-note">
          <span className="kicker">档案迁移协议 // IMPORT &amp; EXPORT</span>
          <ul>
            <li>
              <IconCheck size={13} />
              <span>
                <strong>导出便携档案</strong>：文件包含完整曲目映射与排序结构，可跨账号、跨设备离线流转。
                存进网盘即永久备份，直接丢进群聊即可互传。
              </span>
            </li>
            <li>
              <IconCheck size={13} />
              <span>
                <strong>一键导入还原</strong>：导入时自动校验文件结构，并匹配站内 911 首无损曲库，轨序与封面原样恢复。
              </span>
            </li>
            <li>
              <IconCheck size={13} />
              <span>
                <strong>云端与本地双保险</strong>：歌单同时存于你的船员档案（换设备登录即可取回）与本地文件中，任一失效都不丢失。
              </span>
            </li>
          </ul>
        </div>
      </section>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        kicker="NEW PLAYLIST"
        title="新建声学序列"
        footer={
          <>
            <button className="btn" onClick={() => setCreating(false)}>取消</button>
            <button className="btn btn--primary" onClick={submit}>创建</button>
          </>
        }
      >
        <div className="auth-form">
          <label>
            <span>名称 / NAME</span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：深夜航路" />
          </label>
          <label>
            <span>描述 / NOTE</span>
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} placeholder="这张歌单关于什么？" />
          </label>
          <label>
            <span>标签 / TAGS</span>
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="用空格或逗号分隔" />
          </label>
        </div>
      </Modal>
    </div>
  )
}

function Mosaic({ cids }: { cids: string[] }) {
  const covers = cids.map((cid) => getSong(cid)?.albumCover).filter(Boolean) as string[]
  if (covers.length === 1) {
    return <img className="mosaic-solo" src={covers[0]} alt="" loading="lazy" />
  }
  return (
    <span className={`mosaic mosaic--${covers.length}`}>
      {covers.map((src, i) => (
        <img key={i} src={src} alt="" loading="lazy" />
      ))}
    </span>
  )
}
