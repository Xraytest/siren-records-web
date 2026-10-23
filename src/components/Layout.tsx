import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { AuthDialog } from './AuthDialog'
import { PlayerBar } from './PlayerBar'
import { SearchPalette } from './SearchPalette'
import { IconDisc, IconSearch, IconSliders, IconUser } from './Icons'
import { useAuth } from '../state/AuthContext'
import { useCatalog } from '../lib/catalog'
import { useAuthDialog } from '../lib/authDialog'
import { useToasts } from '../lib/toast'

const NAV = [
  { to: '/archive', label: '档案', en: 'ARCHIVE' },
  { to: '/library', label: '歌单', en: 'PLAYLISTS' },
  { to: '/explore', label: '广场', en: 'SQUARE' },
  { to: '/account', label: '账号', en: 'ACCOUNT' },
]

export function Layout() {
  const { user } = useAuth()
  const catalog = useCatalog()
  const { mode, close, setMode } = useAuthDialog()
  const [searchOpen, setSearchOpen] = useState(false)
  const location = useLocation()
  const toasts = useToasts()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
  }, [location.pathname])

  const tickerItems = catalog
    ? catalog.catalog.albums.slice(0, 14).map((a) => a.name)
    : ['MONSTER SIREN RECORDS', '塞壬唱片', 'ARCHIVE', 'UNAUTHORIZED FRONTEND']

  return (
    <div className="app">
      <div className="grain" aria-hidden="true" />
      <div className="scanline" aria-hidden="true" />

      <header className="topbar">
        <Link to="/" className="brand" aria-label="塞壬唱片非官方档案">
          <span className="brand-mark">
            <IconDisc size={20} />
          </span>
          <span className="brand-text">
            <strong>SIREN</strong>
            <span>RECORDS</span>
          </span>
          <em className="brand-tag">UNOFFICIAL</em>
        </Link>

        <nav className="nav">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? 'is-active' : '')}>
              <span className="nav-cn">{item.label}</span>
              <span className="nav-en">{item.en}</span>
            </NavLink>
          ))}
        </nav>

        <div className="topbar-actions">
          <button className="search-trigger" onClick={() => setSearchOpen(true)}>
            <IconSearch size={15} />
            <span>搜索曲目</span>
            <kbd>⌘K</kbd>
          </button>
          <Link to="/settings" className="icon-btn" title="设置" aria-label="设置">
            <IconSliders size={16} />
          </Link>
          {user ? (
            <Link to="/account" className="account-chip">
              <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
              <span className="account-chip-name">{user.name}</span>
            </Link>
          ) : (
            <button className="btn btn--ghost btn--sm" onClick={() => setMode('login')}>
              <IconUser size={14} /> 登录
            </button>
          )}
        </div>
      </header>

      <div className="ticker" aria-hidden="true">
        <div className="ticker-track">
          {[...tickerItems, ...tickerItems].map((item, i) => (
            <span key={i}>
              <i>◆</i> {item}
            </span>
          ))}
        </div>
      </div>

      <main className="page" key={location.pathname}>
        <Outlet />
      </main>

      <footer className="footer">
        <div className="footer-grid">
          <div>
            <div className="wordmark">SIREN<span>◆</span>RECORDS</div>
            <p>非官方前端档案。曲库、封面与音频版权归塞壬唱片 / 鹰角网络所有。</p>
          </div>
          <div className="footer-meta">
            <span>ARCHIVE BUILD / {catalog ? catalog.catalog.generatedAt.slice(0, 10).replace(/-/g, '.') : '——'}</span>
            <span>ALBUMS / {catalog ? catalog.catalog.albums.length : '···'}</span>
            <span>TRACKS / {catalog ? catalog.catalog.albums.reduce((n, a) => n + a.songs.length, 0) : '···'}</span>
          </div>
          <div className="footer-links">
            <a href="https://monster-siren.hypergryph.com" target="_blank" rel="noreferrer">
              官方站点 ↗
            </a>
            <Link to="/archive">全部专辑</Link>
            <Link to="/explore">公开歌单</Link>
            <Link to="/settings">偏好设置</Link>
          </div>
        </div>
      </footer>

      <PlayerBar />
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
      <AuthDialog mode={mode} onClose={close} onMode={setMode} />
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}
