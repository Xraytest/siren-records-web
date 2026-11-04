#!/usr/bin/env python3
"""把备份 SQL 还原进内存 SQLite，验证可用性与一致性。

成功时向 stdout 输出单行 JSON，失败时 stderr 输出原因并以非零码退出。
用法：restore-check.py <dump.sql> [--min-users N]
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys

TABLES = ("users", "sessions", "playlists")


def build(sql: str) -> sqlite3.Connection:
    # 事务/PRAGMA 包装由 sqlite3 自己管理，脚本里只保留 DDL + DML
    cleaned = re.sub(
        r"(?im)^\s*(?:PRAGMA\s+[a-z_]+\s*=\s*[^;]+|BEGIN(?:\s+TRANSACTION)?|COMMIT)\s*;\s*$",
        "",
        sql,
    )
    conn = sqlite3.connect(":memory:")
    conn.executescript(cleaned)
    return conn


def main() -> int:
    parser = argparse.ArgumentParser(description="校验 SIREN 数据库备份可用于还原")
    parser.add_argument("dump")
    parser.add_argument("--min-users", type=int, default=0)
    args = parser.parse_args()

    try:
        with open(args.dump, "r", encoding="utf-8", errors="replace") as handle:
            sql = handle.read()
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
        counts = {}
        for table in TABLES:
            counts[table] = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
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

    if problems:
        print("；".join(problems), file=sys.stderr)
        return 1

    print(json.dumps({"ok": True, "counts": counts, "integrity": integrity}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
