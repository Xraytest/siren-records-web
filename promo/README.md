# 宣传片 v3 · 制作说明（歌单自由流转 · 60s + 片尾）

线上站：<https://siren.neolx.ltd>（备用：<https://siren-records-web.chengqing-2008.workers.dev>）
成片：`promo/siren-promo-v2.mp4`（1920×1080 / 30fps / 67.4s / H.264 + AAC 48kHz）

主题：**歌单自由流转**——导出本地文件、导入一秒还原、只读快照免登录分享、广场立碑。
配乐为 EAC `compose` 生成的原创合成器（96 BPM、66s），**不使用任何塞壬唱片曲目**，
避免版权风险；旁白为本地 GPT-SoVITS。

## 画面：线上站真实操作

`capture.mjs` 用 Playwright 驱动 Edge 访问 **siren.neolx.ltd**（本机直连，无需代理），
带演示账号 `demo_archive` 的登录态，每轮重建 profile。

| 段 | 时长 | 真实动作 |
|---|---|---|
| s1 | 12.86s | 改版后首页（新 Slogan「在这里自由编排你的专属歌单，封装为便携档案随身携带」） |
| s2 | 9.20s | 档案页封面墙 + 滚到统计条 298 / 911 |
| s3 | 10.04s | 偏好设置**真点**「屏蔽伴奏」开关（曲目 911→783）→ **真按 Ctrl+K** 唤醒搜索 → 输入「月」出结果 |
| s4 | 9.12s | 歌单页 → 打开歌单 → **真点导出**（真实触发下载并落盘 `capture/roundtrip.json`） |
| s5 | 8.48s | **真分享弹窗**（链接为 `https://siren.neolx.ltd/#/share/...`）→ 回到歌单列表**真导入**刚导出的文件 |
| s6 | 11.68s | 发布弹窗（发布到公开广场） |
| endcard | 4.20s | `endcard.html`：EXPORT / IMPORT / SNAPSHOT / SHARE + 域名 |

抓帧按**帧预算**（旁白时长 × 15fps）采集，合成时按段均分到 30fps 时间线，机器快慢不影响音画对齐。

## 旁白（GPT-SoVITS @ 192.168.1.12:9880）

参考音色 `Istina_JP_V2ProPlus.wav`，`text_lang=zh` / `prompt_lang=ja`，共 6 句 61.4s。
每句起点 = 段起点 + 0.3s，句末正好落在段末，因此段间不留空档。

## 混音与响度

- 旁白轨 + 原创配乐：配乐音量 0.34，并用 `sidechaincompress`（threshold 0.03 / ratio 7）做人声压乐；
  配乐首尾各 1.2s / 2.4s 淡入淡出。
- 响度：先量 `mix_raw.wav`（-18.3 LUFS / TP -5.0），补 +2.3 dB 静态增益 + `alimiter=0.94`；
  成片 **I -15.5 LUFS / True Peak -2.1 dBFS / LRA 2.9 LU**。

## 复现

```bash
cd promo
node capture.mjs                        # 抓帧（BASE_URL 默认 siren.neolx.ltd，直连无需代理）
FFMPEG=... node build_base.mjs          # 拼帧 + 片尾卡 → build/base.mp4
FFMPEG=... FFPROBE=... MUSIC=<compose 输出>/music.wav node assemble.mjs
```

## 已知限制

- 抓帧是 15fps 采样插到 30fps（不是逐帧录屏），滚动时有轻微步进感。
- 时长 67.4s 略超 60s 目标：旁白本身 61.4s，片尾卡另占 4.2s。若必须压到 60s 以内，需再砍旁白。
- 录制会在 D1 真实创建/导入歌单，已清理重复项并恢复演示歌单原始状态。
- 站点页脚的「ARCHIVE BUILD / 2026-10.22」是曲库快照自身的时间戳，不随部署刷新。
