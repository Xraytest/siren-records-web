export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const s = Math.floor(seconds % 60)
  const m = Math.floor(seconds / 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function formatDate(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}.${m}.${day}`
}

export function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  return formatDate(ts)
}

export function padIndex(n: number): string {
  return String(n + 1).padStart(2, '0')
}

export function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase()
}
