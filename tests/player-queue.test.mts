import assert from 'node:assert/strict'
import test from 'node:test'
import { advanceTrack, retreatTrack } from '../src/lib/player-queue.ts'

test('不循环：顺序推进，到队尾停止', () => {
  assert.deepEqual(advanceTrack({ repeat: 'off', shuffle: false, index: 0, length: 3 }), {
    kind: 'play',
    index: 1,
    restart: false,
  })
  assert.deepEqual(advanceTrack({ repeat: 'off', shuffle: false, index: 2, length: 3 }), {
    kind: 'stop',
  })
})

test('列表循环：队尾回到队首', () => {
  assert.deepEqual(advanceTrack({ repeat: 'all', shuffle: false, index: 2, length: 3 }), {
    kind: 'play',
    index: 0,
    restart: true,
  })
})

test('列表循环 + 单曲队列：原地重播而不是停住（旧 bug）', () => {
  assert.deepEqual(advanceTrack({ repeat: 'all', shuffle: false, index: 0, length: 1 }), {
    kind: 'play',
    index: 0,
    restart: true,
  })
  assert.deepEqual(advanceTrack({ repeat: 'off', shuffle: false, index: 0, length: 1 }), {
    kind: 'stop',
  })
})

test('单曲循环：任何位置都原地重播', () => {
  for (const index of [0, 1, 2]) {
    assert.deepEqual(advanceTrack({ repeat: 'one', shuffle: false, index, length: 3 }), {
      kind: 'play',
      index,
      restart: true,
    })
  }
})

test('随机 + 列表循环：不会选中当前曲目', () => {
  let seed = 7
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const seen = new Set<number>()
  for (let i = 0; i < 200; i++) {
    const result = advanceTrack({ repeat: 'all', shuffle: true, index: 1, length: 4, random })
    assert.equal(result.kind, 'play')
    if (result.kind === 'play') {
      assert.notEqual(result.index, 1, '随机模式不应重复当前曲目')
      seen.add(result.index)
    }
  }
  assert.deepEqual([...seen].sort(), [0, 2, 3])
})

test('随机 + 不循环：每首只放一次，放完即停', () => {
  const played = new Set<number>()
  let index = 0
  const order = [index]
  for (let i = 0; i < 10; i++) {
    played.add(index)
    const result = advanceTrack({ repeat: 'off', shuffle: true, index, length: 4, played })
    if (result.kind === 'stop') break
    index = result.index
    assert.ok(!order.includes(index), '不循环随机不应重复已放曲目')
    order.push(index)
  }
  assert.equal(order.length, 4, '应放完全部 4 首后停止')
  assert.deepEqual([...order].sort(), [0, 1, 2, 3])
})

test('空队列不推进', () => {
  assert.deepEqual(advanceTrack({ repeat: 'all', shuffle: true, index: 0, length: 0 }), {
    kind: 'stop',
  })
})

test('上一首：队首在列表循环下绕到队尾，否则原地重播', () => {
  assert.deepEqual(retreatTrack({ index: 2, length: 3, repeat: 'off' }), {
    kind: 'play',
    index: 1,
    restart: false,
  })
  assert.deepEqual(retreatTrack({ index: 0, length: 3, repeat: 'all' }), {
    kind: 'play',
    index: 2,
    restart: false,
  })
  assert.deepEqual(retreatTrack({ index: 0, length: 3, repeat: 'off' }), {
    kind: 'play',
    index: 0,
    restart: true,
  })
})
