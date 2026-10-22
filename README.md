# SIREN RECORDS · 塞壬唱片非官方前端

一个为 [monster-siren.hypergryph.com](https://monster-siren.hypergryph.com) 重做的替代前端，保留黑场、细线、等宽标注与青色荧光（`#a0edff`）的美术基调，并补上原站没有的歌单与账号能力。

> 非官方项目。曲库、封面、音频与歌词版权归 塞壬唱片 / 鹰角网络 所有，本项目仅作前端技术演示。

## 功能

- **曲库档案**：298 张专辑、911 首曲目，支持检索、排序、网格 / 列表视图、随机播放。
- **播放器**：队列、随机、循环（列表 / 单曲）、进度与音量、频谱可视化、LRC 歌词逐行同步、Media Session。
- **歌单**：创建、重命名、描述与标签、曲目增删与上下排序、整张专辑一键收录。
- **分享**：歌单完整数据经 LZ-String 压缩后写入链接（`#/share/<code>`），无需服务器即可跨设备传递；也支持复制分享码。
- **发布**：生成只读快照进入「公开广场」，可更新或撤下。
- **导出 / 导入**：单张歌单或全部歌单导出为 JSON（含完整曲目信息），支持文件导入、分享码导入与账号备份恢复。
- **账号系统**：本地注册 / 登录，PBKDF2-SHA256（160,000 轮加盐）保存密码哈希，歌单按账号隔离。

## 技术栈

Vite + React 19 + TypeScript，HashRouter（适配 GitHub Pages 任意子路径），无后端。

账号、歌单与广场索引保存在浏览器 `localStorage`；浏览器清理站点数据会导致丢失，请用「备份全部」导出 JSON。

## 本地运行

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # 输出 dist/
npm run preview
```

## 曲库快照

`public/data/catalog.json` 是构建时抓取的静态快照，前端直接读取，避免线上 API 的跨域限制。

重新抓取（网络需要能访问官方 API，可选代理）：

```bash
node scripts/fetch-catalog.mjs
# 或
MSR_PROXY=socks5h://127.0.0.1:10808 node scripts/fetch-catalog.mjs
```

## 部署

`vite.config.ts` 使用 `base: './'`，`dist/` 可直接放到 GitHub Pages、任意静态服务器或子路径下。

## 声明

本项目与鹰角网络、塞壬唱片无隶属或合作关系，不提供任何音频文件的托管，播放时直接引用官方 CDN 地址。
