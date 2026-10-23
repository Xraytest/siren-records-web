import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { IconCheck, IconDownload, IconEdit, IconGlobe, IconLogout, IconUpload, IconUser } from '../components/Icons'
import { useAuth } from '../state/AuthContext'
import { usePlaylists } from '../state/PlaylistContext'
import { openAuth } from '../lib/authDialog'
import { getSong } from '../lib/catalog'
import { downloadJson, exportPlaylists, parseImport } from '../lib/share'
import { formatDate } from '../lib/format'
import { toast } from '../lib/toast'

export function Account() {
  const { user, userCount, logout, updateProfile } = useAuth()
  const { playlists, feed, importMany } = usePlaylists()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(user?.name ?? '')
  const [bio, setBio] = useState(user?.bio ?? '')
  const fileRef = useRef<HTMLInputElement | null>(null)

  if (!user) {
    return (
      <div className="account-gate">
        <div className="account-gate-copy">
          <span className="kicker">ACCOUNT / 04</span>
          <h1>为这张唱片建立一份身份</h1>
          <p>
            账号、密码与歌单都保存在服务器上，换设备登录即可取回。密码以 scrypt 加盐哈希存储，从不保存明文。
          </p>
          <div className="hero-actions">
            <button className="btn btn--primary" onClick={() => openAuth('register')}>
              建立档案
            </button>
            <button className="btn" onClick={() => openAuth('login')}>
              已有账号，登录
            </button>
          </div>
          <div className="account-facts">
            <div>
              <strong className="mono">{String(userCount).padStart(2, '0')}</strong>
              <span>服务器已注册档案</span>
            </div>
            <div>
              <strong className="mono">SCRYPT</strong>
              <span>加盐密钥派生</span>
            </div>
            <div>
              <strong className="mono">SERVER</strong>
              <span>数据存于服务端</span>
            </div>
          </div>
        </div>
        <div className="account-gate-visual" aria-hidden="true">
          <div className="id-card">
            <span className="id-card-line" />
            <span className="id-card-brand">SIREN RECORDS</span>
            <span className="id-card-chip" />
            <span className="id-card-name">CALLSIGN</span>
            <span className="id-card-id mono">NO. 000-000-000</span>
            <span className="id-card-barcode" />
          </div>
        </div>
      </div>
    )
  }

  const totalSongs = playlists.reduce((n, p) => n + p.songs.length, 0)
  const published = playlists.filter((p) => p.publishedAt).length

  const startEdit = () => {
    setName(user.name)
    setBio(user.bio)
    setEditing(true)
  }

  const saveProfile = async () => {
    if (name.trim().length < 2) {
      toast('代号至少 2 个字符', 'warn')
      return
    }
    const result = await updateProfile({ name: name.trim(), bio: bio.trim() })
    if (!result.ok) {
      toast(result.error || '资料更新失败', 'warn')
      return
    }
    setEditing(false)
    toast('档案已更新', 'ok')
  }

  const backup = () => {
    downloadJson(`siren-account-${user.handle}.json`, {
      format: 'siren-account-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      profile: { name: user.name, bio: user.bio, createdAt: user.createdAt },
      playlists: exportPlaylists(playlists, getSong).playlists,
    })
    toast('账号数据已备份', 'ok')
  }

  const importFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const text = await file.text()
      const raw = JSON.parse(text) as { playlists?: unknown }
      const source = Array.isArray(raw.playlists) ? JSON.stringify(raw.playlists) : text
      const list = parseImport(source)
      if (!list.length) throw new Error('empty')
      const n = await importMany(list)
      toast(`已导入 ${n} 张歌单`, 'ok')
    } catch {
      toast('无法识别该备份文件', 'warn')
    }
  }

  return (
    <div className="account">
      <header className="profile">
        <div className="profile-avatar">
          <span>{user.name.slice(0, 1).toUpperCase()}</span>
          <span className="profile-avatar-ring" />
        </div>
        <div className="profile-main">
          <span className="kicker">CREW FILE / 已连接</span>
          <h1>{user.name}</h1>
          <p className="profile-bio">{user.bio || '还没有写下签名。'}</p>
          <div className="album-meta">
            <span className="mono">@{user.handle}</span>
            <span className="mono">ENLISTED {formatDate(user.createdAt)}</span>
            <span className="mono">SERVER PROFILE</span>
          </div>
          <div className="hero-actions">
            <button className="btn btn--sm" onClick={startEdit}>
              <IconEdit size={13} /> 编辑档案
            </button>
            <button className="btn btn--sm" onClick={backup}>
              <IconDownload size={13} /> 备份全部
            </button>
            <button className="btn btn--sm" onClick={() => fileRef.current?.click()}>
              <IconUpload size={13} /> 导入歌单
            </button>
            <button
              className="btn btn--sm btn--ghost"
              onClick={async () => {
                await logout()
                toast('已断开连接', 'info')
              }}
            >
              <IconLogout size={13} /> 退出
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
        </div>
      </header>

      <div className="profile-stats">
        <div>
          <span className="mono big">{String(playlists.length).padStart(2, '0')}</span>
          <span>歌单</span>
        </div>
        <div>
          <span className="mono big">{String(totalSongs).padStart(3, '0')}</span>
          <span>收录曲目</span>
        </div>
        <div>
          <span className="mono big">{String(published).padStart(2, '0')}</span>
          <span>已发布</span>
        </div>
        <div>
          <span className="mono big">{String(feed.filter((f) => f.authorId === user.id).length).padStart(2, '0')}</span>
          <span>广场条目</span>
        </div>
      </div>

      <section className="section section--tight">
        <header className="section-head">
          <div>
            <span className="kicker">YOUR PLAYLISTS</span>
            <h2>档案内的歌单</h2>
          </div>
          <Link to="/library" className="section-more">管理全部</Link>
        </header>
        {playlists.length ? (
          <div className="profile-playlists">
            {playlists.slice(0, 6).map((p) => (
              <Link key={p.id} to={`/playlist/${p.id}`} className="profile-playlist">
                <span className="mono">{String(p.songs.length).padStart(2, '0')} TR</span>
                <strong>{p.name}</strong>
                <small>{p.publishedAt ? '已发布 · ' : ''}{formatDate(p.updatedAt)}</small>
              </Link>
            ))}
          </div>
        ) : (
          <div className="empty-block">还没有歌单。<Link to="/library" className="text-link">去创建</Link></div>
        )}
      </section>

      <section className="section section--tight">
        <div className="privacy-note">
          <IconGlobe size={18} />
          <div>
            <strong>关于这套账号系统</strong>
            <p>
              账号、密码、歌单与广场条目都保存在服务端（SQLite），登录状态由 30 天有效的会话令牌维持。
              换设备或多浏览器登录都能取回同一份数据；「备份全部」仍可导出 JSON 作为离线留存。
            </p>
          </div>
          <span className="mono">SERVER / SQLITE</span>
        </div>
      </section>

      {editing && (
        <div className="modal-root" role="dialog" aria-modal="true">
          <button className="modal-backdrop" aria-label="关闭" onClick={() => setEditing(false)} />
          <div className="modal">
            <span className="corner corner--tl" />
            <span className="corner corner--br" />
            <header className="modal-head">
              <div>
                <div className="kicker">EDIT PROFILE</div>
                <h2>编辑档案</h2>
              </div>
            </header>
            <div className="modal-body">
              <div className="auth-form">
                <label>
                  <span>代号 / CALLSIGN</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label>
                  <span>签名 / BIO</span>
                  <textarea rows={4} value={bio} onChange={(e) => setBio(e.target.value)} placeholder="写一句留给档案的话。" />
                </label>
              </div>
            </div>
            <footer className="modal-foot">
              <button className="btn" onClick={() => setEditing(false)}>取消</button>
              <button className="btn btn--primary" onClick={saveProfile}>
                <IconCheck size={13} /> 保存
              </button>
            </footer>
          </div>
        </div>
      )}

      <div className="account-sign">
        <IconUser size={14} />
        <span>当前身份仅在本机有效 · {user.handle}</span>
      </div>
    </div>
  )
}
