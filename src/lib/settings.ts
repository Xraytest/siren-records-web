import { useSyncExternalStore } from 'react'

export interface Settings {
  /** 隐藏被识别为伴奏的曲目 */
  hideInstrumental: boolean
  /** 「我的歌单」页排列视图 */
  libraryView: 'grid' | 'list'
  /** 「我的歌单」页排序方式 */
  librarySort: 'updated' | 'created' | 'name' | 'tracks'
  /** 页面在前台时自动检查曲库更新（每 5 分钟一次轻量探测） */
  autoSyncCatalog: boolean
}

const KEY = 'siren:settings'
const DEFAULTS: Settings = {
  hideInstrumental: false,
  libraryView: 'grid',
  librarySort: 'updated',
  autoSyncCatalog: true,
}

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

/** 非 React 环境（轮询、事件回调）读取当前设置 */
export function readSettings(): Settings {
  return current
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
