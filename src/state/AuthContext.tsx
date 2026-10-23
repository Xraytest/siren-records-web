import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, ApiError, errorText, readToken, setToken } from '../lib/api'
import type { User } from '../lib/types'

export interface AuthResult {
  ok: boolean
  error?: string
}

interface SessionResponse {
  token: string
  user: User
  userCount: number
}

interface AuthValue {
  user: User | null
  userCount: number
  ready: boolean
  register: (name: string, password: string) => Promise<AuthResult>
  login: (name: string, password: string) => Promise<AuthResult>
  logout: () => Promise<void>
  updateProfile: (patch: Partial<Pick<User, 'name' | 'bio'>>) => Promise<AuthResult>
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [userCount, setUserCount] = useState(0)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let alive = true
    if (!readToken()) {
      setReady(true)
      return
    }
    api<{ user: User; userCount: number }>('/auth/me')
      .then((data) => {
        if (!alive) return
        setUser(data.user)
        setUserCount(data.userCount)
      })
      .catch((error) => {
        if (!alive) return
        if (error instanceof ApiError && error.status === 401) setToken(null)
      })
      .finally(() => {
        if (alive) setReady(true)
      })
    return () => {
      alive = false
    }
  }, [])

  const register = useCallback(async (name: string, password: string): Promise<AuthResult> => {
    const trimmed = name.trim()
    if (trimmed.length < 2 || trimmed.length > 18) return { ok: false, error: '代号需为 2–18 个字符' }
    if (password.length < 6) return { ok: false, error: '密码至少 6 位' }
    try {
      const data = await api<SessionResponse>('/auth/register', { method: 'POST', body: { name: trimmed, password } })
      setToken(data.token)
      setUser(data.user)
      setUserCount(data.userCount)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: errorText(error, '注册失败') }
    }
  }, [])

  const login = useCallback(async (name: string, password: string): Promise<AuthResult> => {
    try {
      const data = await api<SessionResponse>('/auth/login', { method: 'POST', body: { name, password } })
      setToken(data.token)
      setUser(data.user)
      setUserCount(data.userCount)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: errorText(error, '登录失败') }
    }
  }, [])

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' })
    } catch {
      // 服务端不可达时依然清理本地会话
    }
    setToken(null)
    setUser(null)
  }, [])

  const updateProfile = useCallback(
    async (patch: Partial<Pick<User, 'name' | 'bio'>>): Promise<AuthResult> => {
      try {
        const data = await api<{ user: User }>('/auth/me', { method: 'PATCH', body: patch })
        setUser(data.user)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: errorText(error, '资料更新失败') }
      }
    },
    [],
  )

  const value = useMemo<AuthValue>(
    () => ({ user, userCount, ready, register, login, logout, updateProfile }),
    [user, userCount, ready, register, login, logout, updateProfile],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return ctx
}
