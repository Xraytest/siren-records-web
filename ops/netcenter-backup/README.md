# NetCenter 定期备份（云端 D1 → 本地）

站点数据全部在 Cloudflare D1（`siren-records`）。本目录是运行在 NetCenter
（树莓派 `pi` / aarch64 / 用户级 systemd，`Linger=yes`）上的备份程序：每天低峰期
从站点拉取一份带校验的整库 SQL 导出，压缩、记账、轮转。**不落明文口令**；
会话令牌在库里已是 SHA-256 摘要，dump 里不会出现可直接使用的令牌（口令哈希仍属机密数据）。

## 架构

```
Cloudflare D1 (siren-records)
        │  Worker GET /api/backup/dump        ← Bearer BACKUP_TOKEN（≥32 字符）
        ▼
siren.neolx.ltd ──TLS──► NetCenter: ~/siren-backup/backup-d1.sh
                              │ 1. curl（令牌走 600 的 --config，不进命令行/环境变量）
                              │ 2. 校验 HTTP 200 / X-Backup-Sha256 / 字节数 / 结构标记
                              │ 3. python3 还原进内存 SQLite：integrity_check + foreign_key_check
                              │    + 每表行数与 X-Backup-Tables 逐项比对
                              │ 4. zstd（或 gpg）写 *.part，校验通过后 mv -n 转正，落 600 + .sha256
                              │ 5. 轮转：最近 30 份 + 每月最新一份，最多 12 个月
                              ▼
                        ~/siren-backup/dumps/      ← 数据资产，权限 700/600
```

- `backup-d1.sh` 主程序；`restore-check.py` 还原校验；`install.sh` 安装；
  `siren-d1-backup.{service,timer}` systemd 用户级单元。
- 定时：每天 `04:17`（`RandomizedDelaySec=300`）。D1 导出期间数据库会短暂不可用，
  所以避开白天；`Persistent=true` 补偿关机错过的运行。
- 依赖：`curl`、`sha256sum`、`python3`、`flock`（util-linux）、`zstd` 或 `gzip`。
  **不需要 jq**（状态 JSON 由 python3 生成），也不需要 node / sqlite3 CLI。
- 配置默认 `$HOME/siren-backup`，可用 `SIREN_BACKUP_HOME` 换目录；`install.sh` 会把
  systemd unit 里的 `@DEST@` 渲染成实际路径（早期版本 unit 里写死 `%h/siren-backup`，
  换目录安装时定时器会指向不存在的脚本）。

### 导出是怎么做的（以及它的边界）

Worker 侧按主键 **keyset 分页**（`WHERE id > ? ORDER BY id LIMIT 500`，`sessions` 按
`token` 摘要）逐页写出，不是 `OFFSET`：备份过程中有新行插入也不会跳行或重复。
但仍然**没有快照隔离**——D1 不提供跨语句一致性读，所以一次导出看到的是
「大致同一时刻、可能包含中途写入」的数据。如果新注册刚好落在这三张表的扫描之间，
还原校验会把它判为孤儿行/外键违例并让这次备份失败（宁可这次没备份成功，
也不落一份坏备份；下一晚会自动重试）。

文本按 SQL 规则转义：单引号双写；`NUL` 无法写进 SQL 字面量，写成 `char(0)` 拼接
（`'a' || char(0) || 'b'`），保证还原时逐字节一致；BLOB 用 `X'..'`（当前 schema 无 BLOB 列）。

### 可调参数（`backup.env`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SIREN_BACKUP_URL` | — | 必须 `https://`，拒绝空格/引号/反斜杠/换行（防止 curl 配置被注入） |
| `SIREN_BACKUP_TOKEN` | — | ≥32 字符，只允许 `A-Za-z0-9._~+/=-` |
| `SIREN_BACKUP_DIR` | `$ROOT_DIR/dumps` | 备份落盘目录（可在 `backup.env` 里改，必须与 state 同盘才方便 `df` 守卫） |
| `SIREN_BACKUP_KEEP_DAILY` | `30` | 最近 N 份全留，必须 ≥1（设 0 会被拒绝，避免把旧备份全部轮转掉） |
| `SIREN_BACKUP_KEEP_MONTHLY` | `12` | 更早的每月保留**最新**一份，最多 M 个月（`0` 表示不额外保留月度归档） |
| `SIREN_BACKUP_MIN_FREE_MB` | `1024` | 磁盘余量下限，不够就这次不备份 |
| `SIREN_BACKUP_MIN_USERS` | `1` | 导出里用户数低于此值判为失败（防「拉到空库却当成好备份」） |
| `SIREN_BACKUP_GPG_RECIPIENT` | 空 | 配置后用公钥加密落盘（`.gpg`） |

整数参数**不允许前导零**：`08` 在 bash 算术里是八进制，曾导致 `KEEP_MONTHLY=08`
静默删光月度归档，所以现在启动即拒绝（`08`/`030` 都会报错退出）。

## 安装（NetCenter）

```bash
# 1) 把本目录拷到 NetCenter 任意位置（或 git clone 后 cd 进来）
bash install.sh                                  # 默认装到 ~/siren-backup
# 或：SIREN_BACKUP_HOME=/opt/siren-backup bash install.sh

# 2) 填令牌（必须与站点端一致），保存后确认权限
vi ~/siren-backup/backup.env
chmod 600 ~/siren-backup/backup.env

# 3) 手动跑一次，确认成功
~/siren-backup/backup-d1.sh

# 4) 启用定时器（install.sh 在令牌缺失时不会 enable，避免开机必然失败一次）
systemctl --user enable --now siren-d1-backup.timer
systemctl --user list-timers siren-d1-backup.timer --no-pager
```

