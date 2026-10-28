// 按「帧预算」录制线上站点的真实操作：每段要抓多少帧由该句旁白时长决定，
// 抓完就把这段的时长平均分给这些帧。机器快慢不影响与旁白的对齐。
// 主题：歌单自由流转（屏蔽伴奏 / 快捷键检索 / 导出文件 / 导入还原 / 快照分享 / 广场立碑）
// 输出：capture/frames/*.jpg + capture/frames.json + capture/segments.json
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'D:/WorkSpace/siren-records-web/promo'
const OUT = join(ROOT, 'capture')
const FRAMES = join(OUT, 'frames')
const BASE = process.env.BASE_URL || 'https://siren.neolx.ltd'
const W = 1920
const H = 1080
const PROXY = process.env.PROXY_URL || ''
const FPS = 15 // 抓帧率（帧预算 = 时长 × FPS），合成时再插到 30fps
const SLACK = 0.35 // 每段末尾余量

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const timing = JSON.parse(await readFile(join(ROOT, 'narration', 'timing.json'), 'utf8'))
const dur = Object.fromEntries(timing.lines.map((l) => [l.id, l.seconds]))
const token = (await readFile(join(ROOT, '.demo-token'), 'utf8').catch(() => '')).trim()

await rm(FRAMES, { recursive: true, force: true })
await mkdir(FRAMES, { recursive: true })
// 每轮重建 profile：避免上一轮的播放队列/搜索态污染开场画面
await rm(join(OUT, 'profile'), { recursive: true, force: true })

const { chromium } = await import('playwright')
const context = await chromium.launchPersistentContext(join(OUT, 'profile'), {
  headless: true, timeout: 60000, viewport: { width: W, height: H }, deviceScaleFactor: 1,
  channel: 'msedge', ...(PROXY ? { proxy: { server: PROXY } } : {}),
  acceptDownloads: true,
})
const page = context.pages()[0] || (await context.newPage())
page.setDefaultTimeout(30000)
page.setDefaultNavigationTimeout(60000)

// 首屏偶发 ERR_CONNECTION_CLOSED（本地网络抖动），重试几次再放弃
async function gotoHome(waitUntil = 'domcontentloaded') {
  let lastError = null
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await page.goto(`${BASE}/`, { waitUntil, timeout: 60000 })
    } catch (error) {
      lastError = error
      console.log(`goto 第 ${attempt} 次失败：${error.message.split('\n')[0]}，1.5s 后重试`)
      await sleep(1500)
    }
  }
  throw lastError
}

await gotoHome()
if (token) await page.evaluate((t) => localStorage.setItem('siren:token', t), token)
await gotoHome('networkidle')

let allFrames = []
const segments = []
let seg = null
let exportedPath = null

async function grab(gap = 90) {
  const name = `f-${String(allFrames.length).padStart(5, '0')}.jpg`
  const shot = page.screenshot({ path: join(FRAMES, name), type: 'jpeg', quality: 95 })
  allFrames.push(name)
  seg.frames.push(name)
  await shot
  await sleep(gap)
}

async function begin(id) {
  seg = { id, frames: [], narration: dur[id], budget: Math.max(6, Math.round((dur[id] + SLACK) * FPS)) }
  segments.push(seg)
  await grab()
}

async function fillTo(fraction) {
  const target = Math.round(seg.budget * fraction)
  while (seg.frames.length - 1 < target) await grab()
}

async function scrollBy(dy, frames) {
  const steps = Math.max(3, frames)
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, Math.round(dy / steps))
    await grab(60)
  }
}

async function finish() {
  while (seg.frames.length < seg.budget) await grab(60)
  seg.frames = seg.frames.slice(0, seg.budget)
  seg.duration = +seg.narration.toFixed(3)
  console.log(`${seg.id}: ${seg.frames.length} frames / ${seg.narration}s`)
}

/* ---------- s1 痛点：首页定格（文案改版后的新首页） ---------- */
await begin('s1')
await fillTo(0.55)
await scrollBy(300, 14)
await fillTo(0.9)
await finish()

/* ---------- s2 档案馆亮相：档案页 + 统计条 ---------- */
await page.goto(`${BASE}/#/archive`, { waitUntil: 'networkidle' })
await sleep(900)
await begin('s2')
await fillTo(0.2)
await scrollBy(700, 16)
await fillTo(0.9)
await finish()

