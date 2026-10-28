// 把每段的帧按「该段旁白时长」均分，拼成 30fps 基准片；末尾接片尾卡。
// 输出：build/base.mp4 + build/segments_final.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cap = join(here, 'capture')
const build = join(here, 'build')
const FFMPEG = process.env.FFMPEG || 'ffmpeg'
mkdirSync(build, { recursive: true })

const { segments, fps } = JSON.parse(readFileSync(join(cap, 'segments.json'), 'utf8'))
const timing = JSON.parse(readFileSync(join(here, 'narration', 'timing.json'), 'utf8'))
const s8 = timing.lines.find((l) => l.id === 's8').seconds
const ENDCARD = +(s8 + 1.6).toFixed(3)
// 每段比旁白多留 0.3s：旁白在段内起音晚 0.3s，收尾正好落在段末，段间不留空档
const LEAD = 0.3

const lines = []
const out = []
let t = 0
for (const seg of segments) {
  const n = seg.frames.length
  const segLen = +(seg.duration + LEAD).toFixed(3)
  const step = segLen / n
  seg.frames.forEach((name, i) => {
    lines.push(`file 'frames/${name}'`)
    // 最后一帧承接尾差，保证段长精确等于 旁白时长 + LEAD
    const gap = i === n - 1 ? +(segLen - step * (n - 1)).toFixed(4) : +step.toFixed(4)
    lines.push(`duration ${gap.toFixed(4)}`)
  })
  out.push({ id: seg.id, start: +t.toFixed(3), duration: segLen, narration: seg.duration, frames: n })
  t += segLen
}
writeFileSync(join(cap, 'concat_final.txt'), lines.join('\n') + '\n', 'utf8')
const siteDuration = +t.toFixed(3)

execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(cap, 'concat_final.txt'),
  '-vf', 'fps=30,scale=1920:1080:flags=lanczos,format=yuv420p',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p',
  '-r', '30', '-t', String(siteDuration), '-an', '-movflags', '+faststart', join(build, 'site.mp4')],
{ stdio: 'inherit' })

const duration = +(siteDuration + ENDCARD).toFixed(3)
execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', join(build, 'site.mp4'),
  '-loop', '1', '-framerate', '30', '-t', String(ENDCARD), '-i', join(here, 'endcard.png'),
  '-filter_complex',
  `[0:v]fps=30,scale=1920:1080,setsar=1[site];[1:v]fps=30,scale=1920:1080,setsar=1,format=yuv420p[card];` +
  `[site][card]concat=n=2:v=1:a=0[v]`,
  '-map', '[v]', '-r', '30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', join(build, 'base.mp4')],
{ stdio: 'inherit' })

out.push({ id: 's8', start: +siteDuration.toFixed(3), duration: ENDCARD, kind: 'endcard' })
writeFileSync(join(build, 'segments_final.json'),
  JSON.stringify({ duration, siteDuration, endcard: ENDCARD, captureFps: fps, segments: out }, null, 2), 'utf8')
console.log(JSON.stringify({ duration, siteDuration, endcard: ENDCARD, segments: out.map((s) => `${s.id}@${s.start}+${s.duration}`) }))
