const TOKEN_KEY = 'siren:token'

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * 全局 401 回调：会话过期时统一清理登录态。
 * 早期只在启动时的 /auth/me 里处理 401，其它接口过期后 UI 仍显示「已登录」，
 * 每次操作都失败却提示"请先登录"。注意只在「本次请求确实带了 token」时触发，
 * 避免把未登录时的登录失败也当成会话过期。
 */
let onUnauthorized: (() => void) | null = null

export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler
}

export function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // 隐私模式下写入失败时忽略，会话仅存活于内存
  }
}

interface RequestOptions {
  method?: string
  body?: unknown
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {}
  const token = readToken()
  if (token) headers.Authorization = `Bearer ${token}`

  let body: string | undefined
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }

  let res: Response
  try {
    res = await fetch(`/api${path}`, { method: options.method ?? 'GET', headers, body })
  } catch {
    throw new ApiError(0, '无法连接服务器，请确认服务端已启动')
  }

  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized?.()
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(res.status, data?.error || `请求失败 (${res.status})`)
  }

  return (await res.json()) as T
}

export function errorText(error: unknown, fallback = '操作失败') {
  return error instanceof Error ? error.message : fallback
}
