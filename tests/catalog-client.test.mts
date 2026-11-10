import assert from 'node:assert/strict'
import test from 'node:test'
import { describeDiff, diffSummary, normalizeVersion } from '../src/lib/catalog-diff.ts'

test('diffSummary：首次载入视为全部新增', () => {
  const diff = diffSummary(null, { albums: [{ cid: 'a' }, { cid: 'b' }], songs: 12 })
  assert.deepEqual(diff, { added: 2, removed: 0, songsAdded: 12, songsRemoved: 0 })
})

test('diffSummary：新专辑与新增曲目都算出来', () => {
  const diff = diffSummary(
    { albums: [{ cid: 'a' }, { cid: 'b' }], songs: 10 },
    { albums: [{ cid: 'a' }, { cid: 'b' }, { cid: 'c' }], songs: 14 },
  )
  assert.deepEqual(diff, { added: 1, removed: 0, songsAdded: 4, songsRemoved: 0 })
})

test('diffSummary：下架专辑与曲目减少不会被吞掉', () => {
  const diff = diffSummary(
    { albums: [{ cid: 'a' }, { cid: 'b' }], songs: 10 },
    { albums: [{ cid: 'a' }], songs: 7 },
  )
  assert.deepEqual(diff, { added: 0, removed: 1, songsAdded: 0, songsRemoved: 3 })
})

test('describeDiff：无变化返回 null，有变化给出一句话', () => {
  assert.equal(describeDiff({ added: 0, removed: 0, songsAdded: 0, songsRemoved: 0 }), null)
  assert.equal(
    describeDiff({ added: 2, removed: 0, songsAdded: 9, songsRemoved: 0 }),
    '曲库已同步 · 新增 2 张专辑 · +9 首',
  )
  assert.equal(
    describeDiff({ added: 0, removed: 1, songsAdded: 0, songsRemoved: 2 }),
    '曲库已同步 · 下架 1 张专辑 · -2 首',
  )
})

test('normalizeVersion：非法值归零，避免 NaN 比较永远为真', () => {
  assert.equal(normalizeVersion(undefined), 0)
  assert.equal(normalizeVersion(null), 0)
  assert.equal(normalizeVersion('abc'), 0)
  assert.equal(normalizeVersion(-3), 0)
  assert.equal(normalizeVersion('12'), 12)
  assert.equal(normalizeVersion(7.9), 7)
})
