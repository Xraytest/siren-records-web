// 从线上站的 /api/audio/<cid> 换取官方 CDN 签名地址并下载 MSR 曲目
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'D:/WorkSpace/siren-records-web/promo'
const BASE = process.env.BASE_URL || 'https://siren.neolx.ltd'
const OUT = join(ROOT, 'bgm')

const TRACKS = [
  { name: 'stultifera', cid: '953915', label: '愚人曲 (愚人号OST)' },
  { name: 'radiant', cid: '048738', label: 'Radiant' },
  { name: 'speed', cid: '880374', label: 'Speed of Light' },
]

await mkdir(OUT, { recursive: true })

for (const t of TRACKS) {
  const redirect = await fetch(`${BASE}/api/audio/${t.cid}`, { redirect: 'manual' })
  const location = redirect.headers.get('location')
  if (!location) {
    console.log(`${t.name}: 没拿到签名地址 (${redirect.status})`)
    continue
  }
  const res = await fetch(location)
  if (!res.ok) {
    console.log(`${t.name}: 下载失败 ${res.status}`)
    continue
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const file = join(OUT, `${t.name}.mp3`)
  await writeFile(file, buf)
  console.log(`${t.name}: ${t.label} -> ${(buf.length / 1024 / 1024).toFixed(2)}MB  ${location.slice(0, 70)}...`)
}
