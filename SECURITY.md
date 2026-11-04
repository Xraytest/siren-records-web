# 安全说明与红队记录

本站是一个单页应用 + 两个后端实现（Cloudflare Worker/D1 为线上，`server/server.mjs` 为本地镜像）。
本文记录**实际做了什么、验证到哪一步、哪里仍然不够**，不写没有验证过的结论。

最近一次红队压测：2026-11-05 晚（第二轮，覆盖本轮修复；第一轮基线见 §3）。

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
- **会话表只存 `sha256(token)`**：库与备份里都没有可用令牌；令牌本身只在客户端与响应里出现一次。
  `sessions(expiresAt)` / `sessions(userId)` 有索引（清扫与按用户吊销不再全表扫描）。
  **代价（一次性）**：升级到该版本后所有旧会话失效，用户需要重新登录一次；
  迁移 `0002` 会清空旧格式的明文会话行。
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

- 请求体上限 2MB：**按字节流式读取**并在超限时立刻 `cancel()` + 413，而不是 `await request.text()`
  先整包进内存（chunked 请求没有 `Content-Length`，只看声明头挡不住；`text.length` 又是 UTF-16 计数，
  3 字节字符能把 2MB 上限撑成 6MB）。
- 字段截断：`name` 80、`description` 2000、`tags` 6×24、`songs` 500（去重、`length < 64`）。
- `coverSongCid` 与曲目 cid 同一规则（纯数字串、≤16）：此前这个字段没有任何校验，
  单账号可以塞进 200×2MB 的字符串，让 `GET /api/playlists` 永久 500。
- `/songs` 追加接口校验**合并后的总量** ≤500（此前只限单次 500 条，可循环追加让单行无限膨胀）。
- 发布码：只允许 LZString 的 URI-safe 字母表、长度 ≤20000，超长直接 413（不静默截断成坏链接）；
  占码用**单条条件 UPDATE** 完成（`NOT EXISTS` 同语句判重），并发发布不会产生两张卡片指向同一个码。
- 广场封面只回官方 CDN URL（`data:` 封面留在自己的歌单里，不进匿名 feed）；单账号最多占 6 个展示位。
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
- 分享码是外部输入：`decodeShare` 在**解压过程中**按 4MB 预算中止（不是解完再看长度），
  码长 20k、曲目数 2000。实测：20KB 的码原本可解出 4741 万字符 / RSS 154MB；现在约 4ms 中止、
  只多占 4MB。`parseImport` 限制原文 8MB、歌单数 50、单张曲目 2000，`Account` 的导入先判 `file.size`。
- 播放失败自动重连：必须连续稳定播放 10s 才算「成功」并归还重试预算；抖动流会在 4 次后暂停，
  而不是「一出声就清零」导致的每 800ms 重载死循环。
- 登出/401 统一清理 `siren:token` 与播放器本地态（`siren:player`），共享设备上不残留上个账号的队列与歌单名。
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
- 导出按**不复用的主键**（`users.id` / `sessions.token` 哈希 / `playlists.id`）keyset 分页：
  早期用 `rowid > ?`，游标行在两次查询之间被删除并复用 rowid 时会静默少一行（已实测复现）。
- 导出内容里 `sessions` 只有 `sha256(token)`，**不再包含可用会话**。
- NetCenter 侧：令牌只存在 600 的 `backup.env` 与临时 curl config，不上命令行、不进日志
  （不用 `set -a`，令牌不进子进程环境）；跑前不向子进程导出变量；
  配置里的 URL/token/数字全部前置校验（拒绝引号、反斜杠、换行、非数字、前导零）；
  `KEEP_*`/`MIN_*`/`DIR` 在 source 之后取默认值（否则 `backup.env` 里的设置会被静默忽略）；
  `flock` 缺失直接失败；`trap` 在 INT/TERM 时退出并清理；压缩先写 `*.part`，校验后才 `mv -n`，
  半成品不会被轮转当成有效备份；`last-error.txt` 只留最近 50 条；`last-success.json` 用 `jq` 生成。
