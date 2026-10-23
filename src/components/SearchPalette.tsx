import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconArrow, IconDisc, IconSearch } from './Icons'
import { useCatalog, searchAll } from '../lib/catalog'
import { useSettings } from '../lib/settings'
import { usePlayer } from '../state/PlayerContext'

export function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const catalog = useCatalog()
  const { hideInstrumental } = useSettings()
  const { playQueue } = usePlayer()
  const navigate = useNavigate()

  const result = useMemo(() => searchAll(query, hideInstrumental), [query, catalog, hideInstrumental])
  const rows = useMemo(
    () => [
      ...result.albums.map((a) => ({ kind: 'album' as const, key: a.cid, title: a.name, sub: a.artistes.join(' / ') })),
      ...result.songs.map((s) => ({ kind: 'song' as const, key: s.cid, title: s.name, sub: `${s.artistes} · ${s.albumName}` })),
    ],
    [result],
  )

  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
      setTimeout(() => inputRef.current?.focus(), 40)
    }
  }, [open])

  useEffect(() => {
    setCursor(0)
  }, [query])

  if (!open) return null

  const activate = (i: number) => {
    const row = rows[i]
    if (!row) return
    if (row.kind === 'album') {
      navigate(`/album/${row.key}`)
    } else {
      const song = result.songs[i - result.albums.length]
      if (song) {
        const queue = result.songs
        playQueue(queue, queue.indexOf(song), `搜索 · ${query}`)
      }
    }
    onClose()
  }

  return (
    <div className="palette-root" role="dialog" aria-modal="true" aria-label="搜索曲库">
      <button className="palette-backdrop" aria-label="关闭搜索" onClick={onClose} />
      <div className="palette">
        <div className="palette-input">
          <IconSearch size={18} />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索专辑、曲目或音乐人…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setCursor((c) => Math.min(c + 1, rows.length - 1))
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setCursor((c) => Math.max(c - 1, 0))
              }
              if (e.key === 'Enter') activate(cursor)
            }}
          />
          <kbd>ESC</kbd>
        </div>
        <div className="palette-body">
          {!query && (
            <div className="palette-hint">
              <span className="kicker">INDEX / 检索</span>
              <p>输入关键词，回车直接播放曲目。共 {catalog ? catalog.all.length : '···'} 首曲目可检索。</p>
              <div className="palette-suggests">
                {['塞壬唱片-MSR', 'Instrumental', 'OST', 'Arknights'].map((tag) => (
                  <button key={tag} onClick={() => setQuery(tag)}>
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          )}
          {query && rows.length === 0 && <div className="palette-empty">没有匹配的档案条目。</div>}
          {rows.map((row, i) => (
            <button
              key={`${row.kind}-${row.key}`}
              className={`palette-row ${i === cursor ? 'is-cursor' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => activate(i)}
            >
              <span className="palette-kind">{row.kind === 'album' ? <IconDisc size={15} /> : <span className="mono">{String(i + 1).padStart(2, '0')}</span>}</span>
              <span className="palette-meta">
                <strong>{row.title}</strong>
                <small>{row.sub}</small>
              </span>
              <span className="palette-type">{row.kind === 'album' ? 'ALBUM' : 'TRACK'}</span>
              <IconArrow size={14} />
            </button>
          ))}
        </div>
        <div className="palette-foot">
          <span>↑↓ 选择 · ENTER 确认 · ESC 关闭</span>
          <span className="mono">SIREN ARCHIVE</span>
        </div>
      </div>
    </div>
  )
}
