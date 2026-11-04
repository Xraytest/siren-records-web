#!/usr/bin/env bash
# 在 NetCenter 上安装备份程序（用户级 systemd，已开启 linger）
# 用法：bash install.sh
#
# 可用环境变量：SIREN_BACKUP_HOME=/自定义目录（unit 里的路径会按它渲染）
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEST="${SIREN_BACKUP_HOME:-$HOME/siren-backup}"
UNIT_DIR="$HOME/.config/systemd/user"
SERVICE="$UNIT_DIR/siren-d1-backup.service"

echo "==> 目标目录 $DEST"
install -d -m 700 "$DEST" "$DEST/dumps" "$DEST/state" "$DEST/gnupg" "$UNIT_DIR"

install -m 700 "$ROOT_DIR/backup-d1.sh" "$DEST/backup-d1.sh"
install -m 700 "$ROOT_DIR/restore-check.py" "$DEST/restore-check.py"

if [[ -f "$DEST/backup.env" ]]; then
  echo "==> 保留已有 $DEST/backup.env"
else
  install -m 600 "$ROOT_DIR/backup.env.example" "$DEST/backup.env"
  echo "==> 已生成 $DEST/backup.env"
fi
chmod 600 "$DEST/backup.env"

# unit 里的 @DEST@ 必须替换成真实路径，否则换目录安装时 Worker 起不来
sed "s#@DEST@#$DEST#g" "$ROOT_DIR/siren-d1-backup.service" >"$SERVICE"
chmod 644 "$SERVICE"
install -m 644 "$ROOT_DIR/siren-d1-backup.timer" "$UNIT_DIR/siren-d1-backup.timer"
grep -q "$DEST/backup-d1.sh" "$SERVICE" || { echo "错误：unit 渲染失败，$SERVICE 未指向 $DEST/backup-d1.sh" >&2; exit 1; }

systemctl --user daemon-reload

# 令牌还没填就别 enable：Persistent=true 的 timer 会立刻触发一次必然失败的运行
token_ready=0
if [[ -r "$DEST/backup.env" ]]; then
  # shellcheck disable=SC1090
  token_ready=$(bash -c 'set -a; . "$1" >/dev/null 2>&1; [[ -n "${SIREN_BACKUP_TOKEN:-}" && ${#SIREN_BACKUP_TOKEN} -ge 32 ]] && echo 1 || echo 0' _ "$DEST/backup.env")
fi

if [[ "$token_ready" == "1" ]]; then
  systemctl --user enable --now siren-d1-backup.timer
  echo "==> 已启用定时器："
  systemctl --user list-timers siren-d1-backup.timer --no-pager || true
else
  echo "==> 令牌尚未填写，暂不启用定时器（避免开机就失败一次）"
fi

echo
echo "下一步："
echo "  1. 编辑 $DEST/backup.env 填入 SIREN_BACKUP_TOKEN（chmod 600）"
echo "  2. 手动跑一次：$DEST/backup-d1.sh"
echo "  3. 启用定时器：systemctl --user enable --now siren-d1-backup.timer"
echo "  4. 看状态：systemctl --user status siren-d1-backup.service --no-pager -l"
echo "     （该机无持久 journal，journalctl --user 查不到内容）"
echo "  5. 抽查恢复：$DEST/restore-check.py 某个 .zst 解压后的 .sql"
