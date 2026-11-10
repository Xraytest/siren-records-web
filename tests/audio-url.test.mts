import assert from 'node:assert/strict'
import { test } from 'node:test'

import { audioSrcFor } from '../src/lib/audio-url.ts'

test('默认：直连地址不带任何查询参数', () => {
  assert.equal(audioSrcFor('306861'), '/api/audio/306861')
})

test('本站转发：只加 via=proxy', () => {
  assert.equal(audioSrcFor('306861', { proxy: true }), '/api/audio/306861?via=proxy')
})

test('换签重载：bust 生成 r=<时间戳>', () => {
  const url = audioSrcFor('306861', { bust: true })
  assert.match(url, /^\/api\/audio\/306861\?r=\d{10,}$/)
})

test('转发 + 换签：两个参数都在，且 via 在前', () => {
  const url = audioSrcFor('306861', { proxy: true, bust: true })
  assert.match(url, /^\/api\/audio\/306861\?via=proxy&r=\d{10,}$/)
})

test('曲目编号原样拼接（调用方已校验为纯数字）', () => {
  assert.equal(audioSrcFor('1'), '/api/audio/1')
})
