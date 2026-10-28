// 按脚本来剪 MSR 配乐：
//   0 → 13s   《愚人曲》前奏（磁带底噪 + 合成器渐入）
//   13s → 尾  《Radiant》主体（鼓点清楚，便于踩点）
// 全程在旁白下做 ducking，尾部淡出。
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const here = new URL('.', import.meta.url).pathname.slice(1)
const bgm = join(here, 'bgm')
const build = join(here, 'build')
const FFMPEG = process.env.FFMPEG || 'ffmpeg'
const DURATION = Number(process.env.DURATION || '67.38')
const SWITCH_AT = 13.0 // 与旁白 s1→s2 的分界对齐（s2 从 13.16s 开始）
const FADE_OUT = 2.4

// 1) 愚人曲：取前奏，长度 = SWITCH_AT
// 2) Radiant：从鼓点进入处取，长度覆盖剩余全程
const introLen = SWITCH_AT
const restLen = DURATION - SWITCH_AT + 0.5 // 多取一点，交给 acrossfade 消耗
const graph = [
  `[0:a]aresample=48000,atrim=0:${introLen},asetpts=PTS-STARTPTS,` +
    `afade=t=in:st=0:d=1.6,afade=t=out:st=${(introLen - 1.2).toFixed(2)}:d=1.2,volume=0.9[intro]`,
  `[1:a]aresample=48000,atrim=0:${restLen},asetpts=PTS-STARTPTS,` +
    `afade=t=out:st=${(restLen - FADE_OUT).toFixed(2)}:d=${FADE_OUT},volume=0.9[body]`,
  `[intro][body]acrossfade=d=1.2:c1=tri:c2=tri[bed]`,
  `[bed]apad,atrim=duration=${DURATION}[out]`,
].join(';')

execFileSync(FFMPEG, ['-v', 'error', '-y',
  '-i', join(bgm, 'stultifera.mp3'),
  '-i', join(bgm, 'radiant.mp3'),
  '-filter_complex', graph, '-map', '[out]',
  '-ar', '48000', '-ac', '2', join(build, 'msr_bed.wav')], { stdio: 'inherit' })

const { execFileSync: run } = await import('node:child_process')
const dur = run(process.env.FFPROBE || 'ffprobe',
  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', join(build, 'msr_bed.wav')],
  { encoding: 'utf8' })
console.log(`msr_bed.wav -> ${Number(dur.trim()).toFixed(2)}s`)
