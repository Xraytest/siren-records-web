#!/usr/bin/env bash
# 在 NetCenter 上安装备份程序（用户级 systemd，已开启 linger）
# 用法：bash install.sh
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEST="${SIREN_BACKUP_HOME:-$HOME/siren-backup}"
UNIT_DIR="$HOME/.config/systemd/user"

echo "==> 目标目录 $DEST"
install -d -m 700 "$DEST" "$DEST/dumps" "$DEST/state" "$UNIT_DIR"

install -m 700 "$ROOT_DIR/backup-d1.sh" "$DEST/backup-d1.sh"
install -m 700 "$ROOT_DIR/restore-check.py" "$DEST/restore-check.py"

if [[ -f "$DEST/backup.env" ]]; then
  echo "==> 保留已有 $DEST/backup.env"
else
  install -m 600 "$ROOT_DIR/backup.env.example" "$DEST/backup.env"
  echo "==> 已生成 $DEST/backup.env，请填入令牌后重新执行：bash $DEST/backup-d1.sh"
fi
chmod 600 "$DEST/backup.env"

install -m 644 "$ROOT_DIR/siren-d1-backup.service" "$UNIT_DIR/siren-d1-backup.service"
install -m 644 "$ROOT_DIR/siren-d1-backup.timer" "$UNIT_DIR/siren-d1-backup.timer"

systemctl --user daemon-reload
systemctl --user enable --now siren-d1-backup.timer

echo "==> 已安装定时器："
systemctl --user list-timers siren-d1-backup.timer --no-pager || true

echo
echo "下一步："
echo "  1. 编辑 $DEST/backup.env 填入 SIREN_BACKUP_TOKEN（chmod 600）"
echo "  2. 手动跑一次：$DEST/backup-d1.sh"
echo "  3. 看状态：systemctl --user status siren-d1-backup.service --no-pager -l"
echo "     （该机无持久 journal，journalctl --user 查不到内容）"
echo "  4. 抽查恢复：$DEST/restore-check.py 某个 .zst 解压后的 .sql"
