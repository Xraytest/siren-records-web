# NetCenter 定期备份（云端 D1 → 本地）

站点数据全部在 Cloudflare D1（`siren-records`）。本目录是运行在 NetCenter
（`orangepi5` / aarch64 / user 级 systemd，`Linger=yes`）上的备份程序：每天低峰期
从站点拉取一份带校验的整库 SQL 导出，压缩、记账、轮转，全程不落明文口令。

## 架构

```
Cloudflare D1 (siren-records)
        │  Worker GET /api/backup/dump        ← Bearer BACKUP_TOKEN（≥32 字符）
        ▼
siren.neolx.ltd ──TLS──► NetCenter: ~/siren-backup/backup-d1.sh
                              │ 1. curl（令牌走 600 的 --config，不进命令行）
                              │ 2. 校验 HTTP 200 / X-Backup-Sha256 / 字节数 / 结构标记
                              │ 3. python3 还原进内存 SQLite：integrity_check + foreign_key_check
                              │ 4. zstd（或 gpg）落盘 600 + .sha256
                              │ 5. 轮转：最近 30 份 + 每月 1 份共 12 个月
                              ▼
                        ~/siren-backup/dumps/      ← 数据资产，权限 700/600
```

- `backup-d1.sh` 主程序；`restore-check.py` 还原校验；`install.sh` 安装；
  `siren-d1-backup.{service,timer}` systemd 用户级单元。
- 定时：每天 `04:17`（`RandomizedDelaySec=300`）。D1 导出期间数据库会短暂不可用，
  所以避开白天；`Persistent=true` 补偿关机错过的运行。

### 导出是怎么做的（以及它的边界）

Worker 侧按 `rowid` **keyset 分页**（`WHERE rowid > ? ORDER BY rowid LIMIT 500`）逐页写出，
不是 `OFFSET`：备份过程中有新行插入也不会跳行或重复。但仍然**没有快照隔离**——
D1 不提供跨语句一致性读，所以一次导出看到的是「大致同一时刻、可能包含中途写入」的数据。
对本站这种量级（每天新增几十条）这没问题，但不要把它当成严格的时间点快照。

文本按 SQL 规则转义：单引号双写；`NUL` 无法写进 SQL 字面量，写成 `char(0)` 拼接
（`'a' || char(0) || 'b'`），保证还原时逐字节一致；BLOB 用 `X'..'`。

### 可调参数（`backup.env`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SIREN_BACKUP_URL` | — | 必须 `https://`，不接受引号/换行（防止 curl 配置被注入） |
| `SIREN_BACKUP_TOKEN` | — | ≥32 字符，只允许 `A-Za-z0-9._~+/=-` |
| `SIREN_BACKUP_KEEP_DAILY` | `30` | 最近 N 份全留，必须 ≥1（设 0 会被拒绝，避免把旧备份全部轮转掉） |
| `SIREN_BACKUP_KEEP_MONTHLY` | `12` | 更早的每月留 1 份，共 M 个月 |
| `SIREN_BACKUP_MIN_FREE_MB` | `1024` | 磁盘余量下限，不够就这次不备份 |
| `SIREN_BACKUP_MIN_USERS` | `1` | 导出里用户数低于此值判为失败（防「拉到空库却当成好备份」） |
| `SIREN_BACKUP_GPG_RECIPIENT` | 空 | 配置后用公钥加密落盘 |

## 安装（NetCenter）

```bash
cd ~/siren-records-web/ops/netcenter-backup   # 或任意拷贝位置
bash install.sh
vi ~/siren-backup/backup.env                  # 填 SIREN_BACKUP_TOKEN，保存后 chmod 600
~/siren-backup/backup-d1.sh                   # 手动跑一次
systemctl --user status siren-d1-backup.service --no-pager -l
```

> 该机没有持久化 journal 文件，`journalctl --user -u ...` 会报 "No journal files were found"；
> 查最近一次运行请用 `systemctl --user status`，或直接看 `state/last-success.json` 的 `at` 字段。

令牌必须在两端一致：

```bash
openssl rand -hex 32                                   # 生成
# 站点侧（本机，有 wrangler 凭据时）：
npx wrangler secret put BACKUP_TOKEN --name siren-records-web
```

> Worker 未配置 `BACKUP_TOKEN`（或长度 < 32）时，`/api/backup/dump` 直接 404，
> 入口等同于不存在。

## 失败与告警

- 任一校验失败：不覆盖旧备份、不轮转，`state/last-error.txt` 追加一行，进程非零退出。
- 401 会明确提示「令牌可能已轮换」，429 提示「每小时限 10 次」，便于区分是配置问题还是被限速。
- 成功：`state/last-success.json` 记录时间、文件名、SHA-256、各表行数与还原校验结果，
  并清空 `state/last-error.txt`。
- 监控建议：`systemctl --user is-failed siren-d1-backup.service`，或读取
  `last-success.json` 的 `at` 判断是否超过 36 小时未更新。
- 日志用 journal 自动轮转，不在 home 下堆积。

## 恢复

> **恢复会覆盖**：导出脚本开头是 `DELETE FROM users/sessions/playlists;`，再逐行 `INSERT`。
> 也就是说「恢复备份」= 把线上库回滚到导出时刻，导出之后新建的账号和歌单会消失。
> 动手前先对当前库再导一份（或先跑一次 `backup-d1.sh`）作为回退点。

```bash
# 1) 解压
zstd -d ~/siren-backup/dumps/siren-d1-20261105T041700Z.sql.zst -o /tmp/restore.sql

# 2) 先干跑校验（内存 SQLite，不动线上）
~/siren-backup/restore-check.py --min-users 1 /tmp/restore.sql

# 3a) 恢复到本地 SQLite（应急演练）
sqlite3 /tmp/siren-restored.db < /tmp/restore.sql

# 3b) 恢复回线上 D1（谨慎：脚本含 DELETE FROM，会覆盖同 id 数据）
npx wrangler d1 execute siren-records --remote --file=/tmp/restore.sql
```

## 安全说明

- 备份含 `users.salt/hash`（PBKDF2-SHA256 10 万次迭代）与 `sessions.token`，等同于
  账号凭据，按机密数据对待：`dumps/` 700、文件 600，不要放进 Web 根目录或 Git。
- 令牌只出现在受信任的 600 配置文件与临时 curl 配置中；脚本不打印令牌，
  不把令牌放进命令行参数（`ps` 可见）。
- 传输只允许 https 且不跟随重定向，防止降级与令牌被带到第三方域名。
- 对端 `BACKUP_TOKEN` 建议每季度轮换：`wrangler secret put` 后同步改
  NetCenter 的 `backup.env`，旧令牌立即失效。
- 若需要异地副本，可再配 `SIREN_BACKUP_GPG_RECIPIENT` 用公钥加密；注意没有私钥
  就等于没有备份，私钥要离线保存。
