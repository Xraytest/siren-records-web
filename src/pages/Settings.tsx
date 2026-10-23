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
          <h1>偏好设置</h1>
          <p className="page-sub">
            这些开关只作用于这台设备上的浏览体验，保存在浏览器本地，不会同步到账号，也不影响服务器里已保存的歌单。
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
            <strong>屏蔽伴奏音乐</strong>
            <p>
              曲名含「伴奏」「Instrumental」「Off Vocal」「カラオケ」等字样的曲目，将从档案专辑、搜索结果、歌单曲目与随机播放中移除。
              关闭后立即恢复。
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
            <IconCheck size={13} /> 已保存的歌单不会丢数据，关闭屏蔽后会自动重新出现。
          </li>
          <li>
            <IconCheck size={13} /> 识别基于曲名文本，可能对个别命名不规范的曲目产生误判。
          </li>
        </ul>
      </div>
    </div>
  )
}
