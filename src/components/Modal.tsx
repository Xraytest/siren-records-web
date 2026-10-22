import { useEffect, type ReactNode } from 'react'
import { IconClose } from './Icons'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  kicker?: string
  children: ReactNode
  wide?: boolean
  footer?: ReactNode
}

export function Modal({ open, onClose, title, kicker, children, wide, footer }: ModalProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="modal-root" role="dialog" aria-modal="true" aria-label={title}>
      <button className="modal-backdrop" aria-label="关闭" onClick={onClose} />
      <div className={`modal ${wide ? 'modal--wide' : ''}`}>
        <span className="corner corner--tl" />
        <span className="corner corner--tr" />
        <span className="corner corner--bl" />
        <span className="corner corner--br" />
        <header className="modal-head">
          <div>
            {kicker && <div className="kicker">{kicker}</div>}
            <h2>{title}</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <IconClose size={16} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}
