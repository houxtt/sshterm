// sshterm 服务端: HTTP 静态 + WebSocket 路由 + 连接管理 + 会话持久化
// 启动: node server/index.js [--port 8787] [--no-open]
// Modules: security / logging / sessions-store / ssh-config-loader / sftp-http /
//          vnc-bridge / net-scan / ws-handlers (behavior preserved).
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID, randomBytes, createHash } = require('crypto');
const { WebSocketServer } = require('ws');
const { decodeBuffer, StreamingDecoder } = require('./encoding');
const { sendBinary, WS_HIGH_WATER, attachWsBackpressure, queueDepth, isBackedUp } = require('./ws-backpressure');
const sshConnectScheduler = require('./ssh-connect-scheduler');
const { createSecurity } = require('./security');
const { createLogging } = require('./logging');
const { createSessionsStore } = require('./sessions-store');
const { loadSSHConfig } = require('./ssh-config-loader');
const { handleSftpHttp, statMtimeHeader, remoteFileIdentity } = require('./sftp-http');
const {
  attachVncBridge,
  resumePausedConnections: resumePausedConnectionsImpl,
  validVncHost,
} = require('./vnc-bridge');
const { createWsMessageHandler } = require('./ws-handlers');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
function newestSourceMtimeMs(dir) {
  let latest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) latest = Math.max(latest, newestSourceMtimeMs(file));
    else if (entry.isFile() && entry.name.endsWith('.js')) latest = Math.max(latest, fs.statSync(file).mtimeMs);
  }
  return latest;
}
const SERVER_BUILD_ID = String(Math.trunc(Math.max(
  newestSourceMtimeMs(__dirname),
  fs.statSync(path.join(ROOT, 'package.json')).mtimeMs,
)));
const SERVER_STARTED_AT = new Date().toISOString();
const CONN_DIR = path.join(os.homedir(), '.sshterm');
const CONN_FILE = path.join(CONN_DIR, 'sessions.json');
const CONN_BACKUP_FILE = `${CONN_FILE}.bak`;
const connections = new Map();
const windows = new Map();
const windowCleanupTimers = new Map();
const AUTO_EXIT_GRACE_MS = 12 * 1000;
const DETACHED_CONNECTION_GRACE_MS = (() => {
  const value = Number(process.env.SSHTERM_DETACHED_GRACE_MS || 0);
  return Number.isFinite(value) && value > 0
    ? Math.min(value, 7 * 24 * 60 * 60 * 1000)
    : 0;
})();
const CONNECTION_REPLAY_BUFFER_BYTES = 256 * 1024;
function connectionKey(ws, id) { return `${ws.windowId}:${id}`; }
function getConnection(ws, id) { return connections.get(connectionKey(ws, id)); }
function getHttpConnection(qs) {
  const ws = windows.get(String(qs.get('window') || ''));
  if (ws) return getConnection(ws, parseInt(qs.get('conn'), 10));
  return process.env.SSHTERM_TEST_SFTP_ROOT ? connections.get(parseInt(qs.get('conn'), 10)) : null;
}

function requestedWindowId(req) {
  try {
    const id = new URL(req.url, 'http://127.0.0.1').searchParams.get('window') || '';
    return /^[A-Za-z0-9_-]{32,128}$/.test(id) ? id : '';
  } catch { return ''; }
}

function cancelWindowCleanup(windowId) {
  const timer = windowCleanupTimers.get(windowId);
  if (timer) clearTimeout(timer);
  windowCleanupTimers.delete(windowId);
}

function closeWindowConnections(windowId) {
  cancelWindowCleanup(windowId);
  for (const [key, conn] of connections) {
    if (!key.startsWith(`${windowId}:`)) continue;
    connections.delete(key);
    try { conn.close(); } catch {}
  }
}

function scheduleWindowCleanup(windowId) {
  cancelWindowCleanup(windowId);
  if (!DETACHED_CONNECTION_GRACE_MS) return;
  const timer = setTimeout(() => {
    windowCleanupTimers.delete(windowId);
    if (!windows.has(windowId)) closeWindowConnections(windowId);
  }, DETACHED_CONNECTION_GRACE_MS);
  timer.unref();
  windowCleanupTimers.set(windowId, timer);
}
const liveByConfig = new Map();
if (process.env.SSHTERM_TEST_SFTP_ROOT) {
  const { installLocalSftpFixture } = require('./test-sftp-fixture');
  installLocalSftpFixture(connections, process.env.SSHTERM_TEST_SFTP_ROOT);
}
const MAX_CONCURRENT_UPLOADS = 3;
const uploadState = { n: 0 };
const activeUploadKeys = new Set();
const directoryDownloads = new Map();
const directoryDownloadCleanup = setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, job] of directoryDownloads) {
    if (job.updatedAt < cutoff) directoryDownloads.delete(id);
  }
}, 60 * 1000);
directoryDownloadCleanup.unref();

