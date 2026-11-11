import assert from 'node:assert/strict'
import test from 'node:test'
import {
  catalogModeFromHeader,
  decideUpdate,
  metaFromCatalog,
  normalizeMeta,
  normalizeVersion,
  noteForSyncResponse,
} from '../src/lib/catalog-meta.ts'

/* ---------- 测试数据 ---------- */

function catalog(overrides: Record<string, unknown> = {}) {
  return {
    version: 7,
    generatedAt: '2026-11-01T00:00:00.000Z',
    syncedAt: '2026-11-02T00:00:00.000Z',
    lastCheckAt: '2026-11-03T00:00:00.000Z',
    source: 'msr',
    albums: [{ songs: [{}, {}] }, { songs: [{}] }, { songs: null }],
    ...overrides,
  }
}

/* ---------- 版本号 ---------- */

test('normalizeVersion：只认正数整数，其余一律 0（避免 NaN 让比较恒真）', () => {
  assert.equal(normalizeVersion(7), 7)
  assert.equal(normalizeVersion('12'), 12)
  assert.equal(normalizeVersion(3.9), 3)
  assert.equal(normalizeVersion(0), 0)
  assert.equal(normalizeVersion(-2), 0)
  assert.equal(normalizeVersion(undefined), 0)
  assert.equal(normalizeVersion(null), 0)
  assert.equal(normalizeVersion('abc'), 0)
  assert.equal(normalizeVersion(Number.POSITIVE_INFINITY), 0)
})

/* ---------- 响应头 → 模式 ---------- */

test('catalogModeFromHeader：只有 snapshot 才算快照，大小写与空值都要兼容', () => {
  assert.equal(catalogModeFromHeader('snapshot'), 'snapshot')
  assert.equal(catalogModeFromHeader('SNAPSHOT'), 'snapshot')
  assert.equal(catalogModeFromHeader(' Snapshot '), 'live', '带空格的值不算数：后端从没这么发过')
  assert.equal(catalogModeFromHeader('live'), 'live')
  assert.equal(catalogModeFromHeader(''), 'live')
  assert.equal(catalogModeFromHeader(null), 'live')
  assert.equal(catalogModeFromHeader(undefined), 'live')
})

/* ---------- 曲库正文 → 元信息 ---------- */

test('metaFromCatalog：曲目数按专辑累加，live 模式不算 stale', () => {
  const meta = metaFromCatalog(catalog(), 'live')
  assert.equal(meta.version, 7)
  assert.equal(meta.albums, 3)
  assert.equal(meta.songs, 3, 'songs: null 的专辑不贡献曲目，也不能抛异常')
  assert.equal(meta.mode, 'live')
  assert.equal(meta.stale, false)
  assert.equal(meta.lastError, '')
  assert.equal(meta.source, 'msr')
  assert.equal(meta.syncedAt, '2026-11-02T00:00:00.000Z')
  assert.equal(meta.lastCheckAt, '2026-11-03T00:00:00.000Z')
})

test('metaFromCatalog：时间字段逐级回退，快照模式一律 stale', () => {
  const bare = metaFromCatalog({ albums: [] }, 'snapshot')
  assert.equal(bare.generatedAt, '')
  assert.equal(bare.syncedAt, '')
  assert.equal(bare.lastCheckAt, '')
  assert.equal(bare.mode, 'snapshot')
  assert.equal(bare.stale, true, '静态快照就是过期数据，界面上必须标出来')

  const fallback = metaFromCatalog({ albums: [], generatedAt: 'G' }, 'live')
  assert.equal(fallback.syncedAt, 'G', '没有 syncedAt 时退回 generatedAt')
  assert.equal(fallback.lastCheckAt, 'G')

  const chain = metaFromCatalog({ albums: [], generatedAt: 'G', syncedAt: 'S' }, 'live')
  assert.equal(chain.syncedAt, 'S')
  assert.equal(chain.lastCheckAt, 'S', '没有 lastCheckAt 时退回 syncedAt')
})

test('metaFromCatalog：响应头里的同步时间优先于正文（正文是缓存的快照体）', () => {
  const meta = metaFromCatalog(catalog(), 'live', '2026-11-09T12:00:00.000Z')
  assert.equal(meta.syncedAt, '2026-11-09T12:00:00.000Z')
  // 空头不能把正文里的时间抹掉
  assert.equal(metaFromCatalog(catalog(), 'live', '').syncedAt, '2026-11-02T00:00:00.000Z')
  assert.equal(metaFromCatalog(catalog(), 'live', '   ').syncedAt, '2026-11-02T00:00:00.000Z')
})

/* ---------- /api/catalog/meta 规范化 ---------- */

