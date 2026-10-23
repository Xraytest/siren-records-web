import { useEffect, useState } from 'react'
import { Modal } from './Modal'
import { useAuth } from '../state/AuthContext'
import { toast } from '../lib/toast'

interface Props {
  mode: 'login' | 'register' | null
  onClose: () => void
  onMode: (m: 'login' | 'register') => void
}

export function AuthDialog({ mode, onClose, onMode }: Props) {
  const { login, register } = useAuth()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (mode) {
      setError('')
      setBusy(false)
      setConfirm('')
    }
  }, [mode])

  if (!mode) return null
  const isRegister = mode === 'register'

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (isRegister && password !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    setBusy(true)
    const result = isRegister ? await register(name, password) : await login(name, password)
    setBusy(false)
    if (!result.ok) {
      setError(result.error || '操作失败')
      return
    }
    toast(isRegister ? '账号已建立，欢迎登船' : '已连接，欢迎回来', 'ok')
    setName('')
    setPassword('')
    setConfirm('')
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      kicker={isRegister ? 'ENLIST / 注册' : 'SIGN IN / 登录'}
      title={isRegister ? '建立船员档案' : '返回档案'}
    >
      <div className="seg">
        <button className={!isRegister ? 'is-on' : ''} onClick={() => onMode('login')} type="button">
          登录
        </button>
        <button className={isRegister ? 'is-on' : ''} onClick={() => onMode('register')} type="button">
          注册
        </button>
      </div>
      <form className="auth-form" onSubmit={submit}>
        <label>
          <span>代号 / CALLSIGN</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="2–18 个字符"
            autoFocus
            autoComplete="username"
          />
        </label>
        <label>
          <span>密码 / PASSWORD</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 6 位"
            autoComplete={isRegister ? 'new-password' : 'current-password'}
          />
        </label>
        {isRegister && (
          <label>
            <span>确认密码 / CONFIRM</span>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </label>
        )}
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn--primary btn--block" disabled={busy} type="submit">
          {busy ? '处理中…' : isRegister ? '建立档案' : '登录'}
        </button>
        <p className="hint hint--xs">
          账号与歌单保存在服务端，密码以 scrypt 加盐哈希存储，登录状态保留 30 天。
        </p>
      </form>
    </Modal>
  )
}
