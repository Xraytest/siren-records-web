import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OFFICIAL,
  buildAlbum,
  buildCatalogBody,
  fetchOfficialJson,
  matchesEtag,
  planSync,
  seedFromBaseline,
  syncCatalog,
} from '../shared/catalog-core.mjs'

const NOW = 1_700_000_000_000
// 测试里不重试、不等待：失败要立刻可见
const HTTP = { attempts: 1, retryDelayMs: 0 }

/* ---------- 测试替身 ---------- */

type Row = { cid: string; payload: string; songCount: number; updatedAt: number }

function makeStore(options: { albums?: Row[]; meta?: Record<string, string>; busy?: boolean } = {}) {
  const albums = new Map<string, Row>()
  for (const row of options.albums || []) albums.set(row.cid, { ...row })
  const meta: Record<string, string> = { ...(options.meta || {}) }
  const calls = { readSyncState: 0, readMetaKeys: 0 }
  // 与真实适配器一致：leaseUntil = "<到期毫秒>|<持有者 token>"
  const tokenOf = (value: unknown) => String(value || '').split('|')[1] || ''
  const store = {
    async readSyncState() {
      calls.readSyncState += 1
      return {
        meta: { ...meta },
        albums: [...albums.values()].map(({ cid, songCount, updatedAt }) => ({ cid, songCount, updatedAt })),
      }
    },
    async readMetaKeys(keys: string[]) {
      calls.readMetaKeys += 1
      const picked: Record<string, string> = {}
      for (const key of keys) if (key in meta) picked[key] = meta[key]
      return picked
    },
    async getAlbumPayload(cid: string) {
      return albums.get(cid)?.payload ?? null
    },
    async putAlbums(rows: Row[]) {
      for (const row of rows) albums.set(row.cid, { ...row })
    },
    async deleteAlbums(cids: string[]) {
      for (const cid of cids) albums.delete(cid)
    },
    async setMeta(patch: Record<string, string>) {
      Object.assign(meta, patch)
    },
    async stats() {
      let songs = 0
      for (const row of albums.values()) songs += row.songCount
      return { albums: albums.size, songs }
    },
    async acquireLease(now: number, ttlMs: number, token: string) {
      if (options.busy) return false
      const current = Number(String(meta.leaseUntil || '0').split('|')[0]) || 0
      if (current > now) return false
      meta.leaseUntil = `${now + ttlMs}|${token}`
      return true
    },
    async renewLease(token: string, now: number, ttlMs: number) {
      if (tokenOf(meta.leaseUntil) !== token) return false
      meta.leaseUntil = `${now + ttlMs}|${token}`
      return true
    },
    async releaseLease(token?: string) {
      if (!token) {
        meta.leaseUntil = '0'
        return
      }
      // 只清自己的租约：慢轮次收尾时不能把别人刚抢到的租约删掉
      if (tokenOf(meta.leaseUntil) === token) meta.leaseUntil = '0'
    },
  }
  return { store, albums, meta, calls, tokenOf }
}

