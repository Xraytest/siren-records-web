# 宣传片 · 制作说明（歌单自由流转）

线上站：<https://siren.neolx.ltd>（备用：<https://siren-records-web.chengqing-2008.workers.dev>）

成片共两版，画面与旁白完全相同，只差配乐：

| 文件 | 配乐 | 大小 |
|---|---|---|
| `siren-promo-msr-bgm.mp4` | MSR 曲目：《愚人曲》前奏 0–13s →《Radiant》13s 至结尾 | 10.4 MB |
| `siren-promo-no-bgm.mp4` | **无配乐**，只有旁白 | 9.9 MB |

均为 1920×1080 / 30fps / 67.4s / H.264 + AAC 48kHz。

## 主题

**歌单自由流转**——导出本地文件、导入一秒还原、只读快照免登录分享、广场立碑。

## 旁白：本地 GPT-SoVITS（192.168.1.12:9880）

参考音色 `Istina_JP_V2ProPlus.wav`，`text_lang=zh` / `prompt_lang=ja`，共 6 句 61.4s。
每句起点 = 对应画面段起点 + 0.3s，句末正好落在段末，段间不留空档。

| 句 | 秒 | 文案 |
|---|---|---|
| s1 | 12.86 | 想把喜欢的塞壬唱片神曲凑成一张歌单分享给朋友……官网没法跨专辑建歌单，还总刷到纯伴奏 |
| s2 | 9.20 | 于是有了这座塞壬唱片非官方档案馆。298 张专辑、911 首曲目，全量收录 |
| s3 | 10.04 | 设置里一键开启屏蔽伴奏，纯伴奏轨全部隐身。再按快捷键全局秒搜，跨专辑收进同一张歌单 |
| s4 | 9.12 | 最核心的是歌单自由流转：一键导出成本地文件，永久备份，或者直接丢进博士群 |
| s5 | 8.48 | 群友拿到文件点导入，一秒还原整张歌单；生成快照链接，对方不用登录，点开就能连播 |
| s6 | 11.68 | 把最得意的歌单发布到公开广场……网址 siren.neolx.ltd，免费无广告 |

## 画面：线上站真实操作

`capture.mjs` 用 Playwright 驱动 Edge 访问 siren.neolx.ltd（本机直连，无需代理），
带演示账号 `demo_archive` 登录态，每轮重建 profile。抓帧按**帧预算**（旁白时长 × 15fps）采集，
合成时按段均分到 30fps，机器快慢不影响音画对齐。

| 段 | 时长 | 真实动作 |
|---|---|---|
| s1 | 12.86s | 改版后首页（新 Slogan「自由编排你的专属歌单，封装为便携档案随身携带」） |
| s2 | 9.20s | 档案页封面墙 + 统计条 298 / 911 |
| s3 | 10.04s | 偏好设置**真点**屏蔽伴奏开关（911→783）+ **真按 Ctrl+K** 检索「月」 |
| s4 | 9.12s | 歌单页 → 打开歌单 → **真点导出**（真实触发下载并落盘） |
| s5 | 8.48s | **真分享弹窗**（链接为 `https://siren.neolx.ltd/#/share/...`）→ **真导入**刚导出的文件 |
| s6 | 11.68s | 发布弹窗（发布到公开广场） |
| endcard | 4.20s | `endcard.html`：EXPORT / IMPORT / SNAPSHOT / SHARE + 域名 |

## 两版的混音差异

- **有配乐版**：BGM 音量 0.34 + `sidechaincompress` 侧链压乐；BGM 由 `fetch_msr.mjs` 从官方 CDN 下载、
  `build_msr_bed.mjs` 剪切（愚人曲前奏 1.6s 淡入 → 1.2s `acrossfade` 交接到 Radiant → 整体 2.4s 淡出）。
- **无配乐版**：只输出旁白轨。旁白结束后（63.18s 起）为数字静音（-91dB），
  段间也是真静音；因每句旁白都精确落在段末，没有音乐填充也不显得断。

两版响度一致：先量混音再补静态增益 + `alimiter=0.94`，成片 **I -15.5 LUFS / True Peak -2.1 dBFS**（无配乐版 TP -2.7 dBFS）。

## 复现

```bash
cd promo
node fetch_msr.mjs                    # 仅配乐版需要：下载 MSR 曲目
FFMPEG=... node build_msr_bed.mjs     # 仅配乐版需要：剪 BGM → build/msr_bed.wav
node capture.mjs                      # 抓帧（BASE_URL 默认 siren.neolx.ltd）
FFMPEG=... node build_base.mjs        # 拼帧 + 片尾卡 → build/base.mp4

FFMPEG=... FFPROBE=... node assemble.mjs                              # 无配乐版
FFMPEG=... FFPROBE=... BED=build/msr_bed.wav node assemble.mjs        # MSR 配乐版
```

## 已知限制

- 时长 67.4s 略超 60s 目标（旁白本身 61.4s + 片尾卡 4.2s）；要压进 60s 需再砍旁白。
- 抓帧是 15fps 采样插值到 30fps，滚动时有轻微步进感。
- 首屏偶发 `ERR_CONNECTION_CLOSED`，`capture.mjs` 已加重试（4 次 × 1.5s）。
- 录制会在 D1 真实创建/导入歌单，已清理重复项并恢复演示歌单原始状态。
- 站点页脚的「ARCHIVE BUILD / 2026.10.22」是曲库快照自身时间戳，不随部署刷新。
- MSR 曲目版权归塞壬唱片 / 鹰角网络；配乐版对外发布建议保留片尾与简介的版权声明。
