import { useEffect, useState } from 'react'

export type ToastKind = 'info' | 'ok' | 'warn'

export interface ToastItem {
  id: number
  text: string
  kind: ToastKind
}

let seq = 0
const listeners = new Set<(items: ToastItem[]) => void>()
let items: ToastItem[] = []

function emit() {
  for (const listener of listeners) listener([...items])
}

export function toast(text: string, kind: ToastKind = 'info') {
  const item = { id: ++seq, text, kind }
  items = [...items, item]
  emit()
  setTimeout(() => {
    items = items.filter((t) => t.id !== item.id)
    emit()
  }, 2800)
}

export function useToasts() {
  const [list, setList] = useState<ToastItem[]>(items)
  useEffect(() => {
    listeners.add(setList)
    return () => {
      listeners.delete(setList)
    }
  }, [])
  return list
}
