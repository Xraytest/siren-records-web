import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_RETRY,
  RETRY_BASE_MS,
  STABLE_MS,
  canRetry,
  retryDelay,
  shouldClearRetry,
} from '../src/lib/retry-policy.ts'

test('退避间隔：800ms / 1.6s / 3.2s / 6.4s', () => {
  assert.equal(retryDelay(1), RETRY_BASE_MS)
  assert.equal(retryDelay(2), RETRY_BASE_MS * 2)
  assert.equal(retryDelay(3), RETRY_BASE_MS * 4)
  assert.equal(retryDelay(4), RETRY_BASE_MS * 8)
  // 异常入参不应产生 0 或负数（会变成立即重连的死循环）
  assert.equal(retryDelay(0), RETRY_BASE_MS)
  assert.equal(retryDelay(-3), RETRY_BASE_MS)
  assert.equal(retryDelay(2.7), RETRY_BASE_MS * 2)
})

test('重试预算：到 MAX_RETRY 就不再自动重连', () => {
  assert.equal(canRetry(0), true)
  assert.equal(canRetry(MAX_RETRY - 1), true)
  assert.equal(canRetry(MAX_RETRY), false)
  assert.equal(canRetry(MAX_RETRY + 3), false)
})

test('刚出声不算成功：play() resolve 之后立刻断流不能清零重试计数', () => {
  const t0 = 1_000_000
  // 第 1 次重连成功出声，但 300ms 后又被掐断
  assert.equal(shouldClearRetry(1, t0, t0 + 300), false)
  // 稳定播放不满 10s 都不能清零
  assert.equal(shouldClearRetry(3, t0, t0 + STABLE_MS - 1), false)
  // 播满 10s 才算真的成功
  assert.equal(shouldClearRetry(3, t0, t0 + STABLE_MS), true)
  assert.equal(shouldClearRetry(3, t0, t0 + STABLE_MS + 5_000), true)
})

test('从未出声（startedAt=0）或没有失败次数时不清零', () => {
  assert.equal(shouldClearRetry(2, 0, Date.now()), false)
  assert.equal(shouldClearRetry(0, 1_000, 1_000 + STABLE_MS * 10), false)
})

test('抖动流：反复「播起来→断掉」会在 4 次后用尽预算，而不是无限重连', () => {
  let attempts = 0
  let stableSince = 0
  let now = 0
  // 模拟 20 个周期：每次起播 500ms 后被掐断
  for (let cycle = 0; cycle < 20; cycle += 1) {
    if (!canRetry(attempts)) break
    attempts += 1
    stableSince = now // 刚出声，稳定窗口起点
    now += 500 // 500ms 后断流
    assert.equal(shouldClearRetry(attempts, stableSince, now), false)
  }
  assert.equal(attempts, MAX_RETRY, '抖动流必须停在 MAX_RETRY 次，而不是无限循环')
  assert.equal(canRetry(attempts), false)
})

test('稳定流：连续播满 10s 会把预算还回去', () => {
  let attempts = 2
  const stableSince = 50_000
  const now = stableSince + STABLE_MS + 1
  if (shouldClearRetry(attempts, stableSince, now)) attempts = 0
  assert.equal(attempts, 0)
  assert.equal(canRetry(attempts), true)
})
