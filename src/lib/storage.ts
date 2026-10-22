const PREFIX = 'siren:'

export function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function write(key: string, value: unknown) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // 存储配额已满时静默失败，界面层会给出提示
  }
}

export function remove(key: string) {
  localStorage.removeItem(PREFIX + key)
}

export function uid(prefix = 'pl') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