- 还原校验在内存 SQLite 里按 `sqlite3.complete_statement` 逐句重建，拒绝 `ATTACH`/`DETACH`/`VACUUM`/
  写操作 `PRAGMA`（备份来自网络，被篡改时不该能在校验机落盘），再跑
  `integrity_check` + `foreign_key_check` + 孤儿行 + `--min-users` +
  `--expect-counts`（与响应头 `X-Backup-Tables` 交叉比对，防止「schema 齐全但数据是另一份」）。
- `npm run deploy:safe`：部署前先拉一份线上 dump，用 `node:sqlite` 校验完整性 + 每表行数 +
  `users>=1`，写 `.sha256`；备份目录 700、文件 600、只留最近 10 份；线上 `/api/backup/dump`
  必须对匿名请求返回 401 才允许部署。迁移闸门 `npm run db:migrate` 只检查 **pending** 迁移，
  用 SQL 词法切分（正确处理字符串与块注释）判定破坏性语句。
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
- ~~**备份含 `sessions.token`**~~：第二轮已改为只存 `sha256(token)`（见 §5.2），
  备份泄露不再直接等于账号失守；剩余风险是备份里仍有口令哈希与歌单内容。
- **D1 无跨语句快照隔离**：一次导出不是严格时间点备份。keyset 改用不复用主键后不再跳行，
  但跨表仍可能看到「注册写了一半」的组合（还原校验会把它判为孤儿行/外键违例并整份失败，
  即宁可这次没备份成功，也不落一份坏备份）。
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
第二轮新增的命令见 §5.5。

---

## 5. 第二轮红队与修复（2026-11-05 凌晨）

### 5.1 方法

四条独立审计线并行，各自只读通读源码并独立复现，避免"同一套假设验证自己"：

1. **后端 / Worker / Node 镜像**：认证、授权、限速、去向可控的出站代理、备份导出。
2. **前端与播放器**：XSS sink、分享码解压、CSP 与歌词链路、重试状态机、循环/随机语义。
3. **备份链路**：`ops/netcenter-backup/*`（脚本、unit、文档）+ 恢复校验器。
4. **迁移与部署闸门**：`deploy-safe.mjs`、`migrate.mjs`、`sql-scan.mjs` 的真实拦截能力。

之后做运行时对抗：两个运行时（Node 镜像 `server/server.mjs` 与 `wrangler dev`）各跑一遍
19 条对抗套件；用 Playwright 真实无头 Chrome 跑 21 条 UI、9 条重试用例、13 条循环用例；
在 NetCenter（树莓派 pi）上跑备份脚本的负向/保留策略测试，并用加固后的 systemd unit
真实执行一次。

> 术语：**实测**＝在该机器上跑出的结果；**代码级**＝静态确认 + 单测，没有做端到端复现。
> 本轮修复前的缺陷行号一律以修复前版本为准，避免读者拿新行号对不上。

### 5.2 本轮修复（按风险排序）

#### P1

1. **Node 镜像备份令牌比较可被完全绕过**（`server/server.mjs` `safeEqual`）：
   旧实现把令牌当 hex 解码，令牌首字符不是 `[0-9a-f]` 时两边都解成 0 字节，
   `Bearer x` 之类任意令牌即可通过——而安装脚本允许 `openssl rand -base64` 形态的令牌。
   → 改为对两侧明文各做 SHA-256 后 `timingSafeEqual`（等长、无长度通道），与 Worker 同一实现。
   **实测**：非 hex 令牌配置下错误令牌返回 401（对抗套件第 1、2 条）。

2. **Worker 请求体上限可被 chunked 绕过，且按 UTF-16 长度而非字节计**：
   旧实现只看 `Content-Length`，然后 `await request.text()` 把整个包读进 isolate 再判长度。
   → 改为流式按字节累计、超 2 MiB 立刻 `cancel()` 并 413，无声明头也拦得住。
   **实测**：无 `Content-Length` 的 5 MB chunked body → 413；700k 汉字（≈2.1 MiB）→ 413。

