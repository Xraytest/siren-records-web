# 安全说明与红队记录

本站是一个单页应用 + 两个后端实现（Cloudflare Worker/D1 为线上，`server/server.mjs` 为本地镜像）。
本文记录**实际做了什么、验证到哪一步、哪里仍然不够**，不写没有验证过的结论。

最近一次红队压测：2026-11-05（本仓库提交 `117dce0` 之后）。

---

## 1. 资产与威胁模型

| 资产 | 位置 | 泄露后果 |
| --- | --- | --- |
| 用户口令哈希 + 盐 | `users.salt` / `users.hash`（PBKDF2-SHA256 10 万次） | 离线爆破，等同账号失守 |
| 会话令牌 | `sessions.token`（32 字节随机，30 天） | 直接接管会话 |
| 歌单内容 | `playlists`（未公开的私人歌单） | 隐私泄露 |
| 备份令牌 | Worker secret `BACKUP_TOKEN` | 拉走整库（含上面两项） |
| Cloudflare 账号凭据 | 只在开发机 `wrangler` 配置里，**不在 NetCenter** | 全站控制权 |

对手假设：能自由注册账号、能直连公网、能构造任意 HTTP 请求；**不能**读服务器内存、
**不能**拿到 Cloudflare 账号、**不能**在 NetCenter 上执行命令。本地用户/同机攻击不在模型内
（NetCenter 与开发机按单用户设备对待，见 §6 的残留风险）。

---

## 2. 已实施的控制

### 2.1 认证与会话

- `Authorization: Bearer siren:token` 走请求头而不是 Cookie：没有浏览器自动携带，结构上免疫 CSRF。
- 会话 30 天过期，`sessions.expiresAt > now` 在 SQL 里判断；过期会话定期清扫。
- 口令派生：Worker 用 WebCrypto **PBKDF2-SHA256（100k 次）**，本地 Node 用 `scrypt`（参数不同，
  两套库的口令哈希**互不通用**，这是已知且刻意的差异）。
- 登录时对不存在的用户名也跑一次等价派生（`dummyCreds`），抹平「存在 / 不存在」的响应时间差。
- 认证入口每 IP 每分钟 20 次（isolate 内存计数），叠加 CF WAF 才是完整防线。

### 2.2 授权

- 所有歌单读写都经过 `ownPlaylist(env, user.id, id)`：查不到即 404（不区分「不存在」与「不是你的」）。
- 覆盖的路径：`GET/PATCH/DELETE /api/playlists/:id`、`/songs`、`/publish`、`/unpublish`。
- 广场（`/api/feed`）只返回 `publishedAt IS NOT NULL` 的歌单，且只暴露
  `code/name/description/authorName/authorId/songCount/cover/tags/at`，**不含** `sessions`、`salt`、`hash`。

### 2.3 输入校验

- 请求体上限 2MB：先看 `Content-Length` 再读，超限即 413（避免 chunked 大包先进内存）。
- 字段截断：`name` 80、`description` 2000、`tags` 6×24、`songs` 500（去重、`length < 64`）。
- 类型混淆容忍：非字符串/非数组一律当空值处理，不抛 500。
- `cover` 只接受 `data:image/` 或 `https://web.hycdn.cn/siren/pic/` 前缀，限长 200KB；
  **创建与发布两条写入路径都走同一白名单**（此前只有发布走，创建可写任意串，已修）。
- 每账号最多 200 张歌单（创建与导入都校验）：没有上限时单账号可打光 D1 每日写入配额，
  连带登录一起写失败。
- 全部 SQL 参数化；唯一拼接的是备份导出里的表名（来自常量数组 `BACKUP_TABLES`）。

### 2.4 前端

- 无 `dangerouslySetInnerHTML` / `innerHTML` / `eval` / `new Function`；歌单名、描述、标签、
  作者名一律作为 React 文本节点渲染。
- `cover` 进 `<img src>`；CSP `default-src 'self'`、`img-src 'self' data: https://web.hycdn.cn`。
- 分享码是外部输入：`decodeShare` 限制码长 20k、解压后 4MB、曲目数 2000；
  `parseImport` 限制原文 8MB、歌单数 50、单张曲目 2000。
- 令牌存 `localStorage`（`siren:token`）——这是 XSS 场景下的暴露面，靠 §2.4 的无 sink + CSP 兜。

### 2.5 传输与响应头