function makeFetch(routes: Record<string, unknown>) {
  const calls: string[] = []
  const fetchImpl = async (input: unknown) => {
    const url = String(input)
    calls.push(url)
    const path = url.startsWith(OFFICIAL) ? url.slice(OFFICIAL.length) : url
    if (!(path in routes)) throw new Error(`测试没有配置 ${path}`)
    const raw = routes[path]
    const value = typeof raw === 'function' ? (raw as () => unknown)() : raw
    if (value instanceof Error) throw value
    // 与真实官方接口一致：成功响应带 application/json（fetchOfficialJson 会校验 Content-Type）
    return new Response(JSON.stringify({ code: 0, data: value }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetchImpl, calls }
}

function album(cid: string, name: string, songCids: string[]) {
  return {
    cid,
    name,
    intro: '',
    belong: '',
    coverUrl: `https://cdn/${cid}.jpg`,
    coverDeUrl: '',
    artistes: ['MSR'],
    songs: songCids.map((songCid) => ({
      cid: songCid,
      name: `${name}-${songCid}`,
      artistes: 'MSR',
      albumCid: cid,
      albumName: name,
      albumCover: `https://cdn/${cid}.jpg`,
      sourceUrl: '',
      lyricUrl: '',
    })),
  }
}

function listEntry(cid: string, name: string) {
  return { cid, name, coverUrl: `https://cdn/${cid}.jpg`, artistes: ['MSR'] }
}

function detail(cid: string, name: string, songCids: string[]) {
  return {
    cid,
    name,
    intro: '',
    belong: '',
    coverUrl: `https://cdn/${cid}.jpg`,
    coverDeUrl: '',
    songs: songCids.map((songCid) => ({ cid: songCid, name: `${name}-${songCid}`, artistes: ['MSR'] })),
  }
}

/* ---------- planSync ---------- */

test('planSync：识别新增、下架，并挑出最久没复查的专辑', () => {
  const officialList = [listEntry('0003', 'C'), listEntry('0002', 'B'), listEntry('0001', 'A')]
  const knownAlbums = [
    { cid: '0001', updatedAt: 1 },
    { cid: '0002', updatedAt: 2 },
    { cid: '0004', updatedAt: 3 },
  ]
  const plan = planSync({ officialList, knownAlbums, budgets: { refresh: 1 } })
  assert.deepEqual(
    plan.added.map((entry) => entry.cid),
    ['0003'],
  )
  assert.deepEqual(plan.removed, ['0004'])
  assert.deepEqual(
    plan.refresh.map((entry) => entry.cid),
    ['0001'],
  )
  assert.deepEqual(plan.officialCids, ['0003', '0002', '0001'])
  assert.equal(plan.suspicious, false)
})

test('planSync：官方列表突然变短时不删专辑，只报警', () => {
  const knownAlbums = Array.from({ length: 10 }, (_, i) => ({
    cid: String(i).padStart(4, '0'),
    updatedAt: i,
  }))
  const officialList = [listEntry('0000', 'A')]
  const plan = planSync({ officialList, knownAlbums })
  assert.equal(plan.suspicious, true)
  assert.deepEqual(plan.removed, [])
  assert.ok(plan.missing.length >= 9)
})

test('planSync：少量下架（1/4 以内）正常执行', () => {
  const knownAlbums = Array.from({ length: 8 }, (_, i) => ({ cid: `00${i}0`, updatedAt: i }))
  const officialList = knownAlbums.slice(0, 6).map((row) => listEntry(row.cid, row.cid))
  const plan = planSync({ officialList, knownAlbums })
  assert.equal(plan.suspicious, false)
  assert.deepEqual(
    plan.removed.sort(),
    ['0060', '0070'],
  )
})

/* ---------- buildAlbum ---------- */

test('buildAlbum：继承旧 sourceUrl / lyricUrl，新歌用 songInfo，artistes 数组拼成字符串', () => {
  const previous = album('0001', 'A', ['s1', 's2'])
  previous.songs[0].sourceUrl = 'https://audio/s1'
  previous.songs[1].lyricUrl = 'https://lyric/s2'

  const merged = buildAlbum(
    detail('0001', 'A', ['s1', 's2', 's3']),
    previous,
    new Map([['s3', { sourceUrl: 'https://audio/s3', lyricUrl: 'https://lyric/s3', artists: ['Z'] }]]),
    listEntry('0001', 'A'),
  )

  assert.equal(merged.songs.length, 3)
  assert.equal(merged.songs[0].sourceUrl, 'https://audio/s1')
  assert.equal(merged.songs[1].lyricUrl, 'https://lyric/s2')
  assert.equal(merged.songs[2].sourceUrl, 'https://audio/s3')
  assert.equal(merged.songs[2].lyricUrl, 'https://lyric/s3')
  assert.equal(merged.songs[2].artistes, 'Z')
  assert.equal(merged.songs[0].artistes, 'MSR')
  assert.equal(merged.coverUrl, 'https://cdn/0001.jpg')
  assert.equal(merged.albumName, undefined)
})

test('buildAlbum：官方给空歌单时用旧 payload 兜底，不把专辑清空', () => {
  const previous = album('0001', 'A', ['s1'])
  const merged = buildAlbum({ ...detail('0001', 'A', []), songs: [] }, previous, new Map(), listEntry('0001', 'A'))
  assert.equal(merged.songs.length, 1)
})

/* ---------- buildCatalogBody ---------- */

test('buildCatalogBody：按 order 拼装，未知 cid 追加到末尾，仍是合法 JSON', () => {
  const body = buildCatalogBody({
    generatedAt: '2026-10-22T16:05:44.515Z',
    source: OFFICIAL,
    version: 7,
    syncedAt: '2026-11-10T05:00:00.000Z',
    lastCheckAt: '2026-11-10T05:00:00.000Z',
    albums: [
      { cid: 'b', payload: JSON.stringify(album('b', 'B', [])) },
      { cid: 'a', payload: JSON.stringify(album('a', 'A', [])) },
      { cid: 'c', payload: JSON.stringify(album('c', 'C', [])) },
    ],
    order: ['a', 'b'],
  })
  const parsed = JSON.parse(body)
  assert.deepEqual(
    parsed.albums.map((item: { cid: string }) => item.cid),
    ['a', 'b', 'c'],
  )
  assert.equal(parsed.version, 7)
  assert.equal(parsed.syncedAt, '2026-11-10T05:00:00.000Z')
})

test('buildCatalogBody：order 里有但库里没有的 cid 直接跳过', () => {
  const body = buildCatalogBody({
    generatedAt: 'g',
    source: OFFICIAL,
    version: 1,
    albums: [{ cid: 'a', payload: JSON.stringify(album('a', 'A', [])) }],
    order: ['zzz', 'a'],
  })
  assert.equal(JSON.parse(body).albums.length, 1)
})

/* ---------- fetchOfficialJson ---------- */

test('fetchOfficialJson：网络抖动会重试，成功一次就返回 data', async () => {
  let attempts = 0
  const data = await fetchOfficialJson('/api/albums', {
    attempts: 3,
    retryDelayMs: 1,
    fetchImpl: async () => {
      attempts += 1
      if (attempts < 3) throw new Error('ECONNRESET')
      return new Response(JSON.stringify({ code: 0, data: { ok: 1 } }), {
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  assert.deepEqual(data, { ok: 1 })
  assert.equal(attempts, 3)
})

test('fetchOfficialJson：code 非 0 视为失败', async () => {
  await assert.rejects(
    fetchOfficialJson('/api/album/xxxx/detail', {
      attempts: 1,
      retryDelayMs: 1,
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: 104, msg: '找不到专辑' }), {
          headers: { 'content-type': 'application/json' },
        }),
    }),
    /104/,
  )
})

test('fetchOfficialJson：官方接口 3xx 直接失败，不跟进也不重试', async () => {
  let calls = 0
  let seenRedirect: unknown
  await assert.rejects(
    fetchOfficialJson('/api/albums', {
      attempts: 3,
      retryDelayMs: 1,
      fetchImpl: async (_url: string, init: any) => {
        calls += 1
        seenRedirect = init?.redirect
        return new Response(null, {
          status: 302,
          headers: { location: 'https://example.invalid/' },
        })
      },
    }),
    /重定向/,
  )
  assert.equal(calls, 1)
  // Workers 的 fetch 不接受 'error'（会抛 TypeError 让整轮同步失败），必须用 'manual'
  assert.equal(seenRedirect, 'manual')
})

/* ---------- seedFromBaseline ---------- */

test('seedFromBaseline：铺底写入专辑与元信息', async () => {
  const { store, albums, meta } = makeStore()
  const baseline = {
    generatedAt: '2026-10-22T16:05:44.515Z',
    source: OFFICIAL,
    albums: [album('0001', 'A', ['s1']), album('0002', 'B', ['s2', 's3'])],
  }
  const count = await seedFromBaseline(store, baseline, NOW)
  assert.equal(count, 2)
  assert.equal(albums.size, 2)
  assert.equal(meta.albums, '2')
  assert.equal(meta.songs, '3')
  assert.equal(meta.version, '1')
  assert.deepEqual(JSON.parse(meta.order), ['0001', '0002'])
})

/* ---------- syncCatalog ---------- */

function baselineOf() {
  return {
    generatedAt: '2026-10-22T16:05:44.515Z',
    source: OFFICIAL,
    albums: [album('0001', 'A', ['s1']), album('0002', 'B', ['s2'])],
  }
}

test('syncCatalog：空库先铺底，再补官方新增专辑，版本号 +1', async () => {
  const { store, albums, meta } = makeStore()
  const { fetchImpl } = makeFetch({
    '/api/albums': [listEntry('0003', 'C'), listEntry('0002', 'B'), listEntry('0001', 'A')],
    '/api/album/0003/detail': detail('0003', 'C', ['s3']),
  })

  const result = await syncCatalog({
    store,
    fetchImpl,
    now: NOW,
    reason: 'test',
    http: HTTP,
    bootstrap: async () => seedFromBaseline(store, baselineOf(), NOW),
  })

  assert.equal(result.ok, true)
  assert.equal(result.added, 1)
  assert.equal(result.addedPending, 0)
  assert.equal(result.removed, 0)
  assert.equal(result.albums, 3)
  assert.equal(result.songs, 3)
  assert.equal(result.version, 2)
  assert.equal(meta.version, '2')
  assert.ok(albums.has('0003'))
  assert.deepEqual(JSON.parse(meta.order), ['0003', '0002', '0001'])
})

test('syncCatalog：没有变化时不抬版本号（避免前端无意义重拉）', async () => {
  const { store, meta } = makeStore()
  const routes = {
    '/api/albums': [listEntry('0003', 'C'), listEntry('0002', 'B'), listEntry('0001', 'A')],
    '/api/album/0003/detail': detail('0003', 'C', ['s3']),
    '/api/album/0002/detail': detail('0002', 'B', ['s2']),
    '/api/album/0001/detail': detail('0001', 'A', ['s1']),
  }
  const { fetchImpl } = makeFetch(routes)
  await syncCatalog({ store, fetchImpl, now: NOW, reason: 'test', http: HTTP, bootstrap: async () => seedFromBaseline(store, baselineOf(), NOW) })
  const versionAfterFirst = meta.version

  const second = await syncCatalog({ store, fetchImpl, now: NOW + 60_000, reason: 'test', http: HTTP })
  assert.equal(second.ok, true)
  assert.equal(second.changed, false)
  assert.equal(second.version, Number(versionAfterFirst))
  assert.equal(meta.version, versionAfterFirst)
})

test('syncCatalog：官方新增专辑 → 版本 +1 且新专辑可播放', async () => {
  const { store, albums, meta } = makeStore()
  const baseList = [listEntry('0002', 'B'), listEntry('0001', 'A')]
  const routes: Record<string, unknown> = {
    '/api/albums': baseList,
    '/api/album/0002/detail': detail('0002', 'B', ['s2']),
    '/api/album/0001/detail': detail('0001', 'A', ['s1']),
  }
  const { fetchImpl } = makeFetch(routes)
  await syncCatalog({ store, fetchImpl, now: NOW, reason: 'test', http: HTTP, bootstrap: async () => seedFromBaseline(store, baselineOf(), NOW) })
  const before = Number(meta.version)

  routes['/api/albums'] = [listEntry('0004', 'D'), ...baseList]
  routes['/api/album/0004/detail'] = detail('0004', 'D', ['s4', 's5'])
  const result = await syncCatalog({ store, fetchImpl, now: NOW + 60_000, reason: 'test', http: HTTP })

  assert.equal(result.added, 1)
  assert.equal(result.addedSongs, 2)
  assert.equal(Number(meta.version), before + 1)
  assert.ok(albums.has('0004'))
  assert.equal(JSON.parse(albums.get('0004')!.payload).songs.length, 2)
})

test('syncCatalog：官方下架专辑 → 连续两轮确认后才删除并抬版本号', async () => {
  const { store, albums, meta } = makeStore()
  const cids = ['0001', '0002', '0003', '0004', '0005', '0006']
  const baseline = {
    generatedAt: '2026-10-22T16:05:44.515Z',
    source: OFFICIAL,
    albums: cids.map((cid) => album(cid, `T${cid}`, [`s${cid}`])),
  }
  const routes: Record<string, unknown> = {
    '/api/albums': cids.map((cid) => listEntry(cid, `T${cid}`)),
  }
  for (const cid of cids) routes[`/api/album/${cid}/detail`] = detail(cid, `T${cid}`, [`s${cid}`])
  const { fetchImpl } = makeFetch(routes)
  await syncCatalog({
    store,
    fetchImpl,
    now: NOW,
    reason: 'test',
    http: HTTP,
    bootstrap: async () => seedFromBaseline(store, baseline, NOW),
  })
  const before = Number(meta.version)

  routes['/api/albums'] = cids.filter((cid) => cid !== '0002').map((cid) => listEntry(cid, `T${cid}`))
  const first = await syncCatalog({ store, fetchImpl, now: NOW + 60_000, reason: 'test', http: HTTP })

  // 第一轮只登记待确认：官方确实会在发布后短暂返回不完整的列表，不能立刻删
  assert.equal(first.removed, 0)
  assert.equal(first.removedPending, 1)
  assert.equal(albums.has('0002'), true)
  assert.ok(first.warnings.some((warning: string) => warning.includes('确认')))

  const second = await syncCatalog({ store, fetchImpl, now: NOW + 120_000, reason: 'test', http: HTTP })

  assert.equal(second.removed, 1)
  assert.equal(second.removedPending, 0)
  assert.equal(albums.has('0002'), false)
  assert.equal(albums.size, 5)
  // 第一轮 order 变了已经抬过一次版本，第二轮真删再抬一次
  assert.equal(Number(meta.version), before + 2)
})

test('syncCatalog：官方列表被截断（抖动）时不删任何专辑', async () => {
  const { store, albums } = makeStore()
  const routes: Record<string, unknown> = {
    '/api/albums': [listEntry('0003', 'C'), listEntry('0002', 'B'), listEntry('0001', 'A')],
    '/api/album/0003/detail': detail('0003', 'C', ['s3']),
    '/api/album/0002/detail': detail('0002', 'B', ['s2']),
    '/api/album/0001/detail': detail('0001', 'A', ['s1']),
  }
  const { fetchImpl } = makeFetch(routes)
  await syncCatalog({ store, fetchImpl, now: NOW, reason: 'test', http: HTTP, bootstrap: async () => seedFromBaseline(store, baselineOf(), NOW) })

  routes['/api/albums'] = [listEntry('0003', 'C')]
  const result = await syncCatalog({ store, fetchImpl, now: NOW + 60_000, reason: 'test', http: HTTP })

  assert.equal(result.removed, 0)
  assert.equal(albums.size, 3)
  assert.ok(result.warnings.some((warning: string) => warning.includes('下架')))
})

test('syncCatalog：单张专辑详情失败不拖垮整轮', async () => {
  const { store, albums } = makeStore()
  const { fetchImpl } = makeFetch({
    '/api/albums': [listEntry('0005', 'E'), listEntry('0002', 'B'), listEntry('0001', 'A')],
    '/api/album/0005/detail': new Error('HTTP 502'),
    '/api/album/0002/detail': detail('0002', 'B', ['s2']),
    '/api/album/0001/detail': detail('0001', 'A', ['s1']),
  })

  const result = await syncCatalog({
    store,
    fetchImpl,
    now: NOW,
    reason: 'test',
    http: HTTP,
    bootstrap: async () => seedFromBaseline(store, baselineOf(), NOW),
  })

  assert.equal(result.ok, true)
  assert.equal(result.added, 0)
  assert.equal(result.addedPending, 1)
  assert.equal(albums.has('0005'), false)
  assert.ok(result.warnings.some((warning: string) => warning.includes('0005')))
})

test('syncCatalog：拿不到租约时直接跳过（多实例只跑一份）', async () => {
  const { store } = makeStore({ busy: true })
  const { fetchImpl, calls } = makeFetch({})
  const result = await syncCatalog({ store, fetchImpl, now: NOW, reason: 'test', http: HTTP })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, 'busy')
  assert.equal(calls.length, 0)
})

test('syncCatalog：一分钟内重复触发直接跳过，不打官方接口', async () => {
  const { store } = makeStore()
  const { fetchImpl, calls } = makeFetch({
    '/api/albums': [listEntry('0002', 'B'), listEntry('0001', 'A')],
    '/api/album/0002/detail': detail('0002', 'B', ['s2']),
    '/api/album/0001/detail': detail('0001', 'A', ['s1']),
  })
  const first = await syncCatalog({
    store,
    fetchImpl,
    now: NOW,
    reason: 'manual',
    http: HTTP,
    bootstrap: async () => seedFromBaseline(store, baselineOf(), NOW),
  })
  assert.equal(first.ok, true)
  const before = calls.length

  const again = await syncCatalog({ store, fetchImpl, now: NOW + 5_000, reason: 'manual', http: HTTP })
  assert.equal(again.ok, true)
  assert.equal(again.skipped, 'fresh')
  assert.equal(calls.length, before, '被间隔挡下时不应该再请求官方')

  // cli 是强制入口，不受间隔限制
  const forced = await syncCatalog({ store, fetchImpl, now: NOW + 6_000, reason: 'cli', http: HTTP })
  assert.equal(forced.skipped, undefined)
  assert.ok(calls.length > before)
})

test('syncCatalog：官方列表为空时整轮失败并记录 lastError', async () => {
  const { store, meta } = makeStore()
  const { fetchImpl } = makeFetch({ '/api/albums': [] })
  const result = await syncCatalog({
    store,
    fetchImpl,
    now: NOW,
    reason: 'test',
    http: HTTP,
    bootstrap: async () => seedFromBaseline(store, baselineOf(), NOW),
  })
  assert.equal(result.ok, false)
  assert.ok(meta.lastError)
  assert.equal(meta.lastCheckAt, new Date(NOW).toISOString())
})

test('syncCatalog：被间隔挡下时只读两行 meta，不扫专辑表', async () => {
  const { store, calls } = makeStore({ meta: { lastCheckAt: new Date(NOW - 1_000).toISOString(), version: '7' } })
  const { fetchImpl, calls: http } = makeFetch({})
  const result = await syncCatalog({ store, fetchImpl, now: NOW, reason: 'manual', http: HTTP })

  assert.equal(result.skipped, 'fresh')
  assert.equal(result.version, 7)
  assert.equal(calls.readMetaKeys, 1)
  // 关键：POST /api/catalog/sync 被间隔挡下时不能付一次全表扫描的代价
  assert.equal(calls.readSyncState, 0)
  assert.equal(http.length, 0)
})

test('syncCatalog：慢轮次收尾不会清掉别人刚抢到的租约', async () => {
  const { store, meta } = makeStore()
  const write = store.putAlbums.bind(store)
  const stolen = `${NOW + 9_999_999}|another-run`
  store.putAlbums = async (rows: Row[]) => {
    await write(rows)
    // 模拟：本轮跑太久，租约过期后被另一个实例抢走
    meta.leaseUntil = stolen
  }
  const { fetchImpl } = makeFetch({
    '/api/albums': [listEntry('0001', 'A')],
    '/api/album/0001/detail': detail('0001', 'A', ['s1']),
  })
  const result = await syncCatalog({ store, fetchImpl, now: NOW, reason: 'test', http: HTTP })

  assert.equal(result.ok, true)
  assert.equal(meta.leaseUntil, stolen, 'releaseLease 只应清掉自己的租约')
})

test('syncCatalog：铺底失败时整轮失败，不拿残缺曲库顶替快照', async () => {
  const { store, albums } = makeStore()
  const { fetchImpl } = makeFetch({ '/api/albums': [listEntry('0001', 'A')] })
  const result = await syncCatalog({
    store,
    fetchImpl,
    now: NOW,
    reason: 'test',
    http: HTTP,
    bootstrap: async () => 0,
  })

  assert.equal(result.ok, false)
  assert.match(String(result.error), /铺底/)
  assert.equal(albums.size, 0)
})

test('syncCatalog：部分专辑失败时标记 partial 并把告警落到 meta', async () => {
  const { store, meta } = makeStore()
  const { fetchImpl } = makeFetch({
    '/api/albums': [listEntry('0002', 'B'), listEntry('0001', 'A')],
    '/api/album/0001/detail': detail('0001', 'A', ['s1']),
    // 0002 故意不配置 → 详情抓取失败
  })
  const result = await syncCatalog({
    store,
    fetchImpl,
    now: NOW,
    reason: 'test',
    http: HTTP,
    bootstrap: async () => seedFromBaseline(store, baselineOf(), NOW),
  })

  assert.equal(result.ok, true)
  assert.equal(result.partial, true)
  assert.ok(result.warnings.some((warning: string) => warning.includes('0002')))
  assert.ok(String(meta.lastWarning).includes('0002'))
  assert.equal(meta.lastWarningAt, new Date(NOW).toISOString())
})

test('syncCatalog：续租失败立刻中止整轮，已落库的部分保留、错误字段不被改写', async () => {
  const { store, albums, meta } = makeStore()
  const write = store.putAlbums.bind(store)
  const stolen = `${NOW + 9_999_999}|another-run`
  store.putAlbums = async (rows: Row[]) => {
    await write(rows)
    // 模拟：本轮跑到一半租约到期，被另一个实例抢走
    meta.leaseUntil = stolen
  }
  const { fetchImpl } = makeFetch({
    '/api/albums': [listEntry('0001', 'A')],
    '/api/album/0001/detail': detail('0001', 'A', ['s1']),
    '/api/song/s1': { name: 'A-s1', artists: ['MSR'], sourceUrl: 'https://cdn/s1.mp3', lyricUrl: '' },
  })

  // keepLease 只在真实墙钟距上次续租 ≥30_000ms 时才调用 renewLease；测试全程毫秒级完成，
  // 不推时钟的话这条防线永远不会被触发（r4-01 的原始漏洞）。
  const realNow = Date.now
  let fake = NOW
  Date.now = () => (fake += 31_000)
  try {
    const result = await syncCatalog({
      store,
      fetchImpl,
      now: NOW,
      reason: 'test',
      http: HTTP,
      budgets: { refresh: 1 },
      bootstrap: async () => seedFromBaseline(store, baselineOf(), NOW),
    })

    assert.equal(result.ok, true, '被接管不算失败：本轮已落库的部分照常生效')
    assert.equal(result.skipped, 'lease-lost')
    // 中止发生在收尾 setMeta 之前：版本号与错误字段都不能被这轮改写
    assert.equal(Number(meta.version), 1)
    assert.equal(meta.lastError, '')
    assert.equal(meta.lastErrorAt, '')
    assert.equal(meta.leaseUntil, stolen, 'releaseLease 只应清掉自己的租约')
    // 中止点落在逐曲续租上：铺底已经写进去的两张必须原样留着，不许被回滚
    assert.equal(albums.size, 2)
    assert.equal(albums.get('0001')?.songCount, 1)
    assert.equal(albums.get('0002')?.songCount, 1)
  } finally {
    Date.now = realNow
  }
})

test('syncCatalog：确认轮超过单轮上限（11 张）时继续挂起，不执行删除', async () => {
  const known = Array.from({ length: 44 }, (_, index) =>
    album(String(index + 1).padStart(4, '0'), `A${index + 1}`, [`s${index + 1}`]),
  )
  const missing = known.slice(33).map((item) => item.cid)
  const official = known.slice(0, 33).map((item) => listEntry(item.cid, item.name))
  const { store, albums, meta } = makeStore()
  let deleteCalls = 0
  store.deleteAlbums = async (cids: string[]) => {
    deleteCalls += 1
    for (const cid of cids) albums.delete(cid)
  }
  const { fetchImpl } = makeFetch({ '/api/albums': official })
  const baseline = { generatedAt: '2026-10-22T16:05:44.515Z', source: OFFICIAL, albums: known }
  const options = { store, fetchImpl, reason: 'test', http: HTTP, budgets: { refresh: 0 } }

  const first = await syncCatalog({
    ...options,
    now: NOW,
    bootstrap: async () => seedFromBaseline(store, baseline, NOW),
  })
  assert.equal(first.ok, true)
  // 44 张里缺 11 张：比例闸放行（11 = ceil(44*0.25)），但棘轮闸不放行（11 > 10）
  assert.equal(first.removed, 0)
  assert.equal(first.removedPending, 11)
  assert.ok(first.warnings.some((warning: string) => warning.includes('超过单轮上限')))
  assert.equal(deleteCalls, 0)
  assert.equal(albums.size, 44)
  assert.deepEqual(JSON.parse(String(meta.pendingRemoval)), missing)

  // 第二轮：同一批缺失已确认过，但 11 > MAX_REMOVALS_PER_RUN，仍然不许删
  const second = await syncCatalog({ ...options, now: NOW + 120_000 })
  assert.equal(second.ok, true)
  assert.equal(second.removed, 0)
  assert.equal(second.removedPending, 11)
  assert.ok(second.warnings.some((warning: string) => warning.includes('超过单轮上限')))
  assert.equal(deleteCalls, 0)
  assert.equal(albums.size, 44)
  assert.deepEqual(JSON.parse(String(meta.pendingRemoval)), missing)
})

test('syncCatalog：确认轮正好等于单轮上限（10 张）时照常删除', async () => {
  const known = Array.from({ length: 40 }, (_, index) =>
    album(String(index + 1).padStart(4, '0'), `A${index + 1}`, [`s${index + 1}`]),
  )
  const missing = known.slice(30).map((item) => item.cid)
  const official = known.slice(0, 30).map((item) => listEntry(item.cid, item.name))
  const { store, albums, meta } = makeStore()
  let deleted: string[] = []
  store.deleteAlbums = async (cids: string[]) => {
    deleted = deleted.concat(cids)
    for (const cid of cids) albums.delete(cid)
  }
  const { fetchImpl } = makeFetch({ '/api/albums': official })
  const baseline = { generatedAt: '2026-10-22T16:05:44.515Z', source: OFFICIAL, albums: known }
  const options = { store, fetchImpl, reason: 'test', http: HTTP, budgets: { refresh: 0 } }

  const first = await syncCatalog({
    ...options,
    now: NOW,
    bootstrap: async () => seedFromBaseline(store, baseline, NOW),
  })
  assert.equal(first.removed, 0)
  assert.equal(first.removedPending, 10)
  assert.ok(first.warnings.some((warning: string) => warning.includes('需下一轮再次确认')))
  assert.equal(albums.size, 40)

  const second = await syncCatalog({ ...options, now: NOW + 120_000 })
  assert.equal(second.ok, true)
  assert.equal(second.removed, 10)
  assert.equal(second.removedPending, 0)
  assert.deepEqual(deleted.sort(), missing.slice().sort())
  assert.equal(albums.size, 30)
  assert.deepEqual(JSON.parse(String(meta.pendingRemoval)), [])
})

test('matchesEtag：弱比较、列表与 * 都要命中', () => {
  assert.equal(matchesEtag('"cat-1-2-3"', '"cat-1-2-3"'), true)
  assert.equal(matchesEtag('W/"cat-1-2-3"', '"cat-1-2-3"'), true)
  assert.equal(matchesEtag('"other", "cat-1-2-3"', '"cat-1-2-3"'), true)
  assert.equal(matchesEtag('*', '"cat-1-2-3"'), true)
  assert.equal(matchesEtag('"cat-1-2-4"', '"cat-1-2-3"'), false)
  assert.equal(matchesEtag('', '"cat-1-2-3"'), false)
  assert.equal(matchesEtag(null, '"cat-1-2-3"'), false)
})