3. **会话令牌明文入库并被整表导出**：拿到任意一份 dump 即可接管当时全部活跃会话。
   → `sessions` 只存 `sha256(token)`，登录时算摘要再查；迁移 `0002` 里的 `DELETE FROM sessions`
   让旧明文令牌一次性失效（**代价：所有已登录用户需要重新登录**）。
   **实测**：导出中不含任何明文会话令牌（套件第 15 条）；NetCenter 最新备份里
   `sessions.token` 全部是 64 位十六进制摘要（15 行）。

4. **`publishCode` 完全不受信**：不限字符集、不唯一、超长静默截断、与歌单内容无绑定。
   → 校验 LZString 字母表与长度（超限 413）、`publishCode` 加 UNIQUE 索引 + 条件 UPDATE 原子登记（冲突 409）。
   **实测**：8 路并发发布同一码 → 恰好 1×200 / 7×409；3 万字符 → 413；含 `#` `/` 的码 → 400；
   广场里该码只有一张卡片。

5. **无上限的公开数据面**：`/api/feed` 每个封面允许 200 KB `data:`、60 条一页（单请求约 12 MB，
   且 60 个槽位可被一个账号占满）；`coverSongCid` 三条写入路径都没有长度上限；
   `/playlists/:id/songs` 只限单次 500 条、不设总量上限。
   → 广场只带官方 CDN 封面、每账号最多 6 条；`coverSongCid` 按 cid 规则限长；
   合并后 `songs.length <= 500` 否则 409。
   **实测**：12 张 vs 2 张的两个账号，广场出现 6 张 / 2 张；1.9 MB `coverSongCid` 被拒（落库为 null）；
   加到 401 首后再加 200 首 → 409；`GET /api/playlists` 响应保持 < 200 KB。

6. **备份接口的"不存在"语义失效、限速在鉴权之后**：未配置时 `POST` 仍返回 405（暴露入口存在），
   猜测令牌不消耗配额。→ 未配置时对所有方法一律 404；方法检查 → 配置检查 → 限速 → 令牌校验；
   只接受 GET。**实测**：本地未配置实例 GET/POST/HEAD 全 404；连续错令牌最终 429（套件第 19 条）。

7. **迁移闸门名不副实**：`db:migrate` 直接调 `wrangler d1 migrations apply`，闸门只在
   `deploy:safe` 里（而那条路径从不 apply 迁移）；正则扫描可被块注释/字符串里的 `--` 绕过；
   并且它扫描全部历史迁移。→ 新增 `scripts/migrate.mjs`（pending → 词法扫描 → 预备份 → apply）
   并接到 `npm run db:migrate`；`deploy:safe` 改为只查 pending。
   **本轮最后验证时又发现并修掉一个真问题**：两个脚本都用「整行只有一个文件名」解析
   `wrangler d1 migrations list` 的输出，而 wrangler 4 输出的是带边框的表格
   （`│ 0002_perf_indexes.sql │`）——解析结果为空，`db:migrate` 会误报「线上已是最新」
   并**静默跳过**待应用迁移，`deploy:safe` 也据此跳过破坏性检查。
   → 抽出 `scripts/lib/wrangler-migrations.mjs` 统一解析并加 5 条单测。
   **实测**：修复前 `npm run db:migrate -- --check` 打印「线上已是最新」；
   修复后正确报告「待应用迁移：0002_perf_indexes.sql」并以破坏性语句（`DELETE FROM sessions`）中止。