- 全站 `Strict-Transport-Security: max-age=31536000; includeSubDomains`。
- `Content-Security-Policy`、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy`。
- `/assets/*`（带内容哈希）`Cache-Control: public, max-age=31536000, immutable`；HTML 不缓存。
- `/api/*` 一律 `Cache-Control: no-store`。

### 2.6 备份链路

- `GET /api/backup/dump`：必须 `Bearer BACKUP_TOKEN`；未配置或长度 < 32 时**直接 404**
  （不暴露入口存在）；仅 GET；每 IP 每小时 10 次；令牌比较常量时间（不按长度提前返回）。
- 响应带 `X-Backup-Sha256 / X-Backup-Bytes / X-Backup-Tables / X-Backup-At`，`no-store`。
- 导出按 `rowid` keyset 分页（非 `OFFSET`）；单引号双写、NUL 用 `char(0)` 拼接、BLOB 用 `X'..'`。
- NetCenter 侧：令牌只存在 600 的 `backup.env` 与临时 curl config，不上命令行、不进日志；
  配置里的 URL/token/数字全部前置校验（拒绝引号、换行、非数字）；`flock` 防并发；
  还原校验在内存 SQLite 里跑 `integrity_check` + `foreign_key_check` + 孤儿行 + `--min-users`；
  失败不覆盖、不轮转、写 `state/last-error.txt` 并非零退出。
- 落盘：`~/siren-backup` 700，dump 600，可选 GPG 公钥加密。

---

## 3. 红队压测（2026-11-05）

### 3.1 自动化对抗套件（本地镜像后端，30 条全绿）

`_tmp/redteam-api2.mjs` 直接打真实 HTTP 接口，覆盖：

1. 注册 A/B 两账号；A 建歌单。
2. **IDOR ×5**：B 对 A 的歌单做 `GET / PATCH / DELETE / publish / unpublish`，全部 4xx。
3. 匿名读歌单 → 401/404。
4. 伪造 64 位会话令牌 → 401。
5. 畸形 JSON（`{"name":`）→ 400。
6. 超长 name（500）→ 截断到 ≤80；超长 description（5000）→ 2000。
7. **封面白名单 ×7**：`data:application/javascript`（拒）、`data:image/svg+xml`（收，`<img>` 内惰性）、
   官方 CDN（收）、`https://evil.example`（拒）、`//evil.example`（拒）、`http://` 官方域（拒）、
   `https://web.hycdn.cn@siren.neolx.ltd/x.jpg`（拒）。
8. 发布 → 进广场；广场 JSON 不含会话令牌、不含 `salt/hash/password`；撤下 → 移出广场。
9. 类型混淆（`songs:"x"`、`tags:{}`、`publishCode:{$ne:1}`）→ 200 且字段归一。
10. 原型污染（`__proto__`）→ 全局 `{}` 未被污染。
11. **创建时恶意 cover** → 不落库、发布后 feed 里 `cover` 为空。
12. **歌单配额**：连建 205 张 → 第 201 张 409；`import` 超配额同样 409。
13. 3MB 请求体 → 413 / 连接被拒。

结果：`TOTAL=30 FAILED=0`（本地 `node:sqlite` 镜像；Worker 侧同源逻辑，见 §3.3）。

### 3.2 备份脚本负向测试（NetCenter 真机）

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| 错误令牌 | 401，给出「令牌可能已轮换」 | 通过，`exit=1` |
| `KEEP_DAILY=0` | 启动前拒绝，**不删任何文件** | 通过，dumps 数量不变 |
| `backup.env` 权限 644 | 拒绝运行 | 通过 |
| `http://` URL | 拒绝（禁止明文传输） | 通过 |
| `MIN_FREE_MB` 大于可用空间 | 拒绝 | 通过（143405MB 可用） |
| 并发执行 | `flock` 拦住第二个 | 通过 |
| 轮转保留 (5,3) | 5 份日备 + 3 个月备 + 3 个 sidecar | 通过，孤儿 `.sha256` 被清 |
| dump 被截断 / 缺表 | 还原校验失败并非零退出 | 通过 |
| 正常跑 | 落盘 600、写 `last-success.json`、清空 `last-error.txt` | 通过 |

### 3.3 线上验证

- `https://siren.neolx.ltd`：HTML / `/assets/*` / `/api/feed` / `/api/backup/dump` 均带 HSTS；
  `/assets/*` 为 `immutable`，`/api/*` 为 `no-store`。
- 用真令牌拉一次 dump：`Content-Length` 与 `X-Backup-Bytes` 一致、SHA-256 与本地文件一致、
  `restore-check.py` 在内存 SQLite 里 `integrity_check=ok`。
- 线上建号 → 建歌单（带恶意 cover）→ 发布：feed 里 `cover` 为空；随后撤下并删除，
  测试账号与它的会话、歌单已从 D1 清除。
- **恢复可用性端到端验证**：把线上 dump 灌进全新 SQLite → 直接让本地服务端跑这份数据 →
  `/api/auth/me`、`/api/playlists`、`/api/playlists/:id` 均正常返回（3 张歌单、曲目数一致、
  `/api/feed` 200）。即「备份文件不只是一个能通过 integrity_check 的文件，而是真能被应用读起来」。
  （口令哈希与本地 scrypt 不通用，所以登录只能靠直接写入会话行来验证，这点在 §3.5 已说明。）

### 3.4 本轮修复的真实缺陷

1. **创建歌单时 cover 未过白名单**（`worker/index.mjs` / `server/server.mjs` 的 `insertPlaylist`）：
   任意字符串（上限是 2MB body）可长期占用存储并进入广场数据。→ 已改为 `normalizeCover`。
2. **无每账号歌单上限**：单账号可把 D1 每日写入配额打光，导致全站写入（含登录）失败。
   → 加 200 张上限，创建与导入两条路径都校验。
3. **备份脚本把 `$?` 判成 `if !` 的反转值**：失败时日志写成 `curl 退出码 0`。
   → 先存 `curl_rc` 再分支，并按 401/429 给不同提示。
4. **备份脚本接受 `KEEP_DAILY=0`**：轮转会删光历史只留 1 份。→ 启动前拒绝（这是本轮
   负向测试真实触发的破坏，已从备份恢复为「保留全部」策略）。
5. **Worker 令牌比较按长度提前返回**：可用响应时间推断令牌长度。→ 改为等长循环。
6. **分享码/导入无上限**：LZString 展开比很高，一个链接即可让标签页 OOM。→ 加码长/解压长度/条目数上限。
7. **限速表只增不减**：长期运行会累积过期 IP 条目。→ 超过阈值时懒清理。

### 3.5 仍然存在的风险（不打算在本轮修）

- **限速是 isolate 内存计数**：多实例不共享，重启即清零，只挡单点连打。
  真正的防线是 CF WAF Rate Limiting（需在控制台配规则，代码里做不了）。
- **`localStorage` 存会话令牌**：任何成功的 XSS 都可直接读走。缓解是无 sink + CSP，
  彻底方案是改 HttpOnly Cookie + SameSite（会引入 CSRF 面，需要配套 CSRF token）。
- **备份含 `sessions.token`**：拿到备份文件 = 拿到当时所有活跃会话。备份按机密数据管理
  （700/600，不进 Git），如需异地副本请用 GPG 加密并离线保管私钥。
- **D1 无跨语句快照隔离**：一次导出不是严格时间点备份。keyset 分页只保证不跳行/不重复。
- **恢复是覆盖式的**：导出脚本以 `DELETE FROM` 开头，恢复 = 回滚到导出时刻。
- **NetCenter 是单机单用户**：`backup.env` 明文令牌、dump 明文落盘，靠文件权限保护；
  没有 HSM/KMS。若该机被拿下，历史备份全部泄露。
- **本地镜像后端与线上口令哈希不通用**：不要把线上 D1 的备份直接喂给本地服务端去验证登录。

---

## 4. 复现

```bash
# 本地对抗套件（30 条）
node server/server.mjs                       # 端口按需
BASE=http://127.0.0.1:8126 node <套件脚本>

# 线上头部与 dump 校验
curl -sSI https://siren.neolx.ltd/ | grep -i strict-transport
curl -sS -D- -o dump.sql -H "Authorization: Bearer $TOKEN" https://siren.neolx.ltd/api/backup/dump
python3 ops/netcenter-backup/restore-check.py --min-users 1 dump.sql

# 备份脚本负向（NetCenter）
SIREN_BACKUP_KEEP_DAILY=0 ~/siren-backup/backup-d1.sh   # 必须启动前就拒绝
```

对抗套件脚本与一次性验证脚本放在工作区的 `_tmp/`（不入库：它们含测试令牌与本地路径）。
