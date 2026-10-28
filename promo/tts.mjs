// 用本地 GPT-SoVITS(192.168.1.12:9880) 逐句合成旁白，返回真实时长。
// 用法: node tts.mjs [--speed 1.0] [--ref Istina_JP_V2ProPlus.wav]
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'D:/WorkSpace/siren-records-web/promo'
const OUT = join(ROOT, 'narration')
const ENDPOINT = process.env.TTS_ENDPOINT || 'http://192.168.1.12:9880/tts'
const REF = process.env.TTS_REF || 'Istina_JP_V2ProPlus.wav'
const PROMPT = '決意と情熱、そして更に120%の情熱を上乗せして、頑張りましょう。'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}

async function synth(text, speed) {
  const body = {
    text,
    text_lang: 'zh',
    ref_audio_path: REF,
    prompt_lang: 'ja',
    prompt_text: PROMPT,
    text_split_method: 'cut5',
    media_type: 'wav',
    streaming_mode: false,
    speed_factor: speed,
    batch_size: 1,
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    })
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > 4000) return buf
    } else {
      const err = await res.text().catch(() => '')
      if (attempt === 3) throw new Error(`TTS ${res.status}: ${err.slice(0, 200)}`)
    }
    await new Promise((r) => setTimeout(r, 1200 * attempt))
  }
  throw new Error('TTS 多次失败')
}

async function duration(file) {
  const { execFile } = await import('node:child_process')
  const ffprobe = process.env.FFPROBE || 'ffprobe'
  return await new Promise((resolve, reject) => {
    execFile(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
      (error, stdout) => (error ? reject(error) : resolve(Number(stdout.trim()))))
  })
}

const speed = Number(arg('speed', '1.0'))
const lines = JSON.parse(await readFile(join(ROOT, 'narration.json'), 'utf8'))
await mkdir(OUT, { recursive: true })
const report = []
for (const line of lines) {
  const file = join(OUT, `${line.id}.wav`)
  const wav = await synth(line.text, speed)
  await writeFile(file, wav)
  const d = await duration(file)
  report.push({ id: line.id, text: line.text, seconds: +d.toFixed(2), bytes: wav.length })
  console.log(`${line.id}  ${d.toFixed(2)}s  ${line.text}`)
}
const total = report.reduce((a, b) => a + b.seconds, 0)
await writeFile(join(OUT, 'timing.json'), JSON.stringify({ speed, total: +total.toFixed(2), lines: report }, null, 2), 'utf8')
console.log(`总计 ${total.toFixed(2)}s`)
