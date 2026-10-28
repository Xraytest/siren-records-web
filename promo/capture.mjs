// 按「帧预算」录制线上站点的真实操作：每段要抓多少帧由该句旁白时长决定，
// 抓完就把这段的时长平均分给这些帧。机器快慢不影响与旁白的对齐。
// 主题：歌单 —— 创建 / 整张收录 / 单曲收录 / 排序 / 分享 / 发布 / 导出导入。
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
// 每轮重建 profile：否则上一轮残留的歌单/播放状态会让画面从一开始就不是「干净」的。
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

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
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

/* ---------- s1 我的歌单：这是主角 ---------- */
await page.goto(`${BASE}/#/library`, { waitUntil: 'networkidle' })
await sleep(1000)
await begin('s1')
await fillTo(0.35)
await scrollBy(160, 10)
await finish()

/* ---------- s2 新建歌单：真填名称/描述/标签并创建 ---------- */
await page.locator('.playlist-card--new').first().click()
await page.waitForTimeout(700)
await begin('s2')
await fillTo(0.1)
// 三个输入框按 DOM 顺序分别是 名称 input / 描述 textarea / 标签 input，
// 用 union 选择器取 nth() 会拿错，所以分开定位。
const nameInput = page.locator('.modal input[placeholder*="深夜航路"]').first()
const descInput = page.locator('.modal textarea').first()
const tagsInput = page.locator('.modal input[placeholder*="空格或逗号"]').first()
await nameInput.click()
await nameInput.type('夜航四十分钟', { delay: 110 })
await grab(110)
await fillTo(0.32)
await descInput.click()
await descInput.type('地铁到站之前，刚好放完的一张。', { delay: 80 })
await grab(110)
await fillTo(0.56)
await tagsInput.click()
await tagsInput.type('通勤 深夜', { delay: 110 })
await grab(110)
await fillTo(0.76)
await page.locator('.modal-foot .btn--primary').first().click()
// 创建成功必须落到 /#/playlist/<id>；没成功就再点一次，仍不成功就抛错，
// 不要带着「没建出来」的状态继续录后面的收录戏。
let created = false
for (let attempt = 0; attempt < 2 && !created; attempt++) {
  await page.waitForTimeout(1200)
  created = /#\/playlist\//.test(page.url())
  if (!created) await page.locator('.modal-foot .btn--primary').first().click().catch(() => {})
}
if (!created) throw new Error('新建歌单失败：没有进入 playlist 详情页')
await grab(150)
await fillTo(0.97)
await finish()

// 记下刚才创建的歌单地址，后面几段都在它身上演
const playlistUrl = page.url()
console.log(`playlist: ${playlistUrl}`)

/* ---------- s3 整张收录：回档案 → 专辑 → 整张加入歌单 ---------- */
await page.goto(`${BASE}/#/archive`, { waitUntil: 'networkidle' })
await sleep(800)
await begin('s3')
await fillTo(0.15)
const cover = page.locator('a[href*="#/album/"]').nth(1)
if (await cover.count()) {
  await cover.click()
  await page.waitForTimeout(1000)
  await grab(150)
}
await fillTo(0.5)
const addWhole = page.locator('.hero-actions .btn').nth(1)
if (await addWhole.count()) {
  await addWhole.click()
  await page.waitForTimeout(800)
  await grab(150)
}
await fillTo(0.82)
// 选单里点刚才新建的那张（不再点 .first()，否则整张会被收进别的歌单，
// 与旁白「进了你挑的那张」不符，也让后一段排序找不到内容）。
const newRow = page.locator('.pick-row', { hasText: '夜航四十分钟' }).first()
if (await newRow.count()) {
  await newRow.click() // 真把整张收进「夜航四十分钟」
  await page.waitForTimeout(900)
  await grab(160)
} else {
  throw new Error('选单里没有刚新建的「夜航四十分钟」')
}
await fillTo(0.96)
await finish()
await page.keyboard.press('Escape').catch(() => {})
await sleep(300)

