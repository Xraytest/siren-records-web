# SIREN RECORDS · 塞壬唱片非官方前端

一个为 [monster-siren.hypergryph.com](https://monster-siren.hypergryph.com) 重做的替代前端，保留黑场、细线、等宽标注与青色荧光（`#a0edff`）的美术基调，并补上原站没有的歌单与账号能力。

> 非官方项目。曲库、封面、音频与歌词版权归 塞壬唱片 / 鹰角网络 所有，本项目仅作前端技术演示。

## 功能

- **曲库档案**：298 张专辑、911 首曲目，支持检索、排序、网格 / 列表视图、随机播放。
- **播放器**：队列、随机、循环（列表 / 单曲）、进度与音量、频谱可视化、LRC 歌词逐行同步、Media Session。
- **歌单**：创建、重命名、描述与标签、曲目增删与上下排序、整张专辑一键收录。
- **分享**：歌单完整数据经 LZ-String 压缩后写入链接（`#/share/<code>`），无需登录即可跨设备传递；也支持复制分享码。
- **发布**：生成只读快照进入「公开广场」，可更新或撤下。
- **导出 / 导入**：单张歌单或全部歌单导出为 JSON（含完整曲目信息），支持文件导入、分享码导入与账号备份恢复。
- **账号系统**：服务端注册 / 登录，密码以 scrypt（随机盐 + 64 字节派生）哈希保存，歌单与广场数据存于 SQLite，换设备登录即可取回。

## 技术栈

前端 Vite + React 19 + TypeScript，HashRouter（适配任意子路径）。

后端为单文件 Node 服务 `server/server.mjs`：内置 `node:http` + `node:sqlite`，无第三方依赖，同时托管 `dist/` 静态文件与 `/api/*` 接口。会话令牌有效期 30 天，存于 `localStorage` 的 `siren:token`。

## 本地运行

```bash
npm install
npm run server       # 后端 http://localhost:8090（含静态托管）
npm run dev          # 前端 http://localhost:5173，/api 自动代理到 8090
npm run build        # 输出 dist/
```

本地数据默认写入项目下的 `data/siren.db`（已 gitignore），可用 `DATA_DIR` 环境变量改路径。

## 曲库快照

`public/data/catalog.json` 是构建时抓取的静态快照，前端直接读取，避免线上 API 的跨域限制。

重新抓取（网络需要能访问官方 API，可选代理）：

```bash
node scripts/fetch-catalog.mjs
# 或
MSR_PROXY=socks5h://127.0.0.1:10808 node scripts/fetch-catalog.mjs
```

## 部署

`vite.config.ts` 使用 `base: './'`，`dist/` 可放在任意静态服务器或子路径下；但由于账号与歌单依赖 `/api`，需与 `server/server.mjs` 同域部署（或反向代理 `/api`）。

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
