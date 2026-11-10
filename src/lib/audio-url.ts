/**
 * 播放地址拼装（纯函数，便于单测）。
 *
 * 不带参数时是 `/api/audio/<cid>`：服务端 302 到官方 CDN，浏览器直接取字节。
 * 带 `via=proxy` 时服务端自己回源转发，客户端只连本站边缘节点。
 *
 * 为什么要两条路：官方专辑 936 首里 753 首是 8–50 MB 的 WAV 原文件，
 * 客户端到 hycdn 的带宽一旦不足就会「一直转圈 / 播两秒就停」。
 * 两条路走的是不同路由，哪条快取决于客户端所处网络，因此交给用户切换。
 */
export interface AudioSrcOptions {
  /** 走本站转发（/api/audio/<cid>?via=proxy） */
  proxy?: boolean
  /** 加时间戳绕过旧签名与旧缓存 */
  bust?: boolean
}

export function audioSrcFor(cid: string, opts: AudioSrcOptions = {}): string {
  const params = new URLSearchParams()
  if (opts.proxy) params.set('via', 'proxy')
  if (opts.bust) params.set('r', String(Date.now()))
  const query = params.toString()
  return `/api/audio/${cid}${query ? `?${query}` : ''}`
}