8. **备份脚本的静默数据丢失**：
   - `backup.env` 里的 `KEEP_DAILY/KEEP_MONTHLY/MIN_FREE_MB/MIN_USERS/SIREN_BACKUP_DIR` 在读取配置**之前**
     已定型，全部被静默忽略（`KEEP_DAILY=365` 实际仍按 30 轮转）。
   - `KEEP_MONTHLY=08`/`09` 被 bash 当八进制，`(( … ))` 报错后 `set -e` 在 `if` 上下文不生效，
     直接落到 `rm` —— 静默删掉超出 daily 窗口的**所有**月度归档。
   - 压缩/加密中途失败留下的半截文件会被轮转当成有效备份，最坏情况让某个月只剩坏文件。
   - 缺 `jq` 时脚本直接 die；而 NetCenter 上实际**没有 jq**（这一条是部署时真机跑出来的）。
   → 默认值移到 `source` 之后；整数校验改为拒绝前导零并在 `retention()` 里 `10#` 归一化；
   先写 `$out.part`、校验通过后 `mv -n` 转正；`trap 'cleanup; exit 130'`；`flock` 从"可选"改为必需；
   临时目录放 `$ROOT_DIR/tmp`（与 dumps 同文件系统，`df` 守卫查的就是它）；
   `last-error.txt` 只留最近 50 行；成功状态 JSON 改用 python3 生成（不再依赖 jq）；
   去掉 `--retry-all-errors`（401/429 不再重试烧配额）；日志不再打印完整 URL；去掉 `set -a`。
   **实测（NetCenter 真机）**：配置 `KEEP_DAILY=365` + 40 份历史 → 跑完保留 **41/41**；
   `KEEP_MONTHLY=08` 启动即拒绝且 3 份历史一份不少；`KEEP_DAILY=030` 拒绝；
   `.part` 半成品未被转正也未被轮转删除；加固 unit 下 `Result=success`。

9. **恢复校验器会改写数据、且能执行服务端 SQL**：旧实现用正则全局剥 `BEGIN/COMMIT/PRAGMA`，
   会改动含这些字样的文本值（校验对象 ≠ 落盘文件）；`executescript` 允许 `ATTACH`/`VACUUM INTO`。
   → 用 `sqlite3.complete_statement` 逐句切分、只跳过整句包装语句；`set_authorizer`
   拒绝 ATTACH/DETACH/VACUUM 与写 PRAGMA；`errors="strict"`；新增 `--expect-counts`
   把响应头声明的行数与真实还原行数逐表比对。
   **实测**：`restore-check.py --min-users 1 --expect-counts "users:2,sessions:15,playlists:4"`
   → `ok:true, integrity:ok, expected` 全一致。

10. **`deploy:safe` 的"校验导出"只有 4 个子串 + 512 字节**：空库/另一份库/干净截断都能过，
    而它是部署前唯一回退点。→ 用 `node:sqlite` 真正加载 dump：`integrity_check` + 每表行数
    + 与线上 `SELECT COUNT(*)` 比对，写 `.sha256`，目录 700 / 文件 600，只留最近 10 份；
    线上自检要求匿名访问 `/api/backup/dump` 必须 401。

#### P2 / 前端

11. **分享码"先解压、后限长"**：`CODE_MAX=20,000` 的码实测可解出 47,409,453 字符、
    RSS 154 MB、49 ms——护栏在分配之后。→ 把预算下沉到解压过程本身，超预算立即中止。
    **实测**：同一份 47 MB 展开的码，新路径 `out=null`、3.6 ms、RSS 增量 4.2 MB（不再分配 47 M 字符）。

12. **生产环境歌词永久为空**：歌词接口 302 到 `web.hycdn.cn`，而线上 CSP `connect-src` 不含该域，
    只有开发环境正常。→ 歌词改由 Worker **同源代理**返回 `.lrc` 文本，不再依赖 CSP 放行第三方域。
    **实测**：`GET /api/lyric/779439` → 200 `text/plain; charset=utf-8`、1338 字节。

13. **自动重试的"最多 4 次"形同虚设**：`play()` resolve 或 `playing` 事件一到就把计数清零，
    "先播起来再断"的流可以无限 800 ms 重连，用户永远等不到"请手动重试"。
    → 计数只在**连续稳定播放 10 秒**后才归还；同时把同一次加载失败的
    `error` 与 `play()` rejection 两个信号合并（否则一次失败消耗两次预算）。
    **实测（Playwright）**：`重连 1/4 → 2/4 → 3/4 → 4/4`、请求正好 4 次、退避 800/1600/3200/6400 ms、
    放弃提示出现；点击播放手动恢复；稳定 10 s 后预算归还。

