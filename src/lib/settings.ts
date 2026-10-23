import { useSyncExternalStore } from 'react'

export interface Settings {
  /** 隐藏被识别为伴奏的曲目 */
  hideInstrumental: boolean
}

const KEY = 'siren:settings'
const DEFAULTS: Settings = { hideInstrumental: false }

function read(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    return { ...DEFAULTS }
  }
}

let current: Settings = read()
const listeners = new Set<() => void>()

export function useSettings(): Settings {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify)
      return () => {
        listeners.delete(notify)
      }
    },
    () => current,
    () => current,
  )
}

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    // 隐私模式下写入失败时仅保留内存状态
  }
  listeners.forEach((notify) => notify())
}

const INSTRUMENTAL = /(伴奏|instrumental|off[\s-]?vocal|カラオケ|karaoke)/i

/** 以曲名判定是否为伴奏版本 */
export function isInstrumental(name: string) {
  return INSTRUMENTAL.test(name)
}
