#!/usr/bin/env bash
# =============================================================================
# SIREN RECORDS · 云端数据库（Cloudflare D1）定期备份
#
# 运行位置：NetCenter（树莓派 pi，aarch64）/ 任意有 curl + sha256sum + python3 的 Linux
# 触发方式：systemd user timer（siren-d1-backup.timer），也可手动执行。
#
# 安全要点：
#   * 令牌只存在 600 权限的 backup.env 与 600 的临时 curl 配置文件里，
#     不出现在命令行参数（避免 ps 泄露）、不写日志。
#   * 强制 https，不跟随重定向，超时/重试有限。
#   * 落盘前校验服务端 SHA-256、字节数、结构标记，并用 python3 还原进内存 SQLite
#     做 integrity_check / foreign_key_check，校验不过就不轮转旧备份。
#
# 目录约定（默认 $HOME/siren-backup）：
#   backup.env              600  配置（URL + 令牌）
#   dumps/                  700  siren-d1-YYYYmmddTHHMMSSZ.sql.zst(+.sha256)
#   state/                  700  last-success.json / last-error.txt / backup.lock
# =============================================================================
set -euo pipefail
umask 077

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SIREN_BACKUP_CONFIG:-$ROOT_DIR/backup.env}"
STATE_DIR="$ROOT_DIR/state"
LOCK_FILE="$STATE_DIR/backup.lock"

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

die() {
  log "ERROR: $*"
  mkdir -p "$STATE_DIR"
  # 只留最近 50 条：无限追加会和「日志交给 journal 轮转」的约定相矛盾
  {
    printf '%s %s\n' "$(date -Is)" "$*"
    tail -n 49 "$STATE_DIR/last-error.txt" 2>/dev/null || true
  } >"$STATE_DIR/last-error.txt.tmp"
  mv -f "$STATE_DIR/last-error.txt.tmp" "$STATE_DIR/last-error.txt"
  exit 1
}

# ---------- 依赖与配置 ----------
for bin in curl sha256sum python3 stat awk grep sed; do
  command -v "$bin" >/dev/null 2>&1 || die "缺少依赖：$bin"
done
if ! command -v zstd >/dev/null 2>&1 && ! command -v gzip >/dev/null 2>&1; then
  die "缺少压缩工具：zstd 或 gzip"
fi

[[ -r "$CONFIG_FILE" ]] || die "缺少配置文件 $CONFIG_FILE（参考 backup.env.example）"

config_perm=$(stat -c '%a' "$CONFIG_FILE")
case "$config_perm" in
  600|400) ;;
  *) die "配置文件权限必须为 600（当前 $config_perm）：chmod 600 $CONFIG_FILE" ;;
esac

# 不要用 `set -a`：那会把 URL/令牌导出到每个子进程的环境里（ps eww / /proc/<pid>/environ 可读），
# 而子进程（curl/python3/zstd/gpg）根本不需要它们。
# shellcheck disable=SC1090
. "$CONFIG_FILE"

: "${SIREN_BACKUP_URL:?backup.env 缺少 SIREN_BACKUP_URL}"
: "${SIREN_BACKUP_TOKEN:?backup.env 缺少 SIREN_BACKUP_TOKEN}"

# 默认值必须在 source 之后取：这些变量原来写在文件顶部，
# 于是 backup.env 里的 SIREN_BACKUP_KEEP_* / DIR 会被静默忽略（例如 KEEP_DAILY=365 仍按 30 轮转）。
KEEP_DAILY="${SIREN_BACKUP_KEEP_DAILY:-30}"
KEEP_MONTHLY="${SIREN_BACKUP_KEEP_MONTHLY:-12}"
MIN_FREE_MB="${SIREN_BACKUP_MIN_FREE_MB:-1024}"
# 备份出来的用户数低于这个下限就当作失败（防止拉到空库/错库却当成好备份轮转掉旧的）
MIN_USERS="${SIREN_BACKUP_MIN_USERS:-1}"
DUMP_DIR="${SIREN_BACKUP_DIR:-$ROOT_DIR/dumps}"

