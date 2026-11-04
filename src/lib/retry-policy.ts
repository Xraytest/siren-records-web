/**
 * 播放失败自动重连的策略常量与纯函数。
 *
 * 历史缺陷（P2-3）：重试计数在 `play()` resolve / `playing` 事件里就清零，
 * 而这两个时机只表示「刚刚开始出声」。于是「先播起来、再被边缘节点掐断」的流
 * 永远累计不到 MAX_RETRY 次，播放器变成每 800ms 重载一次的无限循环，
 * UI 上的「重连 n/4」永远停在 1，与「共 4 次后暂停」的承诺相反。
 *
 * 现在的规则：一次连接必须连续稳定播放 STABLE_MS 毫秒才算成功，
 * 只有成功才把重试预算还给用户；失败次数用尽后暂停，等用户手动恢复。
 */

/** 自动重连最多尝试几次；之后交给用户手动重试 */
export const MAX_RETRY = 4
/** 首次重连等待：800ms，之后 1.6s / 3.2s / 6.4s */
export const RETRY_BASE_MS = 800
/** 连续播放这么久（且进度在前进）才认为这次连接真的成功 */
export const STABLE_MS = 10_000
/** 播放中超过这个时长没有任何进度且未缓冲完成，判定为卡死并重连 */
export const STALL_MS = 15_000

/** 第 attempt 次重连（从 1 开始）之前要等待的毫秒数 */
export function retryDelay(attempt: number): number {
  const safe = Math.max(1, Math.floor(attempt))
  return RETRY_BASE_MS * 2 ** (safe - 1)
}

/** 还有没有自动重连预算 */
export function canRetry(attempts: number): boolean {
  return attempts < MAX_RETRY
}

/**
 * 是否可以把重试计数清零。
 * @param attempts 当前已失败次数
 * @param startedAt 本次「开始出声」的时间戳；0 表示还没出过声
 * @param now 当前时间戳
 */
export function shouldClearRetry(attempts: number, startedAt: number, now: number): boolean {
  if (attempts <= 0) return false
  if (!startedAt) return false
  return now - startedAt >= STABLE_MS
}
