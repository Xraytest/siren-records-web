import { IconCheck } from '../components/Icons'
import { useCatalog } from '../lib/catalog'
import { updateSettings, useSettings } from '../lib/settings'

export function Settings() {
  const { hideInstrumental } = useSettings()
  const catalog = useCatalog()

  return (
    <div className="settings">
      <header className="page-head">
        <div>
          <span className="kicker">SETTINGS / 05</span>
          <h1>当前终端本地声学滤镜</h1>
          <p className="page-sub">
            以下参数仅作用于本台设备的本地播放与检索环境（存储于浏览器 LocalStorage），不会篡改你云端已封存的歌单结构。
          </p>
        </div>
        <div className="page-head-side">
          <span className="mono big">{catalog ? String(catalog.all.length).padStart(3, '0') : '···'}</span>
          <span className="mono">TRACKS IN VIEW</span>
        </div>
      </header>

      <div className="settings-list">
        <div className="setting-row">
          <div className="setting-copy">
            <strong>纯净人声 / 原声过滤（屏蔽伴奏轨）</strong>
            <p>
              开启后，系统将自动拦截曲名含「伴奏」「Instrumental」「Off Vocal」「カラオケ」标记的纯伴奏音轨，
              使其从专辑列表、全局检索、歌单挑曲与分享连播中隐身。关闭开关即可毫秒级无损恢复。
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={hideInstrumental}
            aria-label="屏蔽伴奏音乐"
            className={`switch ${hideInstrumental ? 'is-on' : ''}`}
            onClick={() => updateSettings({ hideInstrumental: !hideInstrumental })}
          >
            <span />
          </button>
        </div>
      </div>

      <div className="settings-note">
        <span className="kicker">BEHAVIOUR</span>
        <ul>
          <li>
            <IconCheck size={13} /> 档案与专辑页的曲目数会随之减少，被屏蔽的曲目不会被加入播放队列。
          </li>
          <li>
            <IconCheck size={13} /> 已封存的歌单不会丢数据，关闭屏蔽后会自动重新出现。
          </li>
          <li>
            <IconCheck size={13} /> 识别基于曲名文本，可能对个别命名不规范的曲目产生误判。
          </li>
        </ul>
      </div>
    </div>
  )
}
