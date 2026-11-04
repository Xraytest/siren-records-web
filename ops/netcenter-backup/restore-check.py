#!/usr/bin/env python3
"""把备份 SQL 还原进内存 SQLite，验证可用性与一致性。

成功时向 stdout 输出单行 JSON，失败时 stderr 输出原因并以非零码退出。

用法：
    restore-check.py <dump.sql> [--min-users N] [--expect-counts "users:3,sessions:16,playlists:4"]

设计要点：
- 不再用正则去删 BEGIN/COMMIT/PRAGMA：早期实现会把数据里以行首出现的
  `COMMIT;` 一起删掉（sqlText 只双写单引号、保留字面换行），于是校验对象 ≠ 落盘文件。
  现在按 `sqlite3.complete_statement` 逐句切分，只跳过「整句就是包装语句」的那些。
- 只执行 DDL/DML：ATTACH / DETACH / VACUUM / 写操作 PRAGMA 一律拒绝（纵深防御：
  备份内容来自网络，被篡改时不该能在校验机上落盘或附加数据库）。
- 严格 UTF-8 解码：用 errors="replace" 会把编码损坏悄悄掩盖成 U+FFFD。
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys

TABLES = ("users", "sessions", "playlists")

# 备份文件的包装语句：整句就是这些的，跳过
WRAPPER_PREFIXES = ("BEGIN", "COMMIT", "END", "ROLLBACK", "PRAGMA FOREIGN_KEYS")
# 绝不允许执行的语句（会写文件系统 / 附加外部库）
FORBIDDEN_PREFIXES = ("ATTACH", "DETACH", "VACUUM", "PRAGMA", "CREATE VIRTUAL")


def strip_comments(statement: str) -> str:
    out = []
    for line in statement.splitlines():
        if line.lstrip().startswith("--"):
            continue
        out.append(line)
    return "\n".join(out).strip()


def first_word(statement: str) -> str:
    cleaned = strip_comments(statement)
    if not cleaned:
        return ""
    word = ""
    for char in cleaned:
        if char.isalpha() or char == "_":
            word += char
        else:
            break
    return word.upper()


def split_statements(sql: str):
    """按 SQLite 自己的语句完整性判断切分，避免被字符串里的分号/关键字骗到。"""
    buffer = ""
    for line in sql.splitlines(keepends=True):
        buffer += line
        if sqlite3.complete_statement(buffer):
            yield buffer
            buffer = ""
    if buffer.strip():
        yield buffer


def build(sql: str) -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys=OFF")
    executed = 0
    for statement in split_statements(sql):
        word = first_word(statement)
        if not word:
            continue
        if word in ("BEGIN", "COMMIT", "END", "ROLLBACK"):
            continue
        if any(strip_comments(statement).upper().startswith(prefix) for prefix in WRAPPER_PREFIXES):
            continue
        if any(strip_comments(statement).upper().startswith(prefix) for prefix in FORBIDDEN_PREFIXES):
            raise sqlite3.DatabaseError(f"备份中出现不允许的语句：{strip_comments(statement)[:60]}")
        conn.execute(statement)
        executed += 1
    if executed == 0:
        raise sqlite3.DatabaseError("备份中没有任何可执行语句")
    return conn


def parse_expect_counts(raw: str) -> dict[str, int]:
    expected: dict[str, int] = {}
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        name, _, value = chunk.partition(":")
        if not value.isdigit():
            continue
        expected[name.strip()] = int(value)
    return expected


def main() -> int:
    parser = argparse.ArgumentParser(description="校验 SIREN 数据库备份可用于还原")
    parser.add_argument("dump")
    parser.add_argument("--min-users", type=int, default=0)
    parser.add_argument(
        "--expect-counts",
        default="",
        help='响应头 X-Backup-Tables 的值，例如 "users:3,sessions:16,playlists:4"',
    )
    args = parser.parse_args()

    try:
        with open(args.dump, "r", encoding="utf-8") as handle:
            sql = handle.read()
    except UnicodeDecodeError as error:
        print(f"备份不是合法 UTF-8：{error}", file=sys.stderr)
        return 1
    except OSError as error:
        print(f"无法读取备份文件：{error}", file=sys.stderr)
        return 1

    try:
        conn = build(sql)
    except sqlite3.Error as error:
        print(f"还原失败：{error}", file=sys.stderr)
        return 1

    try:
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        violations = conn.execute("PRAGMA foreign_key_check").fetchall()
        counts = {table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in TABLES}
        orphan_sessions = conn.execute(
            "SELECT COUNT(*) FROM sessions s LEFT JOIN users u ON u.id = s.userId WHERE u.id IS NULL"
        ).fetchone()[0]
        orphan_playlists = conn.execute(
            "SELECT COUNT(*) FROM playlists p LEFT JOIN users u ON u.id = p.userId WHERE u.id IS NULL"
        ).fetchone()[0]
    except sqlite3.Error as error:
        print(f"查询校验失败：{error}", file=sys.stderr)
        return 1
    finally:
        conn.close()

    problems = []
    if integrity != "ok":
        problems.append(f"integrity_check={integrity}")
    if violations:
        problems.append(f"外键违例 {len(violations)} 条")
    if orphan_sessions:
        problems.append(f"{orphan_sessions} 条会话找不到所属用户")
    if orphan_playlists:
        problems.append(f"{orphan_playlists} 个歌单找不到所属用户")
    if counts["users"] < args.min_users:
        problems.append(f"用户数 {counts['users']} 少于预期下限 {args.min_users}")

    expected = parse_expect_counts(args.expect_counts)
    for table in TABLES:
        if table in expected and expected[table] != counts[table]:
            problems.append(f"{table} 行数不符：响应头声明 {expected[table]}，还原得到 {counts[table]}")

    if problems:
        print("；".join(problems), file=sys.stderr)
        return 1

    print(
        json.dumps(
            {"ok": True, "counts": counts, "integrity": integrity, "expected": expected},
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
