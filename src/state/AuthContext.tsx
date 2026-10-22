import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { read, remove, write } from '../lib/storage'
import type { Session, User } from '../lib/types'

const ITERATIONS = 160_000

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromB64(value: string): Uint8Array<ArrayBuffer> {
  const bin = atob(value)
  const buffer = new ArrayBuffer(bin.length)
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function derive(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromB64(salt), iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  )
  return toB64(new Uint8Array(bits))
}

export interface AuthResult {
  ok: boolean
  error?: string
}

interface AuthValue {
  user: User | null
  userCount: number
  register: (name: string, password: string) => Promise<AuthResult>
  login: (name: string, password: string) => Promise<AuthResult>
  logout: () => void
  updateProfile: (patch: Partial<Pick<User, 'name' | 'bio'>>) => void
}

const AuthContext = createContext<AuthValue | null>(null)

function loadUsers(): User[] {
  const users = read<User[]>('users', [])
  return Array.isArray(users) ? users : []
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [users, setUsers] = useState<User[]>(loadUsers)
  const [session, setSession] = useState<Session | null>(() => read<Session | null>('session', null))

  useEffect(() => {
    write('users', users)
  }, [users])

  useEffect(() => {
    if (session) write('session', session)
    else remove('session')
  }, [session])

  const user = useMemo(() => users.find((u) => u.id === session?.userId) ?? null, [users, session])

  const register = useCallback(
    async (name: string, password: string): Promise<AuthResult> => {
      const trimmed = name.trim()
      if (trimmed.length < 2 || trimmed.length > 18) return { ok: false, error: '代号需为 2–18 个字符' }
      if (password.length < 6) return { ok: false, error: '密码至少 6 位' }
      if (users.some((u) => u.name.toLowerCase() === trimmed.toLowerCase())) {
        return { ok: false, error: '该代号已被占用' }
      }
      const salt = toB64(crypto.getRandomValues(new Uint8Array(16)))
      const hash = await derive(password, salt)
      const next: User = {
        id: `u_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name: trimmed,
        handle: trimmed.toLowerCase().replace(/\s+/g, '_'),
        bio: '',
        salt,
        hash,
        createdAt: Date.now(),
      }
      setUsers((prev) => [...prev, next])
      setSession({ userId: next.id, since: Date.now() })
      return { ok: true }
    },
    [users],
  )

  const login = useCallback(
    async (name: string, password: string): Promise<AuthResult> => {
      const found = users.find((u) => u.name.toLowerCase() === name.trim().toLowerCase())
      if (!found) return { ok: false, error: '未找到该代号，或密码不匹配' }
      const hash = await derive(password, found.salt)
      if (hash !== found.hash) return { ok: false, error: '密码不正确' }
      setSession({ userId: found.id, since: Date.now() })
      return { ok: true }
    },
    [users],
  )

  const logout = useCallback(() => setSession(null), [])

  const updateProfile = useCallback(
    (patch: Partial<Pick<User, 'name' | 'bio'>>) => {
      if (!user) return
      setUsers((prev) =>
        prev.map((u) =>
          u.id === user.id
            ? {
                ...u,
                ...patch,
                handle: patch.name ? patch.name.toLowerCase().replace(/\s+/g, '_') : u.handle,
              }
            : u,
        ),
      )
    },
    [user],
  )

  const value = useMemo<AuthValue>(
    () => ({ user, userCount: users.length, register, login, logout, updateProfile }),
    [user, users.length, register, login, logout, updateProfile],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return ctx
}
