#!/bin/sh
set -eu

# 普通用户运行时尝试用 sudo 自动提权（如 Oracle Cloud 默认 opc/ubuntu 登录）
if [ "$(id -u)" != "0" ]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -n sh "$0" "$@"
  fi
  echo "请使用 root 用户安装 1Shell Probe Agent（或为当前用户配置免密 sudo）" >&2
  exit 1
fi

HOST_ID=""
INSTALL_TOKEN=""
SERVER_URL=""
INTERVAL_SEC="30"
SVC_USER="${SVC_USER:-oneshell}"
INSTALL_DIR="/opt/1shell/probe-agent"
CONFIG_FILE="/etc/1shell-probe-agent.env"
SERVICE_NAME="1shell-probe-agent"
AGENT_BIN="$INSTALL_DIR/probe-agent"
RUNNER="$INSTALL_DIR/probe-agent-run"
DOWNLOAD_TIMEOUT_SEC="60"
REGISTER_TIMEOUT_SEC="15"
CONNECT_TIMEOUT_SEC="5"

usage() {
  echo "Usage: install.sh --host-id <id> --token <token> --server <url> [--interval <sec>]" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host-id) HOST_ID="${2:-}"; shift 2 ;;
    --token|--install-token) INSTALL_TOKEN="${2:-}"; shift 2 ;;
    --server|--server-url) SERVER_URL="${2:-}"; shift 2 ;;
    --interval|--interval-sec) INTERVAL_SEC="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[ -n "$HOST_ID" ] || usage
[ -n "$INSTALL_TOKEN" ] || usage
[ -n "$SERVER_URL" ] || usage
SERVER_URL=${SERVER_URL%/}

case "$(uname -m)" in
  x86_64|amd64) AGENT_ARCH=amd64 ;;
  aarch64|arm64) AGENT_ARCH=arm64 ;;
  *) echo "不支持的 CPU 架构：$(uname -m)" >&2; exit 1 ;;
esac

fetch_to_file() {
  url="$1"
  out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout "$CONNECT_TIMEOUT_SEC" --max-time "$DOWNLOAD_TIMEOUT_SEC" "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -T "$DOWNLOAD_TIMEOUT_SEC" -qO "$out" "$url"
  else
    echo "缺少 curl 或 wget，请先安装其中之一" >&2
    return 1
  fi
}

post_json() {
  url="$1"
  data="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --connect-timeout "$CONNECT_TIMEOUT_SEC" --max-time "$REGISTER_TIMEOUT_SEC" -X POST "$url" -H 'Content-Type: application/json' --data "$data"
  elif command -v wget >/dev/null 2>&1; then
    tmp=$(mktemp)
    printf '%s' "$data" > "$tmp"
    wget -T "$REGISTER_TIMEOUT_SEC" -qO- --header='Content-Type: application/json' --post-file="$tmp" "$url"
    rm -f "$tmp"
  else
    echo "缺少 curl 或 wget，请先安装其中之一" >&2
    return 1
  fi
}

# 创建最小权限运行用户（幂等；兼容 glibc useradd 与 BusyBox/Alpine adduser）
if ! id "$SVC_USER" >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
  elif command -v adduser >/dev/null 2>&1; then
    addgroup -S "$SVC_USER" 2>/dev/null || true
    adduser -S -D -H -s /sbin/nologin -G "$SVC_USER" "$SVC_USER" 2>/dev/null || adduser -S -D -H -s /sbin/nologin "$SVC_USER"
  fi
fi

mkdir -p "$INSTALL_DIR"
TMP_BIN="$INSTALL_DIR/.probe-agent.new"
AGENT_URL="$SERVER_URL/agent-dist/probe-agent-linux-$AGENT_ARCH"
if ! fetch_to_file "$AGENT_URL" "$TMP_BIN"; then
  echo "下载 Agent 二进制失败：$AGENT_URL" >&2
  rm -f "$TMP_BIN"
  exit 1
fi
chmod 755 "$TMP_BIN"
mv -f "$TMP_BIN" "$AGENT_BIN"

AGENT_VERSION_RAW=$($AGENT_BIN -version 2>/dev/null || echo unknown)
REGISTER_BODY=$(printf '{"hostId":"%s","installToken":"%s","agentVersion":"go-%s"}' "$HOST_ID" "$INSTALL_TOKEN" "$AGENT_VERSION_RAW")
REGISTER_RESPONSE=$(post_json "$SERVER_URL/api/agent/probe/register" "$REGISTER_BODY")
AGENT_TOKEN=$(printf '%s' "$REGISTER_RESPONSE" | sed -n 's/.*"agentToken"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
if [ -z "$AGENT_TOKEN" ]; then
  echo "Agent 注册失败：$REGISTER_RESPONSE" >&2
  exit 1
fi

cat > "$CONFIG_FILE" <<CONFIG_EOF
HOST_ID=$HOST_ID
SERVER_URL=$SERVER_URL
AGENT_TOKEN=$AGENT_TOKEN
INTERVAL_SEC=$INTERVAL_SEC
CONFIG_EOF
chmod 600 "$CONFIG_FILE"

cat > "$RUNNER" <<'RUNNER_EOF'
#!/bin/sh
set -eu
set -a
. /etc/1shell-probe-agent.env
set +a
exec /opt/1shell/probe-agent/probe-agent
RUNNER_EOF
chmod 755 "$RUNNER"

# 把运行所需路径移交给非 root 运行用户
chown -R "$SVC_USER":"$SVC_USER" "$INSTALL_DIR" "$CONFIG_FILE"

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  cat > /etc/systemd/system/1shell-probe-agent.service <<SERVICE_EOF
[Unit]
Description=1Shell Probe Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$CONFIG_FILE
ExecStart=$AGENT_BIN
User=$SVC_USER
Group=$SVC_USER
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=read-only
RestrictSUIDSGID=yes
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE_EOF
  systemctl daemon-reload
  systemctl enable 1shell-probe-agent.service >/dev/null
  systemctl restart 1shell-probe-agent.service
elif command -v rc-update >/dev/null 2>&1 && command -v rc-service >/dev/null 2>&1 && [ -d /etc/init.d ]; then
  cat > /etc/init.d/1shell-probe-agent <<OPENRC_EOF
#!/sbin/openrc-run
name="1Shell Probe Agent"
command="/opt/1shell/probe-agent/probe-agent-run"
command_user="$SVC_USER:$SVC_USER"
command_background="yes"
pidfile="/run/1shell-probe-agent.pid"
output_log="/var/log/1shell-probe-agent.log"
error_log="/var/log/1shell-probe-agent.err"

depend() {
  need net
}
OPENRC_EOF
  chmod 755 /etc/init.d/1shell-probe-agent
  # 预创建日志文件并归属运行用户（command_background 后台日志重定向需可写）
  for lf in /var/log/1shell-probe-agent.log /var/log/1shell-probe-agent.err; do
    : > "$lf"
    chown "$SVC_USER":"$SVC_USER" "$lf"
  done
  rc-update add 1shell-probe-agent default >/dev/null
  rc-service 1shell-probe-agent restart
else
  echo "未识别的 init 系统：当前自动安装仅支持 systemd 和 OpenRC。Agent 二进制与配置已写入，可手动运行 $RUNNER" >&2
  exit 1
fi

printf '\n1Shell Probe Agent installed for host %s via %s\n' "$HOST_ID" "$SERVER_URL"
