/**
 * 播放地址拼装（纯函数，便于单测）。
 *
 * 一律返回 `/api/audio/<cid>`：服务端只回 302 到官方 CDN，字节由浏览器直连取。
 * 实测经本站边缘回源反而更慢（首字节 0.8–7.9 s vs 直连 126–160 ms），
 * 所以这里不存在「转发」分支——播放链路必须是最短的那条。
 */
export interface AudioSrcOptions {
  /** 加时间戳绕过旧签名与旧缓存（重连/手动重试时用） */
  bust?: boolean
}

export function audioSrcFor(cid: string, opts: AudioSrcOptions = {}): string {
  if (!opts.bust) return `/api/audio/${cid}`
  return `/api/audio/${cid}?r=${Date.now()}`
}