14. **列表循环在队尾不绕回队首**：`handleEnded` 把 `{restart:true}` 一律当"原地重播"，
    即使 `advanceTrack` 返回的 `index` 已经变成 0；表现为队尾一直重播最后一首。
    → 只有 `result.index === state.index` 才原地重播，否则 `startAt(result.index)`。
    **实测**：修复前队尾循环停在 `Voices`；修复后 13 条循环用例全绿
    （关闭停在最后一首、全部绕回第一首、单曲从 00:00 重播、选择在刷新后保持）。

15. **UI 文案与"撤下"语义**：正文案统一为「加入歌单」；「设为私人/从广场撤下」的确认文案
    改为如实说明「已发出的分享链接仍可打开」（分享码自包含，服务端无法撤回）；
    歌单页新增排列模式（自定义 / 名称 / 专辑 / 演唱者），非自定义模式隐藏移动按钮。
    **实测**：默认顺序、四种模式、移动按钮显隐、公开/私人徽标与 toast 全部符合预期；
    旧文案「将音乐放入歌单」不再出现，「加入歌单」出现。

16. **部署链的两个自否决/假校验缺陷（执行迁移时才暴露）**：
    (a) `db:migrate` 的预备份调用 `deploy-safe --backup-only`，而后者仍跑迁移闸门——
    带 `DELETE FROM` 的迁移会让"先备份再 apply"永远无法开始。
    → `--backup-only` 不再跑闸门（`migrate.mjs` 已先跑过同一检查）。
    (b) `deploy-safe` 的线上行数校验把 SQL 塞进 `--command`，被参数空白保护拒绝；
    改用 `--file` 后又因 wrangler 批量执行**不返回 SELECT 结果**（只返回
    "Total queries executed"）而把每张表都算成 0，导致任何真实备份都被判"不完整"。
    → 改为自行拼一条带引号的命令行（SQL 只由常量表名构成），实测线上 `2/15/4`
    与导出逐表一致；缺失时仍降级为 null 而不是 0。
    **实测**：`node scripts/deploy-safe.mjs --backup-only` → `users:2,sessions:15,playlists:4`；
    `npm run db:migrate -- --allow-destructive` 应用 `0002` 成功。

### 5.3 运行时证据汇总

| 套件 | 条数 | 结果 | 说明 |
| --- | --- | --- | --- |
| 对抗套件（Node 镜像） | 19 | 全绿 | 令牌绕过、chunked、并发发布、膨胀、公平性、会话哈希、限速 |
| 对抗套件（wrangler dev） | 19 | 全绿 | 同上，验证 Worker 与镜像行为一致 |
| UI Playwright | 21 | 全绿 | 真实登录/建歌单/排列/公开私人/播放条，控制台 0 error |
| 重试 Playwright | 9 | 全绿 | 逐级重连、放弃、手动恢复、稳定后归还预算 |
| 循环 Playwright | 13 | 全绿 | off/all/one、刷新保持、回到 off |
| NetCenter 备份脚本 | 4 组 | 全绿 | 配置生效 41/41、08 拒绝、030 拒绝、`.part` 不转正 |
| NetCenter 加固 unit | 1 次 | `Result=success` | 沙箱内 DNS/AF_UNIX/python3 均正常 |
| 恢复演练（独立解压+校验） | 1 次 | `ok:true` | 2 users / 15 sessions / 4 playlists |

线上只读探测：首页 200 且带 CSP `frame-ancestors 'none'`；`/api/feed` 200；
匿名 `/api/backup/dump` 401；音频 302 到 `res01.hycdn.cn`；歌词同源 200。

