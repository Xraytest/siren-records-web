# SIREN RECORDS · 塞壬唱片非官方前端

一个为 [monster-siren.hypergryph.com](https://monster-siren.hypergryph.com) 重做的替代前端，保留黑场、细线、等宽标注与青色荧光（`#a0edff`）的美术基调，并补上原站没有的歌单与账号能力。

> 非官方项目。曲库、封面、音频与歌词版权归 塞壬唱片 / 鹰角网络 所有，本项目仅作前端技术演示。

## 功能

- **曲库档案**：运行时与官方同步（当前 304 张专辑、936 首曲目），支持检索、排序、网格 / 列表视图、随机播放。新专辑上架后无需重新部署即可自动出现在曲库，见「[曲库同步](#曲库同步与官方保持最新)」。
- **播放器**：队列、随机、循环（关闭 / 列表 / 单曲，含单曲队列原地重播，列表循环在队尾回到第一首）、进度与音量、频谱可视化、LRC 歌词逐行同步（经同源代理，不依赖第三方域 CORS）、Media Session；**音频加载失败自动重连**（换新签名地址、从断点续播，最多 4 次；只有连续稳定播放 10 秒后才归还预算，避免「一出声就归零」的无限重连；播放条上可点「重连 n/4」立即重试）。
- **歌单**：创建、重命名、描述与标签、加入曲目（单曲 / 整张专辑）、曲目增删与上下排序；「我的歌单」页支持网格 / 列表视图与四种排序（最近更新 / 创建时间 / 名称 / 曲目数），偏好本机记忆；歌单详情页可切换「自定义 / 名称 / 专辑 / 演唱者」排列（只有自定义模式显示上下移动按钮）。
- **歌单流转**：单张/全部歌单导出为 JSON 便携档案（可离线备份、跨设备互传），导入时自动解析并还原轨序；也可生成只读快照链接与分享码，免登录即可试听并转存。
- **私人 / 公开**：歌单页一键切换可见性——公开即进入「公开广场」（可随时「更新广场内容」推送最新快照），私人即撤下。
- **账号系统**：服务端注册 / 登录，密码加盐哈希保存，歌单与广场数据存于 D1/SQLite，换设备登录即可取回。

> 口令派生算法两套后端不同：Worker 用 WebCrypto **PBKDF2-SHA256（10 万次迭代）**，本地 Node 用 `node:crypto` 的 **scrypt**。
> 两者参数不同，哈希互不兼容——若要把本地库的数据迁到线上，需要重新灌入密码，不能直接搬 hash。

## 安全措施

- 全部 SQL 参数化；歌单读写按 `userId` 归属校验（IDOR 由 `ownPlaylist` 收敛）。
- 认证走 `Authorization: Bearer` 而非 Cookie，结构上免疫 CSRF。
- 登录对「用户不存在」也执行一次等价的密钥派生，抹平响应时间差；但注册接口的 409 仍会直接暴露账号是否存在（见 SECURITY.md）。
- `POST /api/auth/login|register` 有每 IP 每分钟 20 次的限速；`/auth/me`、`/auth/logout` 不计数，避免共享出口下的正常用户被误伤（Worker 建议叠加 CF WAF Rate Limiting 规则）。
- 广场只返回官方 CDN 封面（本人歌单里可存 `data:image/*` 内嵌图但不公开），每页 60 条、每账号最多 6 条，避免单账号占满广场或把 feed 撑到十几 MB。
- 响应带 CSP / X-Frame-Options / X-Content-Type-Options / Referrer-Policy / **HSTS**（`max-age=31536000; includeSubDomains`）；`/assets/*` 是带内容哈希的产物，缓存 `immutable` 一年，HTML 仍走校验。
- 过期会话定时清扫；Node 版默认只监听 `127.0.0.1`（需对外时显式 `HOST=0.0.0.0`）。
- 前端无 `innerHTML`/`eval` 等危险 sink，歌单名/描述/封面按纯文本渲染。
- 备份接口 `GET /api/backup/dump` 需 `Bearer BACKUP_TOKEN`（≥32 字符，两侧各做 SHA-256 后常量时间比较）；**未配置时对所有方法一律 404**，只接受 GET，每 IP 每小时 10 次，响应含 SHA-256 与行数供对端校验。`BACKUP_TOKEN` 用 `wrangler secret put` 注入，不入库不入代码。
- 导出按主键 `id`（sessions 按 `token`）keyset 分页（非 `OFFSET`），不会因并发插入跳行或重复；文本转义含单引号双写与 `char(0)` 拼接（含 NUL 的字段可逐字节还原）。D1 无跨语句快照隔离，一次导出不保证是严格时间点。
- 会话表只存 `sha256(token)`：备份泄露不再等于可直接接管账号（但仍有口令哈希与歌单内容，按机密数据保管）。
- 每账号最多 200 张歌单、每张最多 500 首（创建/导入/追加都校验），`coverSongCid` 与曲目一样只接受纯数字串，分享码限字符集与长度；防止单账号打光 D1 配额或让列表接口响应膨胀到几百 MB。

完整威胁模型、红队压测记录与**仍然存在的风险**见 [SECURITY.md](SECURITY.md)。

## 技术栈

前端 Vite + React 19 + TypeScript，HashRouter（适配任意子路径）。

后端有两套等价实现，接口契约一致：

- **Cloudflare Worker**（线上）：`worker/index.mjs` + D1，静态资源走 Assets 绑定，见下节「Cloudflare 部署」。
- **本地 Node**（开发）：`server/server.mjs`，内置 `node:http` + `node:sqlite`，无第三方依赖，同时托管 `dist/` 与 `/api/*`。

会话令牌有效期 30 天，存于 `localStorage` 的 `siren:token`。

## 本地运行

```bash
npm install
npm run server       # Node 后端 http://localhost:8090（含静态托管）
npm run dev          # 前端 http://localhost:5173，/api 自动代理到 8090
npm run dev:cf       # Worker 后端 http://127.0.0.1:8787（本地 D1）
npm run build        # 输出 dist/
```

本地 Node 数据默认写入项目下的 `data/siren.db`（已 gitignore），可用 `DATA_DIR` 环境变量改路径。

## Cloudflare 部署

线上地址：<https://siren.neolx.ltd>
备用地址：<https://siren-records-web.chengqing-2008.workers.dev>（部分网络会把 `workers.dev` 整个域按 SNI 阻断，故主域用自有域名）

- Worker 名 `siren-records-web`，入口 `worker/index.mjs`，配置在 `wrangler.jsonc`。
- 静态资源用 Assets 绑定（`env.ASSETS`）+ `single-page-application` 兜底，`/` 与任意前端路由都返回 `index.html`，`/api/*` 优先命中 Worker。
- 数据库用 D1（库名 `siren-records`），schema 在 `migrations/0001_init.sql`，性能索引与会话哈希迁移在 `0002_perf_indexes.sql`。
- 自定义域在 `wrangler.jsonc` 的 `routes` 里以 `custom_domain: true` 声明，Cloudflare 会自动签发并续期证书；域名需先在该账号下托管 DNS。

```bash
npx wrangler login                                   # 首次授权
npm run db:migrate                                   # 迁移守门 + 预备份 + apply（--check 只检查）
npm run deploy:safe                                  # 备份 → 构建 → 发布 → 自检
```

改动 schema 时新增 `migrations/0003_*.sql` 后再执行 `npm run db:migrate`，不要改已应用的迁移文件。
`0002` 里的 `DELETE FROM sessions` 会让已登录用户全部掉线一次，这是把明文令牌换成 SHA-256 摘要的代价，执行前需知情。

### 部署不丢数据

线上是真实用户数据，发布流程固定为 **先备份，再构建发布，最后自检**：

```bash
npm run deploy:safe
```

它会依次：只审查**线上待应用**的迁移（用词法解析器识别字符串/注释里的关键字，命中 `DROP`/`DELETE`/`TRUNCATE`/`ALTER` 等即中止，确需执行时加 `-- --allow-destructive`）→
用 `wrangler d1 export --remote` 导出整库到 `backups/d1/siren-d1-<UTC时间>.sql`，再用 `node:sqlite` 真正加载：
`PRAGMA integrity_check` + 每表行数与线上 `SELECT COUNT(*)` 逐项比对（不一致即中止）→ 写 `.sha256` →
`npm run build` → `wrangler deploy` → 线上自检（`/api/feed`、首页 CSP、**匿名访问备份接口必须 401**）。

`backups/` 目录 700、导出文件 600，只保留最近 10 份；内容含用户口令哈希与会话摘要，已在 `.gitignore` 中，不要提交或外传。

> 迁移本身不走 `deploy:safe`：`npm run db:migrate` 会先做同样的 pending 检查、导出并校验一份预备份，然后才 apply。

### 定期备份（NetCenter）

`ops/netcenter-backup/` 是运行在 NetCenter 上的备份程序：每天 04:17（±5 分钟随机延迟）通过
`/api/backup/dump` 拉取整库、校验 SHA-256 / 字节数 / 可还原性（`integrity_check`、`foreign_key_check`、
每表行数与响应头逐项比对）、zstd 压缩（可选 GPG 加密）后按「最近 30 份 + 每月最新一份，最多 12 个月」轮转。
安装、配置与恢复步骤见 [ops/netcenter-backup/README.md](ops/netcenter-backup/README.md)。

初始化两端令牌：

```bash
openssl rand -hex 32                                  # 生成令牌
npx wrangler secret put BACKUP_TOKEN --name siren-records-web
# 再把同一串令牌写入 NetCenter 的 ~/siren-backup/backup.env（chmod 600）
```

## 曲库同步（与官方保持最新）

曲库不是构建时快照，而是**运行时增量同步**的结果：后端定期把官方 `/api/albums` 与本地库对比，新专辑抓详情入库、老专辑轮流复查，前端只拉几百字节的元信息判断版本，变了才重拉全量。所以官方发新专辑后**不需要重新部署**，线上最多滞后一个同步周期。

### 数据怎么存

- 每张专辑一行：`catalog_albums(cid, payload, songCount, updatedAt)`，`payload` 就是最终下发给前端的专辑 JSON；元信息在 `catalog_meta(key, value)`（版本号、顺序、同步时间、错误）。
- 下发时按 `order`（官方最新在前）把各行 payload 原样拼成 `{"generatedAt","source","schema","version","syncedAt","lastCheckAt","albums":[…]}`，和旧快照结构兼容，老前端不受影响。
- 空库时先用 `public/data/catalog.json` 铺底：官方全量详情要 300+ 次请求，一轮抓不完，不铺底首次上线会有几小时只能看到十几张专辑。
- `migrations/0003_catalog.sql` 建这两张表，**纯新增、不碰用户数据**，`npm run db:migrate` 应用。

### 一轮同步做什么

1. 拉官方专辑列表（一次性全量，最新在前），与本地 `cid` 集合比对。
2. **新增**：抓专辑详情 + 新歌直链（单轮上限 `DETAIL_BUDGET=12` 张 / `SONG_BUDGET=24` 首，抓不完的留到下一轮，返回里的 `addedPending` 就是积压数）。**抓到一张就落库一张**，一轮被超时打断也不会白丢。
3. **复查**：`known ∩ official` 里最久没更新的 `REFRESH_BUDGET=4` 张重新抓详情（官方确实会在发布后补曲目/改信息）。
4. **下架**：先判抖动——缺失数量要 ≤ `max(3, 已知×25%)` 且官方总数没跌破本地 75%；过了这关也**不立刻删**，而是把缺失集合记到 `catalog_meta.pendingRemoval`，**下一轮再确认是同一批**（且 ≤ `MAX_REMOVALS_PER_RUN=10` 张）才真删。官方列表偶尔会短暂少几张，两轮确认能挡住这种抖动，也不会因为一次接口抽风把曲库删空。
5. 只有内容真变了才抬 `version`（前端据此判断要不要重拉），失败写 `lastError` / `lastErrorAt`；单张专辑失败不拖垮整轮，但会记 `lastWarning` 并在返回里标 `partial: true`（前端提示「部分专辑暂未更新」，不会谎报「已是最新」）。

### 谁在触发

| 运行时 | 定时 | 请求时 | 手动 |
| --- | --- | --- | --- |
| Cloudflare Worker | `wrangler.jsonc` 的 `triggers.crons` = `*/10 * * * *`（10 分钟） | `/api/catalog` 发现数据超过 20 分钟没查，`ctx.waitUntil` 里补一次 | `POST /api/catalog/sync` |
| 本地 Node | `setInterval` 10 分钟（启动 5 秒后先踢一次） | 同上（60 秒节流） | 同上 |

并发安全：同步前先抢 `catalog_meta.leaseUntil` 租约（条件 UPDATE，3 分钟 TTL），抢不到就直接返回 `{skipped:"busy"}`，多实例 / 多 isolate 同时触发也只会有一份在跑。租约值写成 `"<到期毫秒>|<本轮 token>"`，长轮次每 30 秒续租一次，续不上就中止；释放时按 token 只清自己的租约——慢轮次收尾不会把别人刚抢到的租约删掉。

防打穿：一轮开始时就把 `lastCheckAt` 落库（`skipped:"fresh"` 的间隔是 **60 秒**，`reason:"cli"` 例外），而且这个判断走的是「只读两行 meta」的轻量查询，**在被间隔挡下时不扫专辑表**；`POST /api/catalog/sync` 只接受同源请求。

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/HEAD | `/api/catalog` | 全量曲库；`ETag: "cat-<版本>-<张数>-<曲数>"` + `Cache-Control: no-cache`，带 `If-None-Match` 命中返回 304（弱比较、支持列表与 `*`）；`X-Catalog-Mode: live\|snapshot` 表明数据来源 |
| GET/HEAD | `/api/catalog/meta` | 几百字节：`mode / stale / version / albums / songs / syncedAt / lastCheckAt / lastError / lastWarning / pendingRemoval` |
| POST | `/api/catalog/sync` | 立刻同步一次；15 秒冷却（429）、60 秒内已同步过会直接返回 `skipped:"fresh"` 不打官方接口；非同步接口返回 405，跨源请求 403 |

### 前端行为

- `src/lib/catalog.ts` 是模块级 store（`useSyncExternalStore`）：启动拉一次，之后每 5 分钟探一次 `/api/catalog/meta`，切回标签页、网络恢复也会探；版本变了才重拉全量并弹差异提示（`曲库已同步 · 新增 2 张专辑 · +9 首`）。
- 快照模式下不比对版本号（后端没有可用数据库，曲库不会在运行期变化），只更新元信息，不会每 5 分钟白拉一次 484 KB。
- 页脚显示真实同步状态（`与官方同步 · 3 分钟前`），点它等于「立即同步」；设置页有自动同步开关、版本与统计、手动同步按钮。两个入口共享同一个请求与 `refreshing` 状态，连点不会重复触发。
- 手动同步会如实区分「已是最新 / 部分专辑暂未更新 / 官方接口刚查过，请稍后再试 / 同步失败」，不会把限流说成成功。
- 后端不可用 / 纯静态托管时自动回落到静态快照，页脚显示「离线快照」，界面不会空。

### 运维命令

```bash
npm run catalog:sync       # 立刻同步一轮并打印统计（--sync-catalog）；被租约或 60 秒间隔挡下时退出码 1
npm run catalog:snapshot   # 把本地库导出成 public/data/catalog.json（首启铺底 / 离线兜底），导出后需 npm run build
npm run catalog:check      # 只读：对比静态快照与官方列表，有漂移退出码 1（用于发现「快照太久没刷新」）
```

`scripts/fetch-catalog.mjs` 仍保留「从零全量抓取」的能力（`node scripts/fetch-catalog.mjs`），但现在只在需要重建快照或官方接口大改时才用；日常靠运行时同步。

> 音频直链（`sourceUrl`）是 3 小时签名的临时地址，曲库里只把它当「这首歌有音频」的标记；真正播放走 `/api/audio/:cid`（30 分钟缓存）按需换新签名，所以曲库同步不需要为过期直链操心。

## 自建部署

`vite.config.ts` 使用 `base: './'`，`dist/` 可放在任意静态服务器或子路径下；但由于账号与歌单依赖 `/api`，需与 `server/server.mjs` 同域部署（或反向代理 `/api`）。Cloudflare 之外的机器可用下面的 Docker 方式跑 Node 版。

示例（Docker，静态文件与数据库分别挂载）：

```bash
docker run -d --name siren-web --restart unless-stopped \
  -p 8090:8090 -e PORT=8090 \
  -e DIST_DIR=/app/dist -e DATA_DIR=/app/data \
  -v /path/to/dist:/app/dist:ro \
  -v /path/to/data:/app/data \
  -v /path/to/server:/app/server:ro \
  node:24-alpine node /app/server/server.mjs
```

## 声明

本项目与鹰角网络、塞壬唱片无隶属或合作关系，不提供任何音频文件的托管，播放时直接引用官方 CDN 地址。
