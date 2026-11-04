import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePendingMigrations } from '../scripts/lib/wrangler-migrations.mjs'

test('解析 wrangler 4 表格输出里的 pending 迁移', () => {
  const stdout = `
 ⛅️ wrangler 4.154.0
───────────────────────────────────────────────
Resource location: remote 

Migrations to be applied:
┌───────────────────────┐
│ Name                  │
├───────────────────────┤
│ 0002_perf_indexes.sql │
└───────────────────────┘
`
  assert.deepEqual(parsePendingMigrations(stdout), ['0002_perf_indexes.sql'])
})

test('多个 pending 迁移按输出顺序返回且不重复', () => {
  const stdout = `Migrations to be applied:
┌──────────────────┐
│ Name             │
├──────────────────┤
│ 0002_a.sql       │
│ 0003-b.sql       │
└──────────────────┘
`
  assert.deepEqual(parsePendingMigrations(stdout), ['0002_a.sql', '0003-b.sql'])
})

test('没有 pending 时不误报', () => {
  assert.deepEqual(parsePendingMigrations('No migrations to apply!\n'), [])
  assert.deepEqual(parsePendingMigrations('✅ No migrations to apply\n'), [])
})

test('输出为空/null 不抛异常', () => {
  assert.deepEqual(parsePendingMigrations(''), [])
  assert.deepEqual(parsePendingMigrations(undefined), [])
})

test('表格之外的 .sql 文本（例如说明行）不会漏进列表头部', () => {
  const stdout = `Migrations to be applied:
┌──────────────────┐
│ 0004_c.sql       │
└──────────────────┘
`
  assert.deepEqual(parsePendingMigrations(stdout), ['0004_c.sql'])
})