const CLIENT_TOKEN = randomBytes(32).toString('base64url');
const PORT = parseInt(process.argv[process.argv.indexOf('--port') + 1], 10) || 8787;
const TOKEN_FILE = path.join(CONN_DIR, 'token');

const {
  STATIC_CSP,
  hasClientToken,
  hasCliCapability,
  isTrustedOrigin,
  isTrustedRequest,
  isInside,
} = createSecurity({ port: PORT, clientToken: CLIENT_TOKEN });

const logging = createLogging(CONN_DIR);
const { logs, LOG_DIR, SESSION_LOG_DIR, log, redactLog, cleanupLogDirectory, cleanupOldLogs } = logging;
// Prefer the logging module's LOG_FILE; expose a live getter for handlers/banner.
const LOG_FILE_REF = logging;
function getLogFile() { return LOG_FILE_REF.LOG_FILE; }

const sessionStore = createSessionsStore({ CONN_DIR, CONN_FILE, CONN_BACKUP_FILE, log });
const {
  writeSessionFile,
  loadSessions,
  saveSessions,
  storedSessionForConfig,
  mergeStoredCredentials,
  sanitize,
  sessionSortOrder,
  sessionsList,
  nextSessionSortOrder,
  importSessionEntries,
} = sessionStore;
function getSessions() { return sessionStore.sessions; }
function setSessions(v) { sessionStore.sessions = v; }

let sshConfig = loadSSHConfig();

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let url;
  try {
    url = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('bad request: invalid percent-encoding');
  }

  if (req.method === 'GET' && url === '/launcher-info') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      app: 'sshterm',
      buildId: SERVER_BUILD_ID,
      pid: process.pid,
      startedAt: SERVER_STARTED_AT,
    }));
  }

  if (url === '/bootstrap.js') {
    if (!isTrustedRequest(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('forbidden: untrusted origin');
    }
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    return res.end(`window.__SSHTERM_TOKEN=${JSON.stringify(CLIENT_TOKEN)};`);
  }
  if (url.startsWith('/api/') && (!hasClientToken(req) || !isTrustedRequest(req))) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }

  if (handleSftpHttp(req, res, {
    url,
    getHttpConnection,
    activeUploadKeys,
    directoryDownloads,
    MAX_CONCURRENT_UPLOADS,
    uploadState,
  })) return;

  if (url === '/') url = '/index.html';
  let file;
  if (url.startsWith('/vendor/')) {
    file = path.join(ROOT, 'node_modules', url.slice('/vendor/'.length));
  } else {
    file = path.join(WEB, url);
  }
  const allowedRoot = url.startsWith('/vendor/')
    ? path.join(ROOT, 'node_modules')
    : WEB;
  if (!isInside(allowedRoot, file)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
                         'Cache-Control': 'no-cache',
                         'X-Content-Type-Options': 'nosniff',
                         'Content-Security-Policy': STATIC_CSP });
    res.end(data);
  });
});

