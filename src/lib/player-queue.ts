/**
 * 播放队列推进规则（纯函数）。
 *
 * 这里刻意不依赖 React / DOM：循环、随机、队首队尾等边界情形由 tests/player-queue.test.mts
 * 直接覆盖，避免再出现「选了循环但播到队尾就停」这类回归。
 */

export type RepeatMode = 'off' | 'all' | 'one'

export interface AdvanceInput {
  repeat: RepeatMode
  shuffle: boolean
  index: number
  length: number
  /** 随机源，测试时可注入确定性实现 */
  random?: () => number
  /** 随机模式下已经放过的位置（repeat=off 时避免重复、播完即停） */
  played?: Set<number>
}

export type AdvanceResult =
  | { kind: 'play'; index: number; restart: boolean }
  | { kind: 'stop' }

/**
 * 下一首的决策：
 * - 单曲循环：原地重播；
 * - 列表循环：队尾回到队首；单曲队列原地重播（旧实现这里会静默停住）；
 * - 不循环：到队尾停止；
 * - 随机：不重复当前曲目；不循环时放完本轮即停，列表循环时持续随机。
 */
export function advanceTrack(input: AdvanceInput): AdvanceResult {
  const { repeat, shuffle, index, length } = input
  const random = input.random ?? Math.random
  if (!length) return { kind: 'stop' }
  if (repeat === 'one') return { kind: 'play', index, restart: true }
  if (length === 1) {
    return repeat === 'all' ? { kind: 'play', index: 0, restart: true } : { kind: 'stop' }
  }

  if (!shuffle) {
    if (index + 1 < length) return { kind: 'play', index: index + 1, restart: false }
    return repeat === 'all' ? { kind: 'play', index: 0, restart: true } : { kind: 'stop' }
  }

  const played = input.played ?? new Set<number>()
  const pool: number[] = []
  for (let i = 0; i < length; i++) {
    if (i === index) continue
    if (repeat === 'off' && played.has(i)) continue
    pool.push(i)
  }
  if (!pool.length) {
    if (repeat !== 'all') return { kind: 'stop' }
    // 列表循环 + 随机：一轮放完后重新随机一个（排除当前）
    const others: number[] = []
    for (let i = 0; i < length; i++) if (i !== index) others.push(i)
    return { kind: 'play', index: others[Math.floor(random() * others.length)], restart: false }
  }
  return { kind: 'play', index: pool[Math.floor(random() * pool.length)], restart: false }
}

/** 上一首：进度超过 4 秒先回到开头（由调用方判断），否则退一首；队首时仅在列表循环下绕到队尾 */
export function retreatTrack(input: { index: number; length: number; repeat: RepeatMode }): AdvanceResult {
  const { index, length, repeat } = input
  if (!length) return { kind: 'stop' }
  if (index > 0) return { kind: 'play', index: index - 1, restart: false }
  if (repeat === 'all' && length > 1) return { kind: 'play', index: length - 1, restart: false }
  return { kind: 'play', index: 0, restart: true }
}