/* ---------- s4 单曲收录：曲目行 + 号 → 选歌单 ---------- */
await begin('s4')
await fillTo(0.2)
const songPlus = page.locator('.song-row .song-actions button[title="加入歌单"]').first()
if (await songPlus.count()) {
  await songPlus.click()
  await page.waitForTimeout(800)
  await grab(150)
}
await fillTo(0.66)
const pickNew = page.locator('.pick-row', { hasText: '夜航四十分钟' }).first()
if (await pickNew.count()) {
  await pickNew.click()
  await page.waitForTimeout(900)
  await grab(160)
} else {
  throw new Error('单曲收录时选单里没有「夜航四十分钟」')
}
await fillTo(0.95)
await finish()
await page.keyboard.press('Escape').catch(() => {})
await sleep(300)

/* ---------- s5 排序：进刚才那张歌单，真点上移 ---------- */
await page.goto(playlistUrl, { waitUntil: 'networkidle' })
await sleep(900)
await begin('s5')
await fillTo(0.25)
const downBtn = page.locator('.song-row .song-actions button[title="上移"]').nth(1)
if (await downBtn.count()) {
  await downBtn.click()
  await page.waitForTimeout(700)
  await grab(140)
}
await fillTo(0.6)
const downBtn2 = page.locator('.song-row .song-actions button[title="上移"]').nth(2)
if (await downBtn2.count()) {
  await downBtn2.click()
  await page.waitForTimeout(700)
  await grab(140)
}
await fillTo(0.95)
await finish()

/* ---------- s6 分享弹窗 ---------- */
await begin('s6')
const shareBtn = page.locator('.hero-actions .btn', { hasText: '分享' }).first()
if (await shareBtn.count()) {
  await shareBtn.click()
  await page.waitForTimeout(900)
  await grab(160)
}
await fillTo(0.9)
await finish()
await page.keyboard.press('Escape').catch(() => {})
await sleep(300)

/* ---------- s7 发布到广场 ---------- */
await begin('s7')
const pubBtn = page.locator('.hero-actions .btn', { hasText: '发布' }).first()
if (await pubBtn.count()) {
  await pubBtn.click()
  await page.waitForTimeout(900)
  await grab(160)
}
await fillTo(0.9)
await finish()
await page.keyboard.press('Escape').catch(() => {})
await sleep(300)

/* ---------- s8 我的歌单：真导出一次 → 真导入回来 ---------- */
await page.goto(`${BASE}/#/library`, { waitUntil: 'networkidle' })
await sleep(900)
await begin('s8')
await fillTo(0.22)
const exportAllBtn = page.locator('.page-head .btn', { hasText: '导出全部' }).first()
let exportedPath = null
{
  const download = page.waitForEvent('download', { timeout: 15000 }).catch(() => null)
  await exportAllBtn.click()
  const file = await download
  if (!file) throw new Error('导出没有触发下载')
  exportedPath = join(OUT, 'exported.json')
  await file.saveAs(exportedPath)
  await page.waitForTimeout(600)
  await grab(160) // 真下载了一次，按钮态与 toast 都是真的
}
await fillTo(0.6)
// 把刚导出的文件原样导入回去，证明「一首不差」
const fileInput = page.locator('input[type="file"]').first()
await fileInput.setInputFiles(exportedPath)
await page.waitForTimeout(1200)
await grab(160)
await fillTo(0.92)
await finish()

await context.close()

await writeFile(join(OUT, 'segments.json'), JSON.stringify({
  fps: FPS, segments: segments.map((s) => ({ id: s.id, frames: s.frames, duration: s.duration })),
}, null, 2), 'utf8')
await writeFile(join(OUT, 'frames.json'), JSON.stringify({ width: W, height: H, frames: allFrames }, null, 2), 'utf8')
console.log(JSON.stringify({ frames: allFrames.length, segments: segments.map((s) => `${s.id}:${s.duration}s/${s.frames.length}f`) }))
