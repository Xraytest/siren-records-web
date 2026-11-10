import { IconCheck } from '../components/Icons'
import { useCatalog, useCatalogSync } from '../lib/catalog'
import { formatRelative } from '../lib/format'
import { updateSettings, useSettings } from '../lib/settings'

function relative(iso: string | undefined) {
  const ts = iso ? Date.parse(iso) : Number.NaN
  return Number.isFinite(ts) ? formatRelative(ts) : '——'
}

export function Settings() {
  const { hideInstrumental, autoSyncCatalog, audioVia } = useSettings()
  const catalog = useCatalog()
  const sync = useCatalogSync()

  const meta = sync.meta
  const statusText = meta
    ? meta.mode === 'snapshot'
      ? `离线快照 · ${meta.albums} 张 / ${meta.songs} 首 · 生成于 ${relative(meta.generatedAt)}`
      : `版本 v${meta.version} · ${meta.albums} 张 / ${meta.songs} 首 · 同步于 ${relative(meta.syncedAt)}`
    : '尚未载入曲库'

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

        <div className="setting-row">
          <div className="setting-copy">
            <strong>曲库自动同步（与官方保持最新）</strong>
            <p>
              服务端每 10 分钟与塞壬唱片官方比对一次曲库，新专辑上架后自动入库，无需重新部署。
              此开关只控制本页在前台时的轻量探测（每 5 分钟问一次版本号，几百字节）：发现新版本立即热更新列表，
              不刷新页面也能看到新专辑。关闭后仍可随时手动同步。
            </p>
            <p className="setting-meta mono">
              {statusText}
              {meta?.lastError ? ` · 上次失败：${meta.lastError}` : ''}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoSyncCatalog}
            aria-label="自动检查曲库更新"
            className={`switch ${autoSyncCatalog ? 'is-on' : ''}`}
            onClick={() => updateSettings({ autoSyncCatalog: !autoSyncCatalog })}
          >
            <span />
          </button>
        </div>

        <div className="setting-row">
          <div className="setting-copy">
            <strong>音频取流方式</strong>
            <p>
              官方专辑里 753/936 首是 8–50 MB 的 WAV 原文件，默认由浏览器 302 直连官方 CDN（hycdn）。
              如果本机到 hycdn 的带宽不足，会表现为「一直转圈、播两秒就停」。
              改成「本站转发」后浏览器只连本站边缘节点，由服务端回源取字节——两条路由哪个快取决于你的网络。
            </p>
            <p className="setting-meta">
              {audioVia === 'auto'
                ? '当前：自动（先直连，连续失败 2 次后改走本站转发）'
                : audioVia === 'direct'
                  ? '当前：始终直连官方 CDN'
                  : '当前：始终走本站转发'}
            </p>
          </div>
          <div className="seg seg--sm" aria-label="音频取流方式">
            <button
              type="button"
              className={audioVia === 'auto' ? 'is-on' : ''}
              onClick={() => updateSettings({ audioVia: 'auto' })}
            >
              自动
            </button>
            <button
              type="button"
              className={audioVia === 'direct' ? 'is-on' : ''}
              onClick={() => updateSettings({ audioVia: 'direct' })}
            >
              直连
            </button>
            <button
              type="button"
              className={audioVia === 'proxy' ? 'is-on' : ''}
              onClick={() => updateSettings({ audioVia: 'proxy' })}
            >
              本站转发
            </button>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-copy">
            <strong>立即与官方对齐</strong>
            <p>
              让服务端立刻去官方拉一次（新增专辑、曲目增补、改名、下架），完成后本页直接换用新曲库并提示差异。
              服务端对同一来源有 15 秒冷却，过于频繁会被拒绝。
            </p>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void sync.refresh()}
            disabled={sync.refreshing}
          >
            {sync.refreshing ? '同步中…' : '立即同步'}
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
          <li>
            <IconCheck size={13} /> 曲库同步失败时保留上一版数据继续播放，音频直链在播放时会实时换取。
          </li>
        </ul>
      </div>
    </div>
  )
}
