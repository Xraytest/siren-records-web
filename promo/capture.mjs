// 按「帧预算」录制线上站点的真实操作：每段要抓多少帧由该句旁白时长决定，
// 抓完就把这段的时长平均分给这些帧。机器快慢不影响与旁白的对齐。
// 主题：一个好用的第三方塞壬唱片播放器 —— 重点演播放器本身。
// 输出：capture/frames/*.jpg + capture/frames.json + capture/segments.json
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'D:/WorkSpace/siren-records-web/promo'
const OUT = join(ROOT, 'capture')
const FRAMES = join(OUT, 'frames')
const BASE = process.env.BASE_URL || 'https://siren-records-web.chengqing-2008.workers.dev'
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
// 每次录制都用全新 profile：否则上一轮留下的播放队列会让底栏一开场就在播，
// 而「播放器」这条故事线要的是 s4 点了「播放整张」之后底栏才出现。
await rm(join(OUT, 'profile'), { recursive: true, force: true })

const { chromium } = await import('playwright')
const context = await chromium.launchPersistentContext(join(OUT, 'profile'), {
  headless: true, timeout: 60000, viewport: { width: W, height: H }, deviceScaleFactor: 1,
  channel: 'msedge', ...(PROXY ? { proxy: { server: PROXY } } : {}),
})
const page = context.pages()[0] || (await context.newPage())
page.setDefaultTimeout(30000)
page.setDefaultNavigationTimeout(60000)

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
// 清掉上次录制留在 localStorage 的播放状态，让底栏从「还没开始播」开始，
// 到 s4 真点「播放整张」时才出现 —— 这才是播放器的故事线。
await page.evaluate(() => localStorage.removeItem('siren:player'))
if (token) await page.evaluate((t) => localStorage.setItem('siren:token', t), token)
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })

let allFrames = []
const segments = []
let seg = null

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

/* ---------- s1 首页开场 ---------- */
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await sleep(900)
await begin('s1')
await finish()

/* ---------- s2 首屏下滚 → 统计条 ---------- */
await begin('s2')
await scrollBy(360, 14)
await finish()

/* ---------- s3 档案：滚动 + 检索 ---------- */
await page.goto(`${BASE}/#/archive`, { waitUntil: 'networkidle' })
await sleep(800)
await begin('s3')
await fillTo(0.12)
await scrollBy(680, 15)
const search = page.locator('input[type="search"], input[placeholder*="搜索"]').first()
if (await search.count()) {
  await search.click()
  await grab()
  await search.type('月', { delay: 180 })
  await grab(120)
}
await fillTo(0.86)
await finish()
if (await search.count()) await search.fill('').catch(() => {})
await sleep(250)

/* ---------- s4 专辑页：播放整张 ---------- */
await page.goto(`${BASE}/#/archive`, { waitUntil: 'networkidle' })
await sleep(700)
await begin('s4')
const cover = page.locator('a[href*="#/album/"]').first()
if (await cover.count()) {
  await cover.click()
  await page.waitForTimeout(900)
  await grab(150)
}
await fillTo(0.45)
const playAlbum = page.locator('.hero-actions .btn--primary').first()
if (await playAlbum.count()) {
  await playAlbum.click() // 真点「播放整张」，进入真实播放态
  await page.waitForTimeout(700)
  await grab(140)
}
await fillTo(0.85)
await finish()

/* ---------- s5 播放器本体：展开 → 歌词 → 队列 ---------- */
await begin('s5')
const bar = page.locator('.playerbar-track').first()
if (await bar.count()) {
  await bar.click()
  await page.waitForTimeout(800)
  await grab(140)
}
await fillTo(0.35)
const lyricsBtn = page.locator('.player-view-panel .seg button').first()
if (await lyricsBtn.count()) {
  await lyricsBtn.click().catch(() => {})
  await page.waitForTimeout(900)
  await grab(160)
}
await fillTo(0.72)
const queueBtn = page.locator('.player-view-panel .seg button').nth(1)
if (await queueBtn.count()) {
  await queueBtn.click().catch(() => {})
  await page.waitForTimeout(700)
  await grab(150)
}
await fillTo(0.95)
await finish()
await page.keyboard.press('Escape').catch(() => {})
const closeBtn = page.locator('.player-view-head .icon-btn').first()
if (await closeBtn.count()) await closeBtn.click().catch(() => {})
await sleep(300)

/* ---------- s6 歌单 ---------- */
await page.goto(`${BASE}/#/library`, { waitUntil: 'networkidle' })
await sleep(800)
await begin('s6')
await fillTo(0.26)
await scrollBy(230, 16)
await finish()

/* ---------- s7 偏好设置：屏蔽伴奏开关 ---------- */
await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' })
await sleep(800)
await begin('s7')
await fillTo(0.4)
const toggle = page.locator('button[aria-label="屏蔽伴奏音乐"]').first()
if (await toggle.count()) {
  await toggle.click()
  await page.waitForTimeout(600)
  await grab(140)
}
await fillTo(0.85)
await finish()
// 恢复开关，避免污染本地设置
if (await toggle.count()) await toggle.click().catch(() => {})

/* ---------- s8 账号 ---------- */
await page.goto(`${BASE}/#/account`, { waitUntil: 'networkidle' })
await sleep(800)
await begin('s8')
await fillTo(0.28)
await scrollBy(190, 15)
await finish()

await context.close()

await writeFile(join(OUT, 'segments.json'), JSON.stringify({
  fps: FPS, segments: segments.map((s) => ({ id: s.id, frames: s.frames, duration: s.duration })),
}, null, 2), 'utf8')
await writeFile(join(OUT, 'frames.json'), JSON.stringify({ width: W, height: H, frames: allFrames }, null, 2), 'utf8')
console.log(JSON.stringify({ frames: allFrames.length, segments: segments.map((s) => `${s.id}:${s.duration}s/${s.frames.length}f`) }))