[[ "$SIREN_BACKUP_URL" == https://* ]] || die "备份地址必须是 https"
(( ${#SIREN_BACKUP_TOKEN} >= 32 )) || die "备份令牌长度不足 32 字符"
[[ "$SIREN_BACKUP_URL" != *" "* ]] || die "备份地址不能包含空格"
# 这两个值会被写进 curl 配置文件，必须挡住能跳出引号/换行/转义的字符（配置若被篡改也不至于变成命令注入）
[[ "$SIREN_BACKUP_URL" != *'"'* && "$SIREN_BACKUP_URL" != *'\'* && "$SIREN_BACKUP_URL" != *$'\n'* && "$SIREN_BACKUP_URL" != *$'\r'* ]] \
  || die "备份地址包含非法字符（引号/反斜杠/换行）"
[[ "$SIREN_BACKUP_TOKEN" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || die "备份令牌只能包含 A-Z a-z 0-9 . _ ~ + / = -"

# 只能是非负十进制整数，且不接受前导零：`08` 在 (( )) 里是八进制，会直接算错（历史缺陷：KEEP_MONTHLY=08 删掉全部月度归档）
num_ok() { [[ "$1" =~ ^(0|[1-9][0-9]*)$ ]]; }
num_ok "$KEEP_DAILY" && (( KEEP_DAILY >= 1 )) || die "SIREN_BACKUP_KEEP_DAILY 必须是 >=1 的整数（不要前导零，当前 '$KEEP_DAILY'）"
num_ok "$KEEP_MONTHLY" || die "SIREN_BACKUP_KEEP_MONTHLY 必须是非负整数（不要前导零，当前 '$KEEP_MONTHLY'）"
num_ok "$MIN_FREE_MB" || die "SIREN_BACKUP_MIN_FREE_MB 必须是非负整数（不要前导零）"
num_ok "$MIN_USERS" || die "SIREN_BACKUP_MIN_USERS 必须是非负整数（不要前导零）"

install -d -m 700 "$DUMP_DIR" "$STATE_DIR"

# 磁盘余量：宁可这次不备份，也不要写坏文件系统
free_mb=$(df -Pm "$DUMP_DIR" | awk 'NR==2 {print $4}')
[[ "$free_mb" =~ ^[0-9]+$ ]] || die "无法读取磁盘余量"
(( free_mb >= MIN_FREE_MB )) || die "磁盘可用空间不足（${free_mb}MB < ${MIN_FREE_MB}MB）"

# 同一时间只允许一个实例（缺 flock 就直接失败，而不是静默无锁地并发跑）
command -v flock >/dev/null 2>&1 || die "缺少 flock（并发保护必需）：请安装 util-linux"
exec 9>"$LOCK_FILE"
flock -n 9 || die "已有备份任务正在运行"

# 临时文件放在备份目录同一文件系统：/tmp 在 systemd 下往往是 tmpfs（计入 MemoryMax），
# 备份文件长大后会在压缩阶段 OOM/ENOSPC，而且 df 守卫查的是 home 而不是它。
mkdir -p "$ROOT_DIR/tmp"
chmod 700 "$ROOT_DIR/tmp"
TMP_DIR=$(mktemp -d "$ROOT_DIR/tmp/run.XXXXXX")
# 本次可能生成的产物（用于失败时清理半成品）
OUT_PART=""
cleanup() {
  rm -rf -- "$TMP_DIR"
  # 半成品压缩包绝不能被轮转当成有效备份（? 只有真的写出了 .part 才清）
  if [[ -n "$OUT_PART" && -e "$OUT_PART" ]]; then rm -f -- "$OUT_PART"; fi
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

# ---------- 拉取 ----------
# 日志只记 scheme+host+path：完整 URL 一旦带上查询串/用户信息就会进 journal
log "拉取云端备份：$(printf '%s' "$SIREN_BACKUP_URL" | sed -E 's#^(https://[^/]+).*#\1#')"

CURL_CONF="$TMP_DIR/curl.conf"
{
  printf 'url = "%s"\n' "$SIREN_BACKUP_URL"
  printf 'header = "Authorization: Bearer %s"\n' "$SIREN_BACKUP_TOKEN"
  printf 'header = "Accept: application/sql"\n'
  printf 'header = "User-Agent: siren-netcenter-backup/1.0"\n'
} >"$CURL_CONF"
chmod 600 "$CURL_CONF"

curl_rc=0
curl --config "$CURL_CONF" \
  --proto '=https' --tlsv1.2 --max-redirs 0 \
  --fail --silent --show-error \
  --connect-timeout 20 --max-time 300 \
  --retry 3 --retry-delay 5 \
  --dump-header "$TMP_DIR/headers" --output "$TMP_DIR/dump.sql" || curl_rc=$?
if (( curl_rc != 0 )); then
  http_code=$(awk 'NR==1 {print $2}' "$TMP_DIR/headers" 2>/dev/null || true)
  body=$(head -c 200 "$TMP_DIR/dump.sql" 2>/dev/null | tr -d '\r\n' || true)
  if [[ "$http_code" == "401" ]]; then
    die "拉取失败：401 未授权（SIREN_BACKUP_TOKEN 可能已轮换，请把新令牌同步到 backup.env）"
  fi
  if [[ "$http_code" == "429" ]]; then
    die "拉取失败：429 触发限速（每小时最多 10 次，等下一小时或检查是否有其它实例在跑）"
  fi
  die "拉取失败（curl 退出码 $curl_rc，HTTP ${http_code:-无响应}）：${body}"
fi

hdr() {
  grep -i "^$1:" "$TMP_DIR/headers" 2>/dev/null | tail -n1 \
    | sed 's/^[^:]*:[[:space:]]*//' | tr -d '\r' || true
}

code=$(awk 'NR==1 {print $2}' "$TMP_DIR/headers")
[[ "$code" == "200" ]] || die "备份接口返回 HTTP ${code:-未知}：$(head -c 200 "$TMP_DIR/dump.sql" 2>/dev/null)"

expect_sha=$(hdr X-Backup-Sha256)
expect_bytes=$(hdr X-Backup-Bytes)
table_counts=$(hdr X-Backup-Tables)
[[ -n "$expect_sha" ]] || die "响应缺少 X-Backup-Sha256（对端版本过旧？）"
[[ -n "$expect_bytes" ]] || die "响应缺少 X-Backup-Bytes"

actual_sha=$(sha256sum "$TMP_DIR/dump.sql" | awk '{print $1}')
[[ "$actual_sha" == "$expect_sha" ]] || die "SHA-256 校验失败：期望 $expect_sha，实际 $actual_sha"

bytes=$(stat -c %s "$TMP_DIR/dump.sql")
[[ "$bytes" == "$expect_bytes" ]] || die "字节数不符：收到 $bytes，声明 $expect_bytes"
(( bytes > 512 )) || die "备份内容过小（$bytes 字节）"

grep -q 'SIREN RECORDS' "$TMP_DIR/dump.sql" || die "备份缺少标识行"
grep -q 'CREATE TABLE IF NOT EXISTS users' "$TMP_DIR/dump.sql" || die "备份缺少 users 建表语句"
grep -q 'CREATE TABLE IF NOT EXISTS playlists' "$TMP_DIR/dump.sql" || die "备份缺少 playlists 建表语句"
tail -n 3 "$TMP_DIR/dump.sql" | grep -q 'END OF DUMP' || die "备份缺少结束标记（可能被截断）"

# ---------- 还原校验（内存 SQLite） ----------
log "还原校验（integrity_check / foreign_key_check）"
# 头部声明的每表行数必须与真实还原出来的行数一致：否则「schema 齐全但数据是另一份/空表」也会通过
if ! restore_json=$(python3 "$ROOT_DIR/restore-check.py" --min-users "$MIN_USERS" \
  --expect-counts "$table_counts" "$TMP_DIR/dump.sql" 2>"$TMP_DIR/restore.err"); then
  die "还原校验失败：$(tr -d '\n' <"$TMP_DIR/restore.err" | head -c 400)"
fi

# ---------- 落盘 ----------
stamp=$(date -u '+%Y%m%dT%H%M%SZ')
base="siren-d1-$stamp"

# 先写 *.part，校验通过后再 mv -n 到正式文件名：
# 这样中途失败（ENOSPC / OOM / 超时被 SIGKILL）留下的半截文件不会被当成有效备份参与轮转。
if [[ -n "${SIREN_BACKUP_GPG_RECIPIENT:-}" ]]; then
  command -v gpg >/dev/null 2>&1 || die "配置了 GPG 收件人但缺少 gpg"
  out="$DUMP_DIR/$base.sql.gpg"
  OUT_PART="$out.part"
  gpg --batch --yes --quiet --trust-model always \
    --encrypt --recipient "$SIREN_BACKUP_GPG_RECIPIENT" \
    --output "$OUT_PART" "$TMP_DIR/dump.sql" || die "GPG 加密失败"
elif command -v zstd >/dev/null 2>&1; then
  out="$DUMP_DIR/$base.sql.zst"
  OUT_PART="$out.part"
  zstd -q --no-progress -10 -T2 -o "$OUT_PART" "$TMP_DIR/dump.sql" || die "zstd 压缩失败"
else
  out="$DUMP_DIR/$base.sql.gz"
  OUT_PART="$out.part"
  gzip -9 -c "$TMP_DIR/dump.sql" >"$OUT_PART" || die "gzip 压缩失败"
fi

[[ -s "$OUT_PART" ]] || die "压缩产物为空：$OUT_PART"
chmod 600 "$OUT_PART"
mv -n -- "$OUT_PART" "$out" || die "无法写入 $out"
OUT_PART=""           # 已转正，cleanup 不要再动它
chmod 600 "$out"
out_sha=$(sha256sum "$out" | awk '{print $1}')
printf '%s  %s\n' "$out_sha" "$(basename "$out")" >"$out.sha256"
chmod 600 "$out.sha256"

# JSON 用 python3 生成：手工拼字符串时，X-Backup-Tables 里只要出现引号/反斜杠就会写坏文件。
# 不用 jq：NetCenter 上实际没有装 jq（只有 python3，restore-check.py 本来就依赖它），
# 缺 jq 时若直接 die，等于每晚备份都失败。
python3 - "$(date -Is)" "$(basename "$out")" "$out_sha" "$table_counts" "$bytes" "$restore_json" \
  >"$STATE_DIR/last-success.json" <<'PY'
import json
import sys

at, name, sha, tables, plain, restore = sys.argv[1:7]
json.dump(
    {
        "at": at,
        "file": name,
        "sha256": sha,
        "plain_bytes": int(plain),
        "tables": tables,
        "restore": json.loads(restore),
    },
    sys.stdout,
    ensure_ascii=False,
)
print()
PY
chmod 600 "$STATE_DIR/last-success.json"
rm -f "$STATE_DIR/last-error.txt"

# ---------- 保留策略 ----------
# 最近 KEEP_DAILY 份全留；更早的每月保留**最新**一份，最多 KEEP_MONTHLY 个月。
# 两个参数在入口处已校验为无前导零的十进制整数，这里再做一次 10# 归一化，避免 08/09 被当八进制。
retention() {
  local daily=$((10#$1)) monthly=$((10#$2))
  local files=() f idx=0 base ymd ym
  local seen=()
  mapfile -t files < <(find "$DUMP_DIR" -maxdepth 1 -type f \
    \( -name 'siren-d1-*.sql.zst' -o -name 'siren-d1-*.sql.gz' -o -name 'siren-d1-*.sql.gpg' \) \
    | sort -r)

  for f in "${files[@]}"; do
    idx=$((idx + 1))
    (( idx <= daily )) && continue
    base=$(basename "$f")
    ymd=${base#siren-d1-}
    ymd=${ymd%%T*}
    ym=${ymd:0:6}
    if [[ " ${seen[*]:-} " == *" $ym "* ]]; then
      rm -f -- "$f" "$f.sha256"
      continue
    fi
    if (( ${#seen[@]} < monthly )); then
      seen+=("$ym")
      continue
    fi
    rm -f -- "$f" "$f.sha256"
  done

  # 清掉没有对应备份的孤儿校验文件
  find "$DUMP_DIR" -maxdepth 1 -type f -name '*.sha256' | while read -r s; do
    [[ -f "${s%.sha256}" ]] || rm -f -- "$s"
  done

  # 轮转后至少要留一份：否则配置/逻辑出问题时会把历史全部删光（曾发生过 KEEP_DAILY=0 清空事件）
  local left
  left=$(find "$DUMP_DIR" -maxdepth 1 -type f \
    \( -name 'siren-d1-*.sql.zst' -o -name 'siren-d1-*.sql.gz' -o -name 'siren-d1-*.sql.gpg' \) | wc -l)
  if (( left < 1 )); then
    die "轮转后一个备份都不剩，已中止（检查 KEEP_DAILY/KEEP_MONTHLY 与 dumps 目录权限）"
  fi
}

retention "$KEEP_DAILY" "$KEEP_MONTHLY"

kept=$(find "$DUMP_DIR" -maxdepth 1 -type f \( -name 'siren-d1-*.sql.zst' -o -name 'siren-d1-*.sql.gz' -o -name 'siren-d1-*.sql.gpg' \) | wc -l)
log "完成：$(basename "$out")（明文 $bytes 字节，压缩后 $out_sha）"
log "表行数：${table_counts:-未知} · 当前保留 $kept 份 · 校验：$(printf '%s' "$restore_json" | head -c 200)"