迁移 `0002` 应用后的线上状态（`wrangler d1 execute` 实测）：`users=2, sessions=0, playlists=4,
published=0`，三个索引（`sessions_expires` / `sessions_user` / `playlists_publish_code`）齐备；
`feed` 为空是因为没有公开歌单（不是故障）。会话表清空是本次迁移的预期代价，所有旧登录需重新登录一次。
NetCenter 随后一次真实备份记录 `users:2,sessions:0,playlists:4`、`restore.ok=true`。

### 5.4 仍然存在 / 明确接受的风险

- **注册 409 仍可直接枚举账号是否存在**（与登录侧的等时派生互相矛盾）。未改，因为改语义会影响
  现有前端提示；若要修，建议注册也走"统一成功 + 验证码"。
- **PBKDF2-SHA256 100k** 低于 OWASP 当前对 PBKDF2 的建议（600k）；提高迭代数会让 Worker CPU 超限，
  需要连同登录限速与迁移策略一起设计，本轮未动。
- **限速仍是 isolate 内存计数**：多实例不共享、重启清零；真正的防线是 CF WAF 规则。
- **D1 无跨表快照**：导出可能看到"注册写了一半"的组合；校验器会判整份失败（宁可这次没备份成功）。
- **`localStorage` 存令牌**：无 XSS 时安全，有 XSS 即失守；彻底方案是 HttpOnly Cookie + CSRF token。
- **分享码自包含**：撤下/删除歌单都不会让已发出的链接失效（UI 文案已如实告知）；要真正撤回需服务端码注册表。
- **已发布歌单的元数据实时、`code` 是快照**：改了歌单不点"更新广场内容"，广场卡片显示新信息而
  "试听"播放旧内容。属体验问题，未在轮次内修。
- **前端剩余 P3 未修**（不影响本轮验收）：`prev` 在随机模式下退到物理上一首、
  `removeFromQueue` 不重映射随机已播集合、`moveSong` 用显示下标（有缺失 cid 时改错曲目）、
  导入 0 组仍弹成功 toast、UI 声称支持"分享码"但没有粘贴框、过期 token 后顶部仍显示已登录、
  登出不清 `siren:player`（换账号残留上个账号队列与歌单名）。
- **Node 镜像 BLOB 导出仍用 `Buffer.isBuffer`**：当前 schema 无 BLOB 列，属潜在缺陷。
- **备份链路单机、明文落盘、无 HSM/KMS**：`backup.env` 与 dumps 靠 700/600 权限保护；
  GPG 可选但当前未启用（无收件人），因此沙箱内 GPG 加密路径**未实测**。
- **备份轮转的月度代表是"该月最新一份"**（行为合理，早期文档写成"第一份"，已修正）。

### 5.5 复现

```bash
# 本地镜像 + 对抗套件（19 条；需要 BACKUP_TOKEN 为非 hex 串以覆盖历史绕过）
cd siren-records-web
BACKUP_TOKEN='rt9999…' PORT=8137 node server/server.mjs &
BASE=http://127.0.0.1:8137 BACKUP_TOKEN='rt9999…' node redteam2.tmp.mjs

# 迁移闸门：必须正确识别 pending 并在破坏性语句上中止
npm run db:migrate:check

# 单测（含迁移输出解析、重试策略、队列语义）
npm test

# 分享码解压预算：旧路径会先分配 47,409,453 字符
node bomb-test.tmp.mjs

# NetCenter 备份真机负向/保留测试
scp ops/netcenter-backup/{backup-d1.sh,restore-check.py} pi:/tmp/…
# 见 _tmp/pi-backup-verify.sh：配置生效 41/41、08/030 拒绝、.part 不转正
```

> 上述 5 个临时脚本（`redteam2.tmp.mjs`、`bomb-test.tmp.mjs`、`e2e-{ui,retry,repeat}.tmp.mjs`）
> 在交付时已归档到仓库外的 `D:\WorkSpace\_tmp\siren-round2-suites\`，不随仓库分发；
> 需要复跑时把工作目录切到该目录并设 `BASE` 指向本地镜像即可。

