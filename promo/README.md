# 宣传片 v2 · 制作说明（配音版）

线上站：<https://siren-records-web.chengqing-2008.workers.dev>
成片：`promo/siren-promo-v2.mp4`（1920×1080 / 30fps / 45.1s / H.264 + AAC 48kHz）

## 画面：全部来自线上站真实操作

`capture.mjs` 用 Playwright 驱动 Edge，访问**线上 workers.dev 域名**（经本机代理 `127.0.0.1:65532`），
带演示账号 `demo_archive` 的登录态，抓取 7 段真实界面：

| 段 | 时长 | 画面内容 |
|---|---|---|
| s1 | 2.72s | 首页首屏（SIREN RECORDS 大标 + 最新专辑） |
| s2 | 6.68s | 下滚到统计条：298 ALBUMS / 911 TRACKS / 3 PLAYLISTS / 1 PUBLISHED |
| s3 | 4.66s | 档案页封面墙 + 真实检索交互 |
| s4 | 6.70s | 点开「昨日海OST」专辑页，含曲目表 |
| s5 | 5.84s | 我的歌单（3 张真实歌单） |
| s6 | 6.96s | 账号页（CREW FILE / 03 歌单 / 011 曲目 / SERVER / D1） |
| s7 | 3.56s | 公开广场（演示歌单「深夜循环」） |
| s8 | 5.88s | 片尾卡 `endcard.html`（Edge 截图渲染） |

**抓帧按帧预算而非秒**：每段要抓多少帧 = 旁白实测时长 × 15fps，合成时按段均分到 30fps 时间轴，
所以机器快慢不影响音画对齐。导航跳转的间隙在 `build_base.mjs` 里直接剪掉。

## 配音：本地 GPT-SoVITS

`tts.mjs` 打 `http://192.168.1.12:9880/tts`（POST JSON），音色 `Istina_JP_V2ProPlus.wav`，
`text_lang=zh`、`prompt_lang=ja`，逐句合成 8 段，实测时长写进 `narration/timing.json`。

| 句 | 秒 | 文案 |
|---|---|---|
| s1 | 2.72 | 这不是官网，是一份档案。 |
| s2 | 6.68 | 塞壬唱片，两百九十八张专辑，九百一十一首曲子，全部收在册子里。 |
| s3 | 4.66 | 检索、排序、随机播放，一个页面就够。 |
| s4 | 6.70 | 点开一张专辑，曲目、时长、歌词，都在该在的位置。 |
| s5 | 5.84 | 歌单可以带走。一条链接，换台设备打开，还是原来的顺序。 |
| s6 | 6.96 | 身份存在服务端，密码只留加盐哈希。换台机器登录，歌单还在原地。 |
| s7 | 3.56 | 发布到广场，让别人也听见你的选择。 |
| s8 | 4.28 | 塞壬唱片档案。非官方，但很认真。 |

旁白总长 41.4s，每句起点 = 对应画面段起点 + 0.3s（`build/qa.json` 的 `placed` 是实际写入时间）。

## 配乐：EAC 原创器乐

`eac_job_submit(type=compose)` 生成 54s、92 BPM 原创器乐（纯合成，无外部素材），
终混里降到 0.34 并做侧链 ducking（threshold 0.03 / ratio 7），首尾各 1.4s 与 2.4s 淡入淡出。

## 字幕与混音

- ASS 字幕底部居中，`Noto Sans SC` 46px、青色 `#a0edff`、半透明底框（BorderStyle 3）、Outline 14。
- 响度：先量一遍 `mix_raw.wav`（-18.5 LUFS / TP -5 dB），再补静态增益 +2.5 dB 并 `alimiter=0.94`，
  成片 **I -15.5 LUFS / True Peak -2.0 dBFS / LRA 2.7 LU**。

## 复现

```bash
cd promo
export PROXY_URL=http://127.0.0.1:65532        # 本机访问 workers.dev 需要代理
node capture.mjs                                # 真实操作抓帧（会重置 capture/frames）
FFMPEG=... node build_base.mjs                  # 拼帧 + 片尾卡 → build/base.mp4
FFMPEG=... FFPROBE=... MUSIC=<compose 输出>/music.wav node assemble.mjs   # 终混
```

## 已知限制

- 抓帧不是逐帧录屏（15fps 采样插到 30fps），滚动时有轻微步进感，这是为了在长录制里保持旁白对齐的取舍。
- 画面里出现的 `demo_archive` 是演示账号，其 3 张歌单（深夜循环 / 通勤四十分钟 / 写代码用）与 1 条广场条目仍留在线上 D1。
- 浏览器里那行「ARCHIVE BUILD / 2026-10-22」是站点自身的构建戳，未随本次部署刷新。
