'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_INSTALL_TIMEOUT_MS = 180000;
const INSTALL_DIR = '/opt/1shell/probe-relay';
const CONFIG_FILE = '/etc/1shell-probe-relay.env';
const SERVICE_FILE = '/etc/systemd/system/1shell-probe-relay.service';
const STATE_FILE = '/var/lib/1shell-probe-relay/state.json';

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "'\\''")}'`;
}

function createToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function normalizeRelayPort(value) {
  return Math.max(1, Math.min(parseInt(value, 10) || 3302, 65535));
}

function createProbeRelayInstallerService({ rootDir, hostService, bridgeService, probeRelayService }) {
  function ensureRemoteLinuxTarget(hostId) {
    const host = hostService?.findHost(hostId);
    if (!host) {
      const error = new Error('主机不存在');
      error.status = 404;
      throw error;
    }
    if (host.type === 'local') {
      const error = new Error('Relay Agent 仅支持安装到远端 Linux VPS');
      error.status = 400;
      throw error;
    }
    return host;
  }

  async function detectArch(hostId, clientIp) {
    const result = await bridgeService.execOnHost(hostId, `#!/bin/sh
set -eu
UNAME_M=$(uname -m)
case "$UNAME_M" in
  x86_64|amd64) printf 'amd64\\n' ;;
  aarch64|arm64) printf 'arm64\\n' ;;
  *) echo "不支持的 CPU 架构：$UNAME_M" >&2; exit 1 ;;
esac
`, 30000, {
      source: 'probe_relay_arch_detect',
      clientIp,
      auditCommand: 'Detect 1Shell Probe Relay Agent architecture',
    });
    if (result.exitCode !== 0) {
      const error = new Error(result.stderr || result.stdout || 'Relay Agent 架构探测失败');
      error.status = 400;
      throw error;
    }
    return String(result.stdout || '').trim();
  }

  function requireLocalFile(filePath, label) {
    if (!fs.existsSync(filePath)) {
      const error = new Error(`缺少 ${label}：${path.relative(rootDir, filePath)}，请先运行 npm run build:agent`);
      error.status = 500;
      throw error;
    }
    return filePath;
  }

  function resolveRelayBinaryPath(arch) {
    return requireLocalFile(path.join(rootDir, 'agent', 'dist', `probe-relay-agent-linux-${arch}`), 'Relay Agent 二进制');
  }

  function resolveProbeBinaryPath(arch) {
    return requireLocalFile(path.join(rootDir, 'agent', 'dist', `probe-agent-linux-${arch}`), 'Probe Agent 二进制');
  }

  function resolveInstallScriptPath() {
    return requireLocalFile(path.join(rootDir, 'agent', 'install.sh'), 'Agent 安装脚本');
  }

  async function uploadBinary(hostId, localPath, remotePath) {
    const { client, proxyClient } = await hostService.connectToHost(hostId, { readyTimeout: 30000 });
    try {
      const sftp = await new Promise((resolve, reject) => {
        client.sftp((err, s) => (err ? reject(new Error(`SFTP 会话创建失败: ${err.message}`)) : resolve(s)));
      });
      await new Promise((resolve, reject) => {
        const reader = fs.createReadStream(localPath);
        const writer = sftp.createWriteStream(remotePath, { mode: 0o755 });
        reader.on('error', reject);
        writer.on('error', reject);
        writer.on('close', resolve);
        reader.pipe(writer);
      });
      try { sftp.end(); } catch { /* ignore */ }
    } finally {
      try { client.end(); } catch { /* ignore */ }
      try { proxyClient?.end(); } catch { /* ignore */ }
    }
  }

  function buildFinalizeScript({ tmpBinary, tmpInstallScript, tmpProbeAmd64, tmpProbeArm64, syncToken, relayPort }) {
    return `#!/bin/sh
set -eu
if [ "$(id -u)" = "0" ]; then
  SUDO=""
elif command -v sudo >/dev/null 2>&1; then
  SUDO="sudo -n"
else
  echo "请使用 root 用户安装 1Shell Probe Relay Agent（或为当前用户配置免密 sudo）" >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "当前系统不支持 systemd，暂不支持一键安装 Relay Agent" >&2
  exit 1
fi
SVC_USER=oneshell
if ! id "$SVC_USER" >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then
    $SUDO useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
  elif command -v adduser >/dev/null 2>&1; then
    $SUDO addgroup --system "$SVC_USER" 2>/dev/null || true
    $SUDO adduser --system --no-create-home --shell /usr/sbin/nologin --ingroup "$SVC_USER" "$SVC_USER" 2>/dev/null || true
  fi
fi
$SUDO mkdir -p ${shellQuote(INSTALL_DIR)} /var/lib/1shell-probe-relay
$SUDO chmod 700 /var/lib/1shell-probe-relay
$SUDO mv -f ${shellQuote(tmpBinary)} ${shellQuote(`${INSTALL_DIR}/probe-relay-agent`)}
$SUDO mv -f ${shellQuote(tmpInstallScript)} ${shellQuote(`${INSTALL_DIR}/install.sh`)}
$SUDO mv -f ${shellQuote(tmpProbeAmd64)} ${shellQuote(`${INSTALL_DIR}/probe-agent-linux-amd64`)}
$SUDO mv -f ${shellQuote(tmpProbeArm64)} ${shellQuote(`${INSTALL_DIR}/probe-agent-linux-arm64`)}
$SUDO chmod 755 ${shellQuote(`${INSTALL_DIR}/probe-relay-agent`)} ${shellQuote(`${INSTALL_DIR}/install.sh`)} ${shellQuote(`${INSTALL_DIR}/probe-agent-linux-amd64`)} ${shellQuote(`${INSTALL_DIR}/probe-agent-linux-arm64`)}
$SUDO tee ${shellQuote(CONFIG_FILE)} >/dev/null <<CONFIG_EOF
LISTEN_ADDR=0.0.0.0:${relayPort}
SYNC_TOKEN=${syncToken}
STATE_FILE=${STATE_FILE}
AGENT_DIST_DIR=${INSTALL_DIR}
CONFIG_EOF
$SUDO chmod 600 ${shellQuote(CONFIG_FILE)}
$SUDO chown -R "$SVC_USER":"$SVC_USER" ${shellQuote(INSTALL_DIR)} /var/lib/1shell-probe-relay ${shellQuote(CONFIG_FILE)}
$SUDO tee ${shellQuote(SERVICE_FILE)} >/dev/null <<SERVICE_EOF
[Unit]
Description=1Shell Probe Relay Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${CONFIG_FILE}
ExecStart=${INSTALL_DIR}/probe-relay-agent
User=oneshell
Group=oneshell
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/1shell-probe-relay
ProtectHome=yes
RestrictSUIDSGID=yes
ProtectControlGroups=yes
ProtectKernelModules=yes
ProtectKernelTunables=yes
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE_EOF
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now 1shell-probe-relay.service
$SUDO systemctl restart 1shell-probe-relay.service
$SUDO systemctl status 1shell-probe-relay.service --no-pager --lines=8 || true
printf '\\n1Shell Probe Relay Agent installed on port %s\\n' ${shellQuote(String(relayPort))}
`;
  }

  async function installUpstream({ id, relayHostId, relayPort, name, enabled = true, clientIp } = {}) {
    const host = ensureRemoteLinuxTarget(relayHostId);
    const port = normalizeRelayPort(relayPort);
    const syncToken = createToken();
    const arch = await detectArch(relayHostId, clientIp);
    const relayBinaryPath = resolveRelayBinaryPath(arch);
    const installScriptPath = resolveInstallScriptPath();
    const probeAmd64Path = resolveProbeBinaryPath('amd64');
    const probeArm64Path = resolveProbeBinaryPath('arm64');
    const stamp = Date.now();
    const tmpBinary = `/tmp/1shell-probe-relay-agent-${stamp}`;
    const tmpInstallScript = `/tmp/1shell-probe-install-${stamp}.sh`;
    const tmpProbeAmd64 = `/tmp/1shell-probe-agent-linux-amd64-${stamp}`;
    const tmpProbeArm64 = `/tmp/1shell-probe-agent-linux-arm64-${stamp}`;

    await uploadBinary(relayHostId, relayBinaryPath, tmpBinary);
    await uploadBinary(relayHostId, installScriptPath, tmpInstallScript);
    await uploadBinary(relayHostId, probeAmd64Path, tmpProbeAmd64);
    await uploadBinary(relayHostId, probeArm64Path, tmpProbeArm64);
    const result = await bridgeService.execOnHost(relayHostId, buildFinalizeScript({ tmpBinary, tmpInstallScript, tmpProbeAmd64, tmpProbeArm64, syncToken, relayPort: port }), DEFAULT_INSTALL_TIMEOUT_MS, {
      source: 'probe_relay_install',
      clientIp,
      auditCommand: 'Install 1Shell Probe Relay Agent (token redacted)',
    });

    if (result.exitCode !== 0) {
      return { upstream: null, result, relayHostId, relayPort: String(port) };
    }

    const upstream = probeRelayService.upsertUpstream({
      id,
      name: name || host.name || 'Probe Relay',
      relayHostId,
      relayPort: port,
      syncToken,
      enabled,
    });

    return { upstream, result, relayHostId, relayPort: String(port) };
  }

  function requireManagedUpstream(id) {
    const upstream = probeRelayService.getUpstream?.(id, { includeToken: true });
    if (!upstream) {
      const error = new Error('Relay 上游不存在');
      error.status = 404;
      throw error;
    }
    if (!upstream.relayHostId) {
      const error = new Error('手动 Relay 上游没有绑定 VPS，无法执行远端操作');
      error.status = 400;
      throw error;
    }
    ensureRemoteLinuxTarget(upstream.relayHostId);
    return upstream;
  }

  function buildUninstallScript({ purgeState = false } = {}) {
    return `#!/bin/sh
set -eu
if [ "$(id -u)" != "0" ]; then
  echo "请使用 root 用户卸载 1Shell Probe Relay Agent" >&2
  exit 1
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now 1shell-probe-relay.service >/dev/null 2>&1 || true
  rm -f ${shellQuote(SERVICE_FILE)}
  systemctl daemon-reload >/dev/null 2>&1 || true
fi
rm -rf ${shellQuote(INSTALL_DIR)}
rm -f ${shellQuote(CONFIG_FILE)}
${purgeState ? 'rm -rf /var/lib/1shell-probe-relay' : 'mkdir -p /var/lib/1shell-probe-relay && chmod 700 /var/lib/1shell-probe-relay'}
printf '1Shell Probe Relay Agent uninstalled%s\n' ${shellQuote(purgeState ? ' and state purged' : '')}
`;
  }

  function buildMigrateAgentScript(serverUrl) {
    const cleanServerUrl = String(serverUrl || '').replace(/\/+$/, '');
    return `#!/bin/sh
set -eu
CONFIG_FILE="/etc/1shell-probe-agent.env"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "SKIPPED: 未安装 1Shell Probe Agent"
  exit 0
fi
if [ "$(id -u)" != "0" ]; then
  echo "请使用 root 用户迁移 1Shell Probe Agent" >&2
  exit 1
fi
set -a
. "$CONFIG_FILE"
set +a
OLD_SERVER_URL="\${SERVER_URL:-}"
NEW_SERVER_URL=${shellQuote(cleanServerUrl)}
if [ -z "\${HOST_ID:-}" ] || [ -z "\${AGENT_TOKEN:-}" ]; then
  echo "Agent 配置缺少 HOST_ID 或 AGENT_TOKEN" >&2
  exit 1
fi
if [ "\${OLD_SERVER_URL%/}" = "$NEW_SERVER_URL" ]; then
  echo "UNCHANGED: SERVER_URL 已经是 $NEW_SERVER_URL"
else
  TMP_FILE="$CONFIG_FILE.tmp.$$"
  cat > "$TMP_FILE" <<CONFIG_EOF
HOST_ID=$HOST_ID
SERVER_URL=$NEW_SERVER_URL
AGENT_TOKEN=$AGENT_TOKEN
INTERVAL_SEC=\${INTERVAL_SEC:-30}
CONFIG_EOF
  chmod 600 "$TMP_FILE"
  mv -f "$TMP_FILE" "$CONFIG_FILE"
  echo "SERVER_URL: \${OLD_SERVER_URL:-<empty>} -> $NEW_SERVER_URL"
fi
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl restart 1shell-probe-agent.service
  systemctl is-active 1shell-probe-agent.service >/dev/null
elif command -v rc-service >/dev/null 2>&1; then
  rc-service 1shell-probe-agent restart >/dev/null
else
  echo "当前系统不支持 systemd/OpenRC 服务管理" >&2
  exit 1
fi
printf '1Shell Probe Agent migrated to %s\n' "$NEW_SERVER_URL"
`;
  }

  async function uninstallUpstream(id, { clientIp, deleteConfig = false, purgeState = false } = {}) {
    const upstream = requireManagedUpstream(id);
    const result = await bridgeService.execOnHost(upstream.relayHostId, buildUninstallScript({ purgeState }), DEFAULT_INSTALL_TIMEOUT_MS, {
      source: 'probe_relay_uninstall',
      clientIp,
      auditCommand: purgeState ? 'Uninstall 1Shell Probe Relay Agent and purge state' : 'Uninstall 1Shell Probe Relay Agent',
    });
    if (result.exitCode === 0 && deleteConfig) probeRelayService.deleteUpstream(id);
    return { upstream: deleteConfig ? null : upstream, result, deleted: result.exitCode === 0 && Boolean(deleteConfig), purged: Boolean(purgeState) };
  }

  async function migrateAgentsToUpstream(id, { clientIp, hostIds } = {}) {
    const upstream = requireManagedUpstream(id);
    const requestedHostIds = Array.isArray(hostIds) ? new Set(hostIds.filter((hostId) => typeof hostId === 'string' && hostId.trim()).map((hostId) => hostId.trim())) : null;
    const hosts = hostService.listHosts()
      .filter((host) => host.type !== 'local')
      .filter((host) => host.id !== upstream.relayHostId)
      .filter((host) => !requestedHostIds || requestedHostIds.has(host.id));
    const results = [];
    for (const host of hosts) {
      try {
        const result = await bridgeService.execOnHost(host.id, buildMigrateAgentScript(upstream.serverUrl), 60000, {
          source: 'probe_agent_relay_migrate',
          clientIp,
          useShellPool: false,
          auditCommand: 'Migrate 1Shell Probe Agent Relay server URL',
        });
        results.push({ hostId: host.id, name: host.name, result });
      } catch (error) {
        results.push({
          hostId: host.id,
          name: host.name,
          result: { stdout: '', stderr: error.message, exitCode: 1, durationMs: 0 },
        });
      }
    }
    const changed = results.filter((item) => item.result.exitCode === 0 && /SERVER_URL:/.test(item.result.stdout || '')).length;
    const skipped = results.filter((item) => item.result.exitCode === 0 && /SKIPPED:/.test(item.result.stdout || '')).length;
    const failed = results.filter((item) => item.result.exitCode !== 0).length;
    if (failed === 0) probeRelayService.syncUpstreamById(id).catch(() => {});
    return { upstream, total: results.length, changed, skipped, failed, results };
  }

  return { installUpstream, migrateAgentsToUpstream, uninstallUpstream };
}

module.exports = {
  createProbeRelayInstallerService,
};