> 该机没有持久化 journal 文件，`journalctl --user -u ...` 会报 "No journal files were found"；
> 查最近一次运行请用 `systemctl --user status`，或直接看 `state/last-success.json` 的 `at` 字段。
> unit 已把 `GNUPGHOME` 指到 `~/siren-backup/gnupg`（`ProtectHome=read-only` 下 `~/.gnupg` 不可写），
> 并放行 `AF_UNIX`（gpg-agent 与部分 nss 解析需要）。

令牌必须在两端一致：

```bash
openssl rand -hex 32                                   # 生成（hex 形态最省事）
# 站点侧（本机，有 wrangler 凭据时）：
npx wrangler secret put BACKUP_TOKEN --name siren-records-web
```

> Worker 未配置 `BACKUP_TOKEN`（或长度 < 32）时，`/api/backup/dump` 对**所有方法**都返回 404，
> 入口等同于不存在；配置后只接受 GET，每 IP 每小时 10 次。

## 失败与告警

- 任一校验失败：不覆盖旧备份、不轮转，`state/last-error.txt` 追加一行（只留最近 50 条），
  进程非零退出；压缩阶段失败只会留下 `*.part`，不会被当成有效备份参与轮转。
- 401 会明确提示「令牌可能已轮换」，429 提示「每小时限 10 次」，便于区分是配置问题还是被限速
  （脚本只对连接错误/5xx 重试，401/429 不重试，避免烧掉配额）。
- 成功：`state/last-success.json` 记录时间、文件名、SHA-256、各表行数与还原校验结果，
  并清空 `state/last-error.txt`。
- 监控建议：`systemctl --user is-failed siren-d1-backup.service`，或读取
  `last-success.json` 的 `at` 判断是否超过 36 小时未更新。
- 日志用 journal 自动轮转，不在 home 下堆积；脚本不打印令牌，日志里只记 scheme+host+path。

## 恢复

> **恢复会覆盖**：导出脚本开头是 `DELETE FROM users/sessions/playlists;`，再逐行 `INSERT`。
> 也就是说「恢复备份」= 把线上库回滚到导出时刻，导出之后新建的账号和歌单会消失。
> 动手前先对当前库再导一份（或先跑一次 `backup-d1.sh`）作为回退点。
> 另外 dump 里只有口令**哈希**，同一行哈希只有产出它的后端能验证（Worker 用 PBKDF2，本地 Node 用 scrypt）。

```bash
# 0) 先建 0700 临时目录，别把明文 dump 落到 /tmp 的 0644 文件上（NetCenter 上也没有 sqlite3）
umask 077
T="$(mktemp -d)"; chmod 700 "$T"

# 1) 解压（-o 由我们显式给出，目录 700、文件默认 600）
zstd -d "$HOME/siren-backup/dumps/siren-d1-20261105T041700Z.sql.zst" -o "$T/restore.sql"
chmod 600 "$T/restore.sql"

# 2) 干跑校验（内存 SQLite，不动线上；--expect-counts 可选，用来核对某次备份的行数）
python3 ~/siren-backup/restore-check.py --min-users 1 "$T/restore.sql"

# 3) 恢复到本地 SQLite 做应急演练（用 python3，pi 上不需要 sqlite3 CLI）
python3 - "$T/restore.sql" "$T/siren-restored.db" <<'PY'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
sql = open(src, encoding="utf-8", errors="strict").read()
db = sqlite3.connect(dst)
db.executescript(sql)
print("restored:", {t: db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("users", "sessions", "playlists")})
PY

# 4) 恢复回线上 D1（谨慎：脚本含 DELETE FROM，会覆盖同 id 数据）
npx wrangler d1 execute siren-records --remote --file="$T/restore.sql"

# 5) 清理含明文凭据的临时文件
rm -rf "$T"
```

## 安全说明

- 备份含 `users.salt/hash`（PBKDF2-SHA256 10 万次迭代）与 `sessions.token`（**已是 SHA-256 摘要**，
  不能直接当令牌用）以及歌单内容，按机密数据对待：`dumps/` 700、文件 600，
  不要放进 Web 根目录或 Git。
- 令牌只出现在受信任的 600 配置文件与 600 的临时 curl 配置中；脚本不打印令牌，
  不把令牌放进命令行参数（`ps` 可见），也不用 `set -a` 导出到子进程环境。
- 传输只允许 https 且不跟随重定向，防止降级与令牌被带到第三方域名。
- 对端 `BACKUP_TOKEN` 建议每季度轮换：`wrangler secret put` 后同步改
  NetCenter 的 `backup.env`，旧令牌立即失效。
- 若需要异地副本/静态加密，可配 `SIREN_BACKUP_GPG_RECIPIENT` 用公钥加密；注意没有私钥
  就等于没有备份，私钥要离线保存，并把公钥导入 `~/siren-backup/gnupg`（unit 的 `GNUPGHOME`）。
- 单机 + 明文落盘是已知限制：这台机器被拿下就等于历史备份全部泄露；没有 HSM/KMS。
  更稳的做法是再加一份异地副本（例如另一台机器的 `rclone`/`rsync` 目标），并定期做恢复演练。

## 已验证（2026-11-05）

在本机（pi）用 40 份历史备份 + 真实接口跑过：

- `KEEP_DAILY=365` 写在 `backup.env` 里 → 跑完保留 41/41（旧版会忽略配置、只留 30/31）。
- `KEEP_MONTHLY=08` → 启动即拒绝，历史一份不少（旧版会静默删掉全部月度归档）。
- `KEEP_DAILY=030` → 启动即拒绝。
- `*.part` 半成品不会被转正，也不会被轮转删除。
- 加固后的 systemd unit 真跑：`Result=success`，`last-success.json` 行数
  `users:2,sessions:15,playlists:4`；独立解压 + `restore-check.py` 复核 `ok:true`。
