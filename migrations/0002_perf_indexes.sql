-- 2026-11 性能、约束与凭据卫生
-- 1) 会话改为只存 sha256(token)：清掉旧格式的明文行，
--    否则旧令牌会继续以明文留在库里、也会被每一份备份导出。
--    代价：部署后所有旧会话失效，用户需要重新登录一次（一次性，已在 SECURITY.md 说明）。
DELETE FROM sessions;
-- 2) 会话清扫按 expiresAt 过滤、按用户批量吊销都要走索引；否则每次都是全表扫描
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expiresAt);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(userId);
-- 3) 发布码去重（NOT EXISTS ... publishCode = ?）需要索引；
--    唯一性由发布接口的单语句条件更新保证，这里只建普通索引
CREATE INDEX IF NOT EXISTS playlists_publish_code ON playlists(publishCode);