const AUTO_EXIT = process.argv.includes('--auto-exit');
let wsCount = 0;
let idleExitTimer = null;
function scheduleIdleExit() {
  if (!AUTO_EXIT) return;
  clearTimeout(idleExitTimer);
  if (wsCount <= 0) {
    idleExitTimer = setTimeout(() => {
      console.log('[auto-exit] 无客户端连接, 服务自动退出');
      for (const c of connections.values()) c.close();
      process.exit(0);
    }, AUTO_EXIT_GRACE_MS);
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
const vncWss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

function rejectUpgrade(socket, status = '403 Forbidden') {
  try { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); } catch { try { socket.destroy(); } catch {} }
}

server.on('upgrade', (req, socket, head) => {
  if (!hasClientToken(req) || !isTrustedRequest(req)) return rejectUpgrade(socket);
  let pathname;
  try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch { return rejectUpgrade(socket, '400 Bad Request'); }
  const target = pathname === '/vnc' ? vncWss : (pathname === '/' ? wss : null);
  if (!target) return rejectUpgrade(socket, '404 Not Found');
  target.handleUpgrade(req, socket, head, upgraded => target.emit('connection', upgraded, req));
});

function resumePausedConnections(ws) {
  resumePausedConnectionsImpl(ws, connections);
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(obj) {
  for (const c of wss.clients) send(c, obj);
}
function bufferConnectionHistory(conn, data) {
  if (!conn._replayBuffer) conn._replayBuffer = [];
  const chunk = Buffer.from(data);
  conn._replayBuffer.push(chunk);
  conn._replayBufferBytes = (conn._replayBufferBytes || 0) + chunk.length;
  while (conn._replayBufferBytes > CONNECTION_REPLAY_BUFFER_BYTES && conn._replayBuffer.length) {
    conn._replayBufferBytes -= conn._replayBuffer.shift().length;
  }
}

function sendConnectionData(conn, id, data) {
  bufferConnectionHistory(conn, data);
  const ownerWs = conn.ownerWs;
  if (!ownerWs || ownerWs.readyState !== 1) return;
  if (isBackedUp(ownerWs) && conn.stream && typeof conn.stream.pause === 'function' && !conn._outputPaused) {
    conn._outputPaused = true;
    try { conn.stream.pause(); } catch {}
  }
  sendBinary(ownerWs, id, data);
}

function attachExistingConnection(ws, conn, id) {
  conn.ownerWs = ws;
  const state = conn.state || 'connected';
  const msg = state === 'connected' ? '已恢复原连接' : (conn._lastStateMsg || '连接中…');
  const historyReplay = !!conn._replayBuffer?.length;
  send(ws, { type: 'status', id, state, msg, resumed: true, historyReplay, cfg: sanitize(conn.config || {}) });
  if (historyReplay) {
    for (const chunk of conn._replayBuffer) sendBinary(ws, id, chunk);
  }
}

async function doConnect(ws, cfg, tabId) {
  // 串口物理独占, 保留去重; SSH/Telnet 允许同 IP 开多个会话
  const fpKey = cfg.type + '|' + (cfg.host || '') + '|' + (cfg.port || '') + '|' + (cfg.baudRate || '');
  const ownerFpKey = `${ws.windowId}|${fpKey}`;
  if (cfg.type === 'serial' && liveByConfig.has(ownerFpKey)) {
    const existingId = liveByConfig.get(ownerFpKey);
    const existing = getConnection(ws, existingId);
    if (existing && existing.state === 'connected' && existing.sp && existing.sp.isOpen) {
      return send(ws, { type: 'reuse', id: tabId, connId: existingId });
    }
    liveByConfig.delete(ownerFpKey);
  }

  const ConnCls = { ssh: require('./connections/ssh'),
                    telnet: require('./connections/telnet'),
                    serial: require('./connections/serial') }[cfg.type];
  if (!ConnCls) return send(ws, { type: 'error', id: tabId, msg: `未知协议: ${cfg.type}` });

  const conn = new ConnCls(cfg);
  const connId = tabId;   // 前端 tab 即连接 id, 简化路由
  conn.id = connId;
  conn.ownerWs = ws;
  conn._replayBuffer = [];
  conn._replayBufferBytes = 0;
  conn._lastStateMsg = '连接中…';
  connections.set(connectionKey(ws, connId), conn);
  liveByConfig.set(ownerFpKey, connId);

  send(ws, { type: 'status', id: tabId, state: 'connecting', msg: '连接中…' });
  log('info', `连接 ${cfg.name || cfg.type}:${cfg.host || cfg.port || cfg.port} (${cfg.type})`);

  // 终端输出自动落盘: ~/.sshterm/session-logs/<会话名>-<时间戳>.log
  // 隐私: 默认关闭，需用户显式在会话配置勾选"记录会话日志"才启用。
  const enc = cfg.encoding || 'utf-8';
  const safeName = (cfg.name || cfg.type).replace(/[\\/:*?"<>|]/g, '_');
  const sts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const sessionLogFile = path.join(SESSION_LOG_DIR, `${safeName}-${sts}.log`);
  let sessionLogStream = null;
  let sessionLogDecoder = null;
  if (cfg.sessionLog === true) {
    try { fs.mkdirSync(SESSION_LOG_DIR, { recursive: true }); } catch (e) {}
    try { sessionLogStream = fs.createWriteStream(sessionLogFile, { flags: 'a' }); }
    catch (e) { console.log('[session-log] 创建失败:', e.message); }
    sessionLogStream?.on('error', (e) => log('error', `[session-log] 写入失败: ${e.message}`));
  }

  conn.on('data', (d) => {
    sendConnectionData(conn, connId, d);
    if (sessionLogStream) {
      try {
        if (!sessionLogDecoder) sessionLogDecoder = new StreamingDecoder(enc);
        const text = sessionLogDecoder.decode(d);
        if (text && !sessionLogStream.write(text)) {
          sessionLogStream.once('drain', () => {});
        }
      } catch (e) { /* 忽略解码失败 */ }
    }
  });
  conn.on('error', (msg, meta) => {
    console.log(`[conn] ${cfg.type} ${tabId} error:`, msg);
    log('error', `[${cfg.name || cfg.type}] ${msg}`);
    conn._lastStateMsg = msg;
    send(conn.ownerWs, { type: 'error', id: connId, msg, occupied: !!(meta && meta.occupied) });
  });
  conn.on('close', (reason) => {
      console.log(`[conn] ${cfg.type} ${tabId} close:`, reason);
      log('info', `[${cfg.name || cfg.type}] 断开: ${reason}`);
      conn._lastStateMsg = reason;
      send(conn.ownerWs, { type: 'status', id: connId, state: 'closed', msg: reason });
      // P1-3 FIX: 关闭会话日志文件句柄，防止 fd 溢出
      if (sessionLogStream) {
        try { sessionLogStream.end(); } catch {}
        sessionLogStream = null;
      }
      const key = connectionKey(ws, connId);
      const ownsSlot = connections.get(key) === conn;
      if (ownsSlot) connections.delete(key);
      if (ownsSlot && liveByConfig.get(ownerFpKey) === connId) liveByConfig.delete(ownerFpKey);
    });
  conn.on('open', () => {
    console.log(`[conn] ${cfg.type} ${tabId} open`);
    log('info', `[${cfg.name || cfg.type}] 已连接`);
    conn._lastStateMsg = '已连接';
    send(conn.ownerWs, { type: 'status', id: connId, state: 'connected', msg: '已连接' });
    if (cfg.type === 'ssh' && Array.isArray(cfg.tunnels)) {
      (async () => { for (const tunnel of cfg.tunnels) { try { await conn.addTunnel(tunnel); } catch (e) { log('error', `隧道恢复失败 ${tunnel.localPort}: ${e.message}`); send(conn.ownerWs, { type: 'tunnel-alert', id: connId, msg: `隧道恢复失败 ${tunnel.localPort}: ${e.message}` }); } } })();
    }
  });
  conn.on('host-key', (info) => {
    send(conn.ownerWs, { type: 'host-key', id: connId, ...info });
  });
  conn.on('interactive-auth', (info) => {
    send(conn.ownerWs, { type: 'interactive-auth', id: connId, ...info });
  });
  conn.on('zmodem-file', (filename, filePath, size) => {
    console.log(`[zmodem] 收到文件 ${filename} (${size}B)`);
    log('info', `Zmodem 收到文件 ${filename} (${size}B)`);
    send(conn.ownerWs, { type: 'zmodem', id: connId, filename, filePath, size });
  });

  try {
    if (cfg.type === 'ssh') {
      // Browser workspace restore may recreate several tabs for the same host
      // in one event-loop turn.  Authenticate them one at a time so a device
      // with a small sshd MaxStartups/pre-auth limit does not silently discard
      // every handshake.
      const endpoint = `${String(cfg.host || '').trim().toLowerCase()}:${Number(cfg.port) || 22}`;
      if (sshConnectScheduler.isBusy(endpoint)) {
        conn._lastStateMsg = '等待同一服务器的其他 SSH 握手…';
        send(conn.ownerWs, { type: 'status', id: connId, state: 'connecting', msg: conn._lastStateMsg });
      }
      await sshConnectScheduler.runExclusive(
        endpoint,
        () => conn.connect(),
        () => conn.state === 'closing' || conn.state === 'closed',
      );
    } else {
      await conn.connect();
    }
  } catch (e) {
    if (e && e.code === 'SSH_CONNECT_CANCELLED') return;
    // 连接失败: 状态已由 error/close 事件发出, 这里兜底
    send(conn.ownerWs, { type: 'status', id: connId, state: 'closed', msg: e.message });
    const key = connectionKey(ws, connId);
    const ownsSlot = connections.get(key) === conn;
    if (ownsSlot) connections.delete(key);
    if (ownsSlot && liveByConfig.get(ownerFpKey) === connId) liveByConfig.delete(ownerFpKey);
  }
}

const handle = createWsMessageHandler({
  getSessions,
  setSessions,
  saveSessions: (data) => saveSessions(data),
  sessionsList,
  nextSessionSortOrder,
  sessionSortOrder,
  importSessionEntries,
  storedSessionForConfig,
  mergeStoredCredentials,
  get sshConfig() { return sshConfig; },
  doConnect,
  attachExistingConnection,
  sendConnectionData,
  getConnection,
  connections,
  connectionKey,
  send,
  log,
  logs,
  getLogFile,
});

wss.on('connection', (ws, req) => {
  ws.windowId = requestedWindowId(req) || randomBytes(24).toString('base64url');
  const previous = windows.get(ws.windowId);
  if (previous && previous !== ws && previous.readyState < 2) {
    previous.replacedByRefresh = true;
    previous.close(4001, '页面已刷新');
  }
  cancelWindowCleanup(ws.windowId);
  windows.set(ws.windowId, ws);
  attachWsBackpressure(ws, () => resumePausedConnections(ws));
  send(ws, { type: 'window-id', windowId: ws.windowId });
  wsCount++;
  clearTimeout(idleExitTimer);
  const pingTimer = setInterval(() => {
    if (ws.readyState === 1) {
      try { ws.ping(); } catch {}
    }
  }, 25000);
  pingTimer.unref();
  ws.on('close', () => {
    clearInterval(pingTimer);
    wsCount--;
    scheduleIdleExit();
    if (windows.get(ws.windowId) === ws) {
      windows.delete(ws.windowId);
      for (const [key, conn] of connections) {
        if (key.startsWith(`${ws.windowId}:`) && conn.ownerWs === ws) conn.ownerWs = null;
      }
      scheduleWindowCleanup(ws.windowId);
    }
  });
  ws.on('error', (err) => log('error', `WebSocket 错误: ${err && err.message}`));
  ws.on('message', (msg, isBinary) => {
    if (isBinary) {
      if (msg.length < 2 || msg.length > 8 * 1024 * 1024) return;
      const id = msg.readUInt16LE(0);
      const conn = getConnection(ws, id);
      if (conn && conn.state === 'connected') conn.write(msg.subarray(2));
      return;
    }
    let m;
    try { m = JSON.parse(msg.toString()); } catch { return; }
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
    handle(ws, m).catch((e) => send(ws, {
      type: 'error',
      id: Number.isInteger(m.id) ? m.id : undefined,
      action: m.type,
      msg: String(e.message || e),
      occupied: !!e.sshtermOccupied,
    }));
  });
});

attachVncBridge(vncWss, { log });

server.listen(PORT, '127.0.0.1', () => {
  try {
    fs.mkdirSync(CONN_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, CLIENT_TOKEN, { mode: 0o600 });
  } catch (e) {
    console.error('[token] 无法写入 CLI token 文件:', e.message);
  }
  console.log('┌──────────────────────────────────────────────┐');
  console.log('│  sshterm  —  SSH / Telnet / VNC / 串口工具   │');
  console.log('└──────────────────────────────────────────────┘');
  console.log(`  地址: http://127.0.0.1:${PORT}`);
  console.log(`  会话: ${CONN_FILE}`);
  console.log(`  日志: ${getLogFile()}`);
  log('info', `sshterm 服务启动 (端口 ${PORT})`);
  scheduleIdleExit();
  const open = !process.argv.includes('--no-open');
  if (open) {
    require('child_process').exec(`start http://127.0.0.1:${PORT}`);
  }
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 被占用, 换个端口: node server/index.js --port 8788`);
    process.exit(1);
  }
  throw e;
});
process.on('SIGINT', () => { for (const c of connections.values()) c.close(); process.exit(0); });
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e && (e.stack || e.message));
  log('error', `服务端异常: ${e && (e.stack || e.message)}`);
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e && e.message);
});