test('normalizeMeta：非对象直接判无效，缺字段填默认值', () => {
  assert.equal(normalizeMeta(null), null)
  assert.equal(normalizeMeta(undefined), null)
  assert.equal(normalizeMeta('meta'), null)
  assert.equal(normalizeMeta(42), null)

  const meta = normalizeMeta({ version: '5', albums: '3', songs: 12, stale: 1 })
  assert.ok(meta)
  assert.equal(meta.version, 5)
  assert.equal(meta.albums, 3)
  assert.equal(meta.songs, 12)
  assert.equal(meta.mode, 'live')
  assert.equal(meta.stale, true)
  assert.equal(meta.generatedAt, '')
  assert.equal(meta.lastError, '')
  assert.equal(meta.lastWarning, undefined, '缺失的可选字段不能变成 undefined 键值对以外的东西')
})

test('normalizeMeta：可选告警字段只在类型正确时透传', () => {
  const meta = normalizeMeta({
    version: 2,
    lastWarning: '部分专辑暂未更新',
    lastWarningAt: '2026-11-10T00:00:00.000Z',
    pendingRemoval: 3,
    lastRemoved: 1,
    lastReason: 'manual',
  })
  assert.ok(meta)
  assert.equal(meta.lastWarning, '部分专辑暂未更新')
  assert.equal(meta.lastWarningAt, '2026-11-10T00:00:00.000Z')
  assert.equal(meta.pendingRemoval, 3)
  assert.equal(meta.lastRemoved, 1)
  assert.equal(meta.lastReason, 'manual')

  const dirty = normalizeMeta({ version: 2, lastWarning: 5, pendingRemoval: '3' })
  assert.ok(dirty)
  assert.equal(dirty.lastWarning, undefined)
  assert.equal(dirty.pendingRemoval, undefined, '字符串数字不猜，宁可当没有')
})

/* ---------- 轮询决策 ---------- */

test('decideUpdate：正文无效就忽略，不误触发重拉', () => {
  assert.deepEqual(decideUpdate(null, null), { action: 'ignore' })
  assert.deepEqual(decideUpdate({ version: 3, mode: 'live' }, 'oops'), { action: 'ignore' })
})

test('decideUpdate：首次检查（无上一版）在 live 模式下必然重拉', () => {
  assert.deepEqual(decideUpdate(null, { version: 3, mode: 'live' }), { action: 'reload' })
})

test('decideUpdate：live 模式版本号变化才重拉，没变只更新元信息', () => {
  assert.deepEqual(decideUpdate({ version: 3, mode: 'live' }, { version: 4, mode: 'live' }), { action: 'reload' })

  const same = decideUpdate({ version: 3, mode: 'live' }, { version: 3, mode: 'live', albums: 9 })
  assert.equal(same.action, 'meta')
  assert.equal(same.action === 'meta' && same.meta.albums, 9)
})

test('decideUpdate：快照模式下版本号对不上也不许重拉（每 5 分钟白拉 484KB 的坑）', () => {
  // 快照正文里 version 是 7，meta 接口在无数据库时回 0：不能因此判定「版本变了」
  const decision = decideUpdate({ version: 7, mode: 'snapshot' }, { version: 0, mode: 'snapshot' })
  assert.equal(decision.action, 'meta')
})

test('decideUpdate：模式切换（live ⇄ snapshot）必须重拉，快照内容可能整体不同', () => {
  assert.deepEqual(decideUpdate({ version: 3, mode: 'live' }, { version: 3, mode: 'snapshot' }), { action: 'reload' })
  assert.deepEqual(decideUpdate({ version: 3, mode: 'snapshot' }, { version: 3, mode: 'live' }), { action: 'reload' })
})

/* ---------- 手动同步的说明文案 ---------- */

test('noteForSyncResponse：限流、后端失败、部分失败都要如实说出来', () => {
  assert.equal(noteForSyncResponse(429, null), '官方接口刚查过，请稍后再试')
  assert.equal(noteForSyncResponse(500, { error: 'D1 不可用' }), 'D1 不可用')
  assert.equal(noteForSyncResponse(500, null), '同步接口返回 500')
  assert.equal(noteForSyncResponse(200, { ok: false, error: '官方接口超时' }), '官方接口超时')
  assert.equal(noteForSyncResponse(200, { ok: false }), '后端同步失败')
  assert.equal(noteForSyncResponse(200, { ok: true, warnings: ['a', 'b'] }), '部分专辑暂未更新（2 条）')
})

test('noteForSyncResponse：一切正常时返回空串，让调用方说「已是最新」', () => {
  assert.equal(noteForSyncResponse(200, { ok: true }), '')
  assert.equal(noteForSyncResponse(202, { started: true }), '')
  assert.equal(noteForSyncResponse(200, null), '')
  assert.equal(noteForSyncResponse(200, { ok: true, warnings: [] }), '')
})
