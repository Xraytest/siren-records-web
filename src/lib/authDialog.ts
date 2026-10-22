import { useEffect, useState } from 'react'

type Mode = 'login' | 'register'

const EVENT = 'siren:auth-request'

export function openAuth(mode: Mode = 'login') {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: mode }))
}

export function useAuthDialog() {
  const [open, setOpen] = useState<Mode | null>(null)
  useEffect(() => {
    const handler = (e: Event) => setOpen((e as CustomEvent<Mode>).detail ?? 'login')
    window.addEventListener(EVENT, handler)
    return () => window.removeEventListener(EVENT, handler)
  }, [])
  return { mode: open, close: () => setOpen(null), setMode: (m: Mode) => setOpen(m) }
}
