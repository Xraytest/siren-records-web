-- 2026-11-10 曲库运行时同步
-- 曲库不再依赖构建期快照：每张专辑一行，同步时按 cid 增量 upsert。
-- payload 就是 /api/catalog 里输出的那张专辑的 JSON 原文，读路径直接拼接，不再二次序列化。
CREATE TABLE IF NOT EXISTS catalog_albums (
  cid TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  songCount INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL
);

-- 版本号、时间戳、官方顺序、同步租约（单飞锁）
CREATE TABLE IF NOT EXISTS catalog_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 滚动复查按 updatedAt 取最久没复查的专辑
CREATE INDEX IF NOT EXISTS catalog_albums_updated ON catalog_albums (updatedAt);
