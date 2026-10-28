// 组装成片：真实录屏 + GPT-SoVITS 旁白 + EAC 原创配乐(ducking) + ASS 字幕
// 响度用「先测后补」的静态增益，避免单遍 loudnorm 的动态压缩把人声越压越小声。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const build = join(here, 'build')
const FFMPEG = process.env.FFMPEG || 'ffmpeg'
const FFPROBE = process.env.FFPROBE || 'ffprobe'
const MUSIC = process.env.MUSIC
if (!MUSIC) throw new Error('MUSIC env var (composed music.wav) is required')
mkdirSync(build, { recursive: true })

const LEAD = 0.3
const { duration, segments } = JSON.parse(readFileSync(join(build, 'segments_final.json'), 'utf8'))
const lines = JSON.parse(readFileSync(join(here, 'narration.json'), 'utf8'))
const timing = JSON.parse(readFileSync(join(here, 'narration', 'timing.json'), 'utf8'))
const seconds = Object.fromEntries(timing.lines.map((l) => [l.id, l.seconds]))

/* ---------- 1) 旁白轨：每句对齐到对应段落起点 ---------- */
const inputs = []
const filters = []
const placed = []
segments.forEach((seg, i) => {
  inputs.push('-i', join(here, 'narration', `${seg.id}.wav`))
  const start = +(seg.start + LEAD).toFixed(3)
  filters.push(`[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
    `adelay=${Math.round(start * 48000)}S:all=1,volume=1[n${i}]`)
  placed.push({ id: seg.id, start, end: +(start + seconds[seg.id]).toFixed(3), seconds: seconds[seg.id] })
})
filters.push(`${placed.map((_, i) => `[n${i}]`).join('')}amix=inputs=${placed.length}:duration=longest:normalize=0,` +
  `apad,atrim=duration=${duration}[narr]`)
execFileSync(FFMPEG, ['-v', 'error', '-y', ...inputs, '-filter_complex', filters.join(';'),
  '-map', '[narr]', '-ar', '48000', '-ac', '2', join(build, 'narration_full.wav')], { stdio: 'inherit' })

/* ---------- 2) ASS 字幕（底部居中，青色字） ---------- */
const rows = []
segments.forEach((seg, i) => {
  const line = lines.find((l) => l.id === seg.id)
  if (!line?.sub) return
  const end = (segments[i + 1]?.start ?? duration) - 0.12
  rows.push({ start: +seg.start.toFixed(2), end: +end.toFixed(2), text: line.sub })
})
const ts = (cs) => {
  const h = Math.floor(cs / 360000)
  const m = Math.floor(cs / 6000) % 60
  const s = Math.floor(cs / 100) % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}
const ass = [
  '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Noto Sans SC,46,&H00FFEDA0,&H00FFEDA0,&H96000000,&H96000000,0,0,0,0,100,100,1,0,3,14,0,2,80,80,64,1',
  '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ...rows.map((r) => `Dialogue: 0,${ts(Math.ceil(r.start * 100))},${ts(Math.ceil(r.end * 100))},Default,,0,0,0,,${r.text}`),
  '',
].join('\n')
writeFileSync(join(build, 'captions.ass'), ass, 'utf8')

/* ---------- 3) 混音：旁白 + 配乐（侧链压低、首尾淡入淡出），先出 wav ---------- */
const fadeOut = (duration - 2.4).toFixed(2)
const mixGraph = [
  `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
    `afade=t=in:st=0:d=1.4,afade=t=out:st=${fadeOut}:d=2.4,volume=0.34[music]`,
  `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=2[voice][ctrl]`,
  `[music][ctrl]sidechaincompress=threshold=0.03:ratio=7:attack=12:release=280:link=maximum[duck]`,
  `[duck][voice]amix=inputs=2:duration=longest:normalize=0,apad,atrim=duration=${duration}[mix]`,
].join(';')
execFileSync(FFMPEG, ['-v', 'error', '-y',
  '-i', join(build, 'narration_full.wav'), '-stream_loop', '-1', '-i', MUSIC,
  '-filter_complex', mixGraph, '-map', '[mix]', '-t', String(duration),
  '-ar', '48000', '-ac', '2', join(build, 'mix_raw.wav')], { stdio: 'inherit' })

/* ---------- 4) 量响度后补静态增益，再出一版 ---------- */
const ebu = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', join(build, 'mix_raw.wav'),
  '-af', 'ebur128=peak=true', '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null'],
{ encoding: 'utf8' })
const log = `${ebu.stdout || ''}${ebu.stderr || ''}`
function measure(text) {
  const block = text.slice(text.lastIndexOf('Summary:'))
  const i = /I:\s*(-?\d+(?:\.\d+)?) LUFS/.exec(block)
  const tp = /Peak:\s*(-?\d+(?:\.\d+)?) dBFS/.exec(block)
  return { lufs: i ? Number(i[1]) : null, truePeak: tp ? Number(tp[1]) : null }
}
const loud = measure(log)
// 目标 -16 LUFS：测得 -18.7 就补 +2.7 dB，最多补 6 dB，避免把人声推爆
let gain = loud.lufs !== null ? Math.max(-3, Math.min(6, -16 - loud.lufs)) : 0
const GRAPH_LIMIT = 'alimiter=limit=0.94:attack=5:release=60'

/* ---------- 5) 终编：烧字幕 + 上混音 ---------- */
const finalGraph = `[1:v]ass=filename=captions.ass[v]`
execFileSync(FFMPEG, ['-v', 'error', '-y',
  '-i', join(build, 'mix_raw.wav'), '-i', join(build, 'base.mp4'),
  // ffmpeg 的 volume 取线性倍数，dB 要换成 10^(dB/20)
  '-filter_complex', `${finalGraph};[0:a]volume=${Math.pow(10, gain / 20).toFixed(4)},${GRAPH_LIMIT},aresample=48000[aout]`,
  '-map', '[v]', '-map', '[aout]', '-t', String(duration), '-r', '30',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
  '-movflags', '+faststart', join(build, 'siren-promo-v2.mp4')],
{ stdio: 'inherit', cwd: build })

const probe = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_format', '-show_streams',
  '-of', 'json', join(build, 'siren-promo-v2.mp4')], { encoding: 'utf8' }))
writeFileSync(join(build, 'qa.json'), JSON.stringify({
  duration, placed, measured: loud, gainApplied: +gain.toFixed(2),
  probe: {
    format: probe.format.duration,
    bit_rate: probe.format.bit_rate,
    streams: probe.streams.map((s) => ({ codec: s.codec_name, type: s.codec_type, w: s.width, h: s.height,
      fps: s.r_frame_rate, sr: s.sample_rate, ch: s.channels })),
  },
}, null, 2), 'utf8')
console.log(JSON.stringify({ duration, gain: +gain.toFixed(2), measured: loud, placed: placed.map((p) => `${p.id}:${p.start}-${p.end}`) }))