/* ---------- s3 屏蔽伴奏开关 + ⌘K 秒搜 ---------- */
await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' })
await sleep(800)
await begin('s3')
await fillTo(0.16)
const toggle = page.locator('button[aria-label="屏蔽伴奏音乐"]').first()
if (await toggle.count()) {
  await toggle.click()
  await page.waitForTimeout(700)
  await grab(150)
}
await fillTo(0.42)
// 真按 ⌘K / Ctrl+K 唤醒搜索面板
await page.keyboard.press('Control+k')
await page.waitForTimeout(900)
await grab(160)
await page.locator('.palette input').first().fill('月')
await page.waitForTimeout(1000)
await grab(170)
await fillTo(0.66)
// 从检索结果把一首歌加进歌单
const palettePlus = page.locator('.palette-row .icon-btn, .palette-row button').nth(1)
if (await palettePlus.count()) {
  await palettePlus.click().catch(() => {})
  await page.waitForTimeout(900)
  await grab(150)
}
await fillTo(0.95)
await finish()
await page.keyboard.press('Escape').catch(() => {})
await sleep(300)
// 复原开关，避免污染本地偏好
if (await toggle.count()) await toggle.click().catch(() => {})

/* ---------- s4 导出：歌单页真点导出（触发下载） ---------- */
await page.goto(`${BASE}/#/library`, { waitUntil: 'networkidle' })
await sleep(900)
await begin('s4')
await fillTo(0.18)
const openCard = page.locator('.playlist-card-title').first()
if (await openCard.count()) {
  await openCard.click()
  await page.waitForTimeout(1000)
  await grab(150)
}
await fillTo(0.45)
const exportBtn = page.locator('.hero-actions .btn', { hasText: '导出' }).first()
if (await exportBtn.count()) {
  const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null)
  await exportBtn.click()
  const file = await dl
  if (file) {
    exportedPath = join(OUT, 'roundtrip.json')
    await file.saveAs(exportedPath)
    await page.waitForTimeout(700)
    await grab(170) // 导出 toast + 文件已落盘
  }
}
await fillTo(0.92)
await finish()

/* ---------- s5 导入还原 + 快照分享 ---------- */
await begin('s5')
const shareBtn = page.locator('.hero-actions .btn', { hasText: '分享' }).first()
if (await shareBtn.count()) {
  await shareBtn.click()
  await page.waitForTimeout(1000)
  await grab(160)
}
await fillTo(0.42)
await page.keyboard.press('Escape').catch(() => {})
await sleep(200)
// 回到歌单列表，把刚导出的文件原样导入（真实还原）
await page.goto(`${BASE}/#/library`, { waitUntil: 'networkidle' })
await sleep(800)
await grab(150)
const fileInput = page.locator('input[type="file"]').first()
if (exportedPath && await fileInput.count()) {
  await fileInput.setInputFiles(exportedPath)
  await page.waitForTimeout(1400)
  await grab(170) // 「已解析并载入 N 组声学序列」
}
await fillTo(0.95)
await finish()

/* ---------- s6 发布到广场 + 片尾（片尾卡由 build_base 追加） ---------- */
await page.goto(`${BASE}/#/library`, { waitUntil: 'networkidle' })
await sleep(800)
await begin('s6')
await fillTo(0.25)
const pubCard = page.locator('.playlist-card-title').first()
if (await pubCard.count()) {
  await pubCard.click()
  await page.waitForTimeout(1000)
  await grab(150)
}
const pubBtn = page.locator('.hero-actions .btn', { hasText: '发布' }).first()
if (await pubBtn.count()) {
  await pubBtn.click()
  await page.waitForTimeout(1000)
  await grab(160)
}
await fillTo(0.95)
await finish()

await context.close()

await writeFile(join(OUT, 'segments.json'), JSON.stringify({
  fps: FPS, segments: segments.map((s) => ({ id: s.id, frames: s.frames, duration: s.duration })),
}, null, 2), 'utf8')
await writeFile(join(OUT, 'frames.json'), JSON.stringify({ width: W, height: H, frames: allFrames }, null, 2), 'utf8')
console.log(JSON.stringify({ frames: allFrames.length, segments: segments.map((s) => `${s.id}:${s.duration}s/${s.frames.length}f`) }))
