/**
 * SQL 词法扫描：把迁移文件切成「语句」，并只对代码部分（不含字符串/注释）做危险模式匹配。
 *
 * 为什么需要它：早期用正则剥离 `--` 注释再匹配，会被两件事骗过 ——
 *   1) `INSERT INTO t VALUES ('a--b'); DROP TABLE users;` 里 `--b` 之后整行被当注释剥掉，DROP 消失；
 *   2) `DROP/**\/TABLE users;` 块注释把关键字拆开，正则匹配不到。
 * 这两个都是合法 SQLite，所以必须在词法层判断。
 */

const DESTRUCTIVE = [
  { pattern: /\bdrop\s+(table|column|index|view|trigger)\b/i, label: 'DROP TABLE/COLUMN/INDEX' },
  { pattern: /\bdelete\s+from\b/i, label: 'DELETE FROM' },
  { pattern: /\btruncate\b/i, label: 'TRUNCATE' },
  { pattern: /\balter\s+table\b/i, label: 'ALTER TABLE' },
  { pattern: /\bupdate\s+["'`\[]?\w+["'`\]]?\s+set\b/i, label: 'UPDATE（批量改写既有行）' },
]

/** 把一条语句拆成「代码块」和「字符串字面量」，只返回代码部分拼成的文本 */
function codeOnly(statement) {
  let out = ''
  let i = 0
  const n = statement.length
  while (i < n) {
    const ch = statement[i]
    const next = statement[i + 1]
    if (ch === '-' && next === '-') {
      while (i < n && statement[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(statement[i] === '*' && statement[i + 1] === '/')) i += 1
      i += 2
      out += ' '
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i += 1
      while (i < n) {
        if (statement[i] === quote) {
          if (statement[i + 1] === quote) {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      out += " '' "
      continue
    }
    if (ch === '[') {
      while (i < n && statement[i] !== ']') i += 1
      i += 1
      out += " '' "
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** 按分号切语句（分号可能出现在字符串或注释里，必须词法级判断） */
export function splitStatements(sql) {
  const statements = []
  let current = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') {
        current += sql[i]
        i += 1
      }
      continue
    }
    if (ch === '/' && next === '*') {
      const start = i
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1
      i += 2
      current += sql.slice(start, i)
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      current += ch
      i += 1
      while (i < n) {
        current += sql[i]
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            current += sql[i + 1]
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (ch === ';') {
      statements.push(current)
      current = ''
      i += 1
      continue
    }
    current += ch
    i += 1
  }
  if (current.trim()) statements.push(current)
  return statements
}

/**
 * 检查一段迁移 SQL 是否含破坏性操作。
 * @returns {{label: string, statement: string}[]}
 */
export function findDestructive(sql) {
  const findings = []
  for (const statement of splitStatements(sql)) {
    const code = codeOnly(statement)
    const trimmed = code.trim()
    if (!trimmed) continue
    // ALTER TABLE ... ADD COLUMN 在 SQLite 里不重写数据，属安全迁移，不该让闸门永久失效
    const safeAddColumn = /^alter\s+table\s+[\w"'`[\]]+\s+add\s+(column\s+)?[\w"'`[\]]+/i.test(trimmed)
    for (const { pattern, label } of DESTRUCTIVE) {
      if (!pattern.test(trimmed)) continue
      if (safeAddColumn && label.startsWith('ALTER')) continue
      findings.push({ label, statement: trimmed.replace(/\s+/g, ' ').slice(0, 120) })
    }
  }
  return findings
}
