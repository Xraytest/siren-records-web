/**
 * 解析 `wrangler d1 migrations list --remote` 的输出。
 *
 * Wrangler 4.x 输出的是带边框的表格（`│ 0002_perf_indexes.sql │`），
 * 早期按「整行只有一个文件名」匹配会把表格里的迁移全部漏掉 ——
 * 于是 `db:migrate` 误判「线上已是最新」、直接跳过 apply，
 * 而 deploy-safe 也以为没有待应用迁移、不做破坏性检查。
 */

export function parsePendingMigrations(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/)
  const start = lines.findIndex((line) => /to be applied/i.test(line))
  if (start < 0) return []

  const pending = []
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/([0-9][A-Za-z0-9_.-]*\.sql)/)
    if (match) {
      if (!pending.includes(match[1])) pending.push(match[1])
      continue
    }
    // 表格结束（└──…┘）或空行：后面不会再有 pending 列表
    if (/[└┘]/.test(line) || !line.trim()) {
      if (pending.length) break
    }
  }
  return pending
}
