# SIREN RECORDS · 塞壬唱片非官方前端

一个为 [monster-siren.hypergryph.com](https://monster-siren.hypergryph.com) 重做的替代前端，保留黑场、细线、等宽标注与青色荧光（`#a0edff`）的美术基调，并补上原站没有的歌单与账号能力。

> 非官方项目。曲库、封面、音频与歌词版权归 塞壬唱片 / 鹰角网络 所有，本项目仅作前端技术演示。

## 功能

- **曲库档案**：298 张专辑、911 首曲目，支持检索、排序、网格 / 列表视图、随机播放。
- **播放器**：队列、随机、循环（关闭 / 列表 / 单曲，含单曲队列原地重播）、进度与音量、频谱可视化、LRC 歌词逐行同步、Media Session；**音频加载失败自动重连**（换新签名地址、从断点续播，最多 4 次，播放条上可点「重连 n/4」立即重试）。
- **歌单**：创建、重命名、描述与标签、加入曲目（单曲 / 整张专辑）、曲目增删与上下排序；「我的歌单」页支持网格 / 列表视图与四种排序（最近更新 / 创建时间 / 名称 / 曲目数），偏好本机记忆。
- **歌单流转**：单张/全部歌单导出为 JSON 便携档案（可离线备份、跨设备互传），导入时自动解析并还原轨序；也可生成只读快照链接与分享码，免登录即可试听并转存。
- **私人 / 公开**：歌单页一键切换可见性——公开即进入「公开广场」（可随时「更新广场内容」推送最新快照），私人即撤下。
- **账号系统**：服务端注册 / 登录，密码加盐哈希保存，歌单与广场数据存于 D1/SQLite，换设备登录即可取回。

> 口令派生算法两套后端不同：Worker 用 WebCrypto **PBKDF2-SHA256（10 万次迭代）**，本地 Node 用 `node:crypto` 的 **scrypt**。
> 两者参数不同，哈希互不兼容——若要把本地库的数据迁到线上，需要重新灌入密码，不能直接搬 hash。

## 安全措施

- 全部 SQL 参数化；歌单读写按 `userId` 归属校验（IDOR 由 `ownPlaylist` 收敛）。
- 认证走 `Authorization: Bearer` 而非 Cookie，结构上免疫 CSRF。
- 登录对「用户不存在」也执行一次等价的密钥派生，抹平响应时间差，避免用户名枚举。
- `/api/auth/*` 有每 IP 每分钟 20 次的限速（Worker 建议叠加 CF WAF Rate Limiting 规则）。
- 广场封面仅接受 `data:image/*` 或官方 CDN 前缀，并限长 200KB，避免 feed 被单条发布撑爆。
- 响应带 CSP / X-Frame-Options / X-Content-Type-Options / Referrer-Policy / **HSTS**（`max-age=31536000; includeSubDomains`）；`/assets/*` 是带内容哈希的产物，缓存 `immutable` 一年，HTML 仍走校验。
- 过期会话定时清扫；Node 版默认只监听 `127.0.0.1`（需对外时显式 `HOST=0.0.0.0`）。
- 前端无 `innerHTML`/`eval` 等危险 sink，歌单名/描述/封面按纯文本渲染。
- 备份接口 `GET /api/backup/dump` 需 `Bearer BACKUP_TOKEN`（≥32 字符，常量时间比较），未配置密钥时直接 404；只读、仅 GET、每 IP 每小时 10 次，响应含 SHA-256 与行数供对端校验。`BACKUP_TOKEN` 用 `wrangler secret put` 注入，不入库不入代码。
- 导出按 `rowid` keyset 分页（非 `OFFSET`），备份过程中的插入不会造成跳行/重复；文本转义含单引号双写与 `char(0)` 拼接（含 NUL 的字段可逐字节还原）。D1 无跨语句快照隔离，一次导出不保证是严格时间点。

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
- 数据库用 D1（库名 `siren-records`），schema 在 `migrations/0001_init.sql`。
- 自定义域在 `wrangler.jsonc` 的 `routes` 里以 `custom_domain: true` 声明，Cloudflare 会自动签发并续期证书；域名需先在该账号下托管 DNS。

```bash
npx wrangler login                                   # 首次授权
npx wrangler d1 migrations apply siren-records --remote
npm run build && npx wrangler deploy
```

改动 schema 时新增 `migrations/0002_*.sql` 后再执行一次 migrations apply，不要改已应用的迁移文件。

### 部署不丢数据

线上是真实用户数据，发布流程固定为 **先备份，再构建发布，最后自检**：

```bash
npm run deploy:safe
```

它会依次：审查 `migrations/*.sql` 是否含 `DROP`/`DELETE`/`TRUNCATE`/`ALTER`（有则中止，确需执行时加 `-- --allow-destructive`）→
`wrangler d1 export --remote` 导出整库到 `backups/d1/siren-d1-<UTC时间>.sql` 并校验内容 →
`npm run build` → `wrangler deploy` → 访问线上 `/api/feed` 与首页确认可用。

`backups/` 含用户口令哈希，已在 `.gitignore` 中，不要提交或外传。

### 定期备份（NetCenter）

`ops/netcenter-backup/` 是运行在 NetCenter 上的备份程序：每天 04:17 通过
`/api/backup/dump` 拉取整库、校验 SHA-256 与可还原性、压缩轮转（最近 30 份 + 每月 1 份共 12 个月）。
安装与恢复步骤见 [ops/netcenter-backup/README.md](ops/netcenter-backup/README.md)。

初始化两端令牌：

```bash
openssl rand -hex 32                                  # 生成令牌
npx wrangler secret put BACKUP_TOKEN --name siren-records-web
# 再把同一串令牌写入 NetCenter 的 ~/siren-backup/backup.env（chmod 600）
```

## 曲库快照

`public/data/catalog.json` 是构建时抓取的静态快照，前端直接读取，避免线上 API 的跨域限制。

重新抓取（网络需要能访问官方 API，可选代理）：

```bash
node scripts/fetch-catalog.mjs
# 或
MSR_PROXY=socks5h://127.0.0.1:10808 node scripts/fetch-catalog.mjs
```

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
