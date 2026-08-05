// sshterm 服务端: HTTP 静态 + WebSocket 路由 + 连接管理 + 会话持久化
// 启动: node server/index.js [--port 8787] [--no-open]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { WebSocketServer } = require('ws');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const CONN_DIR = path.join(os.homedir(), '.sshterm');
const CONN_FILE = path.join(CONN_DIR, 'sessions.json');

const connections = new Map();   // connId -> BaseConnection
const liveByConfig = new Map();  // 配置指纹 -> connId (去重: 同一配置只开一个)

// ---------- 操作日志 (内存环形 + 落盘) ----------
const MAX_LOGS = 1000;
const logs = [];
const LOG_FILE = path.join(CONN_DIR, 'sshterm.log');
function log(level, msg) {
  const entry = { t: new Date().toISOString().replace('T', ' ').slice(0, 19), level, msg };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  try {
    fs.mkdirSync(CONN_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${entry.t}] [${level}] ${msg}\n`);
  } catch (e) { /* 日志写入失败不影响功能 */ }
  return entry;
}

// ---------- 会话持久化 ----------
function loadSessions() {
  try { return JSON.parse(fs.readFileSync(CONN_FILE, 'utf8')); }
  catch { return {}; }
}
function saveSessions(data) {
  try {
    fs.mkdirSync(CONN_DIR, { recursive: true });
    fs.writeFileSync(CONN_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('[会话] 保存失败:', e.message); }
}
let sessions = loadSessions();

// ---------- HTTP 静态服务 ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);

  // SFTP 目录下载 (递归打包 zip, 流式): /api/sftp/download-dir?conn=<id>&path=<远端目录>
  if (url.startsWith('/api/sftp/download-dir')) {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const conn = connections.get(parseInt(qs.get('conn'), 10));
    const rdir = qs.get('path') || '';
    if (!conn || !conn.getSftpInst()) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('SFTP 通道未就绪(连接可能已断开)');
    }
    const dirName = path.basename(rdir) || 'download';
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(dirName)}.zip"`,
      'Cache-Control': 'no-cache',
    });
    conn.sftpCollectFiles(rdir).then(async (files) => {
      try {
        const { ZipArchive } = require('archiver');
        const archive = new ZipArchive({ zlib: { level: 1 } });   // 低压缩快打包
        archive.on('error', (e) => { console.log('[sftp-zip]', e.message); res.end(); });
        archive.pipe(res);
        // worker 限流: 同时只读 16 个文件流, 防止 SFTP 通道过载 (大目录 1.3 万文件)
        const MAX_STREAMS = 16;
        let idx = 0;
        const worker = () => new Promise((resolve) => {
          const next = () => {
            const f = files[idx++];
            if (!f) return resolve();
            const rs = conn.getSftpInst().createReadStream(f.path);
            rs.on('error', () => next());          // 单文件失败跳过
            rs.on('end', next);
            archive.append(rs, { name: f.name });
          };
          next();
        });
        await Promise.all(Array.from({ length: Math.min(MAX_STREAMS, files.length) }, worker));
        archive.finalize();
        console.log(`[sftp-zip] ${rdir} → ${files.length} 文件打包完成`);
      } catch (e) {
        console.log('[sftp-zip] 异常:', e.message);
        res.end(`\n[目录打包失败] ${e.message}`);
      }
    }).catch((e) => {
      console.log('[sftp-zip] 收集失败:', e.message);
      res.end(`\n[目录打包失败] ${e.message}`);
    });
    return;
  }

  // SFTP 文件下载 (流式): /api/sftp/download?conn=<id>&path=<远端路径>
  if (url.startsWith('/api/sftp/download')) {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const conn = connections.get(parseInt(qs.get('conn'), 10));
    const rpath = qs.get('path') || '';
    if (!conn || !conn.getSftpInst()) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('SFTP 通道未就绪(连接可能已断开)');
    }
    const name = path.basename(rpath);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`,
      'Cache-Control': 'no-cache',
    });
    const rs = conn.getSftpInst().createReadStream(rpath);
    rs.on('error', (e) => { res.end(`\n[下载错误] ${e.message}`); });
    rs.pipe(res);
    return;
  }

  if (url === '/') url = '/index.html';
  // node_modules 资源映射 (xterm.js)
  let file;
  if (url.startsWith('/vendor/')) {
    file = path.join(ROOT, 'node_modules', url.slice('/vendor/'.length));
  } else {
    file = path.join(WEB, url);
  }
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
                         'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- WebSocket 协议 ----------
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.on('close', () => {
    // 浏览器离开 → 关闭该客户端发起的全部连接, 防止僵尸连接
    for (const [id, conn] of connections) {
      conn.close();
    }
    connections.clear();
    liveByConfig.clear();
  });
  ws.on('message', (msg, isBinary) => {
    if (isBinary) {
      // binary: [connId: 2B LE][data...] → 路由到连接的 write
      const id = msg.readUInt16LE(0);
      const conn = connections.get(id);
      if (conn && conn.state === 'connected') conn.write(msg.subarray(2));
      return;
    }
    let m;
    try { m = JSON.parse(msg.toString()); } catch { return; }
    handle(ws, m).catch((e) => send(ws, { type: 'error', id: m.id, msg: String(e.message || e) }));
  });
});

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function sanitize(s) {
  // 返回给前端时剥除敏感字段 (密码/私钥/口令)
  const { password, privateKey, passphrase, loginPass, ...rest } = s;
  return rest;
}
function sessionsList() { return Object.values(sessions).map(sanitize); }
function broadcast(obj) {
  for (const c of wss.clients) send(c, obj);
}
function sendBinary(id, data) {
  const frame = Buffer.allocUnsafe(2 + data.length);
  frame.writeUInt16LE(id, 0);
  data.copy(frame, 2);
  for (const c of wss.clients) if (c.readyState === 1) c.send(frame, { binary: true });
}

async function handle(ws, m) {
  switch (m.type) {
    case 'list': {
      send(ws, { type: 'sessions', list: sessionsList() });
      break;
    }
    case 'save': {
      const s = m.session;
      if (!s.name) return send(ws, { type: 'error', msg: '会话名不能为空' });
      if (s.id && sessions[s.id]) {
        // 编辑保存: 前端表单密码框留空 = 不修改, 保留存储中的敏感字段
        for (const k of ['password', 'privateKey', 'passphrase', 'loginPass']) {
          if (s[k] === undefined || s[k] === '') s[k] = sessions[s.id][k];
        }
        sessions[s.id] = s;
        log('info', `更新会话「${s.name}」`);
      } else {
        s.id = randomUUID();
        sessions[s.id] = s;
        log('info', `新建会话「${s.name}」(${s.type})`);
      }
      saveSessions(sessions);
      send(ws, { type: 'sessions', list: sessionsList() });
      break;
    }
    case 'delete': {
      const name = sessions[m.id]?.name || m.id;
      delete sessions[m.id];
      saveSessions(sessions);
      log('info', `删除会话「${name}」`);
      send(ws, { type: 'sessions', list: sessionsList() });
      break;
    }
    case 'deleteMany': {
      const ids = Array.isArray(m.ids) ? m.ids : [];
      if (ids.length) {
        for (const id of ids) delete sessions[id];
        saveSessions(sessions);
        log('info', `批量删除会话 ${ids.length} 个`);
      }
      send(ws, { type: 'sessions', list: sessionsList() });
      break;
    }
    case 'log': {
      if (typeof m.msg === 'string') log('info', `[ui] ${m.msg}`);
      break;
    }
    case 'logs': {
      send(ws, { type: 'logs', list: logs.slice(-300) });
      break;
    }
    case 'connect': {
      const sess = { ...m.session };
      // 双击列表重连时前端只有脱敏副本, 从存储补全敏感字段
      if (sess.id && sessions[sess.id]) {
        const stored = sessions[sess.id];
        for (const k of ['password', 'privateKey', 'passphrase', 'loginPass']) {
          if (!sess[k]) sess[k] = stored[k];
        }
      }
      await doConnect(ws, sess, m.id);
      break;
    }
    case 'serialports': {
      const { SerialPort } = require('serialport');
      const list = await SerialPort.list();
      send(ws, { type: 'serialports', list: list.map(p => ({ path: p.path, manufacturer: p.manufacturer })) });
      break;
    }
    case 'disconnect': {
      const conn = connections.get(m.id);
      if (conn) { conn.close(); }
      break;
    }
    case 'resize': {
      const conn = connections.get(m.id);
      if (conn && conn.resize) conn.resize(m.cols, m.rows);
      break;
    }
    case 'sftp': {
      const conn = connections.get(m.id);
      if (!conn || conn.config.type !== 'ssh') {
        return send(ws, { type: 'error', id: m.id, msg: 'SFTP 需要活跃的 SSH 连接' });
      }
      if (m.action === 'list') {
        try {
          const r = await conn.sftpList(m.path || '.');
          send(ws, { type: 'sftp', id: m.id, action: 'list', path: r.path, entries: r.entries });
        } catch (e) {
          send(ws, { type: 'error', id: m.id, msg: `SFTP: ${e.message}` });
        }
      }
      break;
    }
  }
}

async function doConnect(ws, cfg, tabId) {
  // 同一配置指纹的活跃连接复用
  const fpKey = cfg.type + '|' + (cfg.host || '') + '|' + (cfg.port || '') + '|' + (cfg.baudRate || '');
  if (liveByConfig.has(fpKey)) {
    return send(ws, { type: 'reuse', id: tabId, connId: liveByConfig.get(fpKey) });
  }

  const ConnCls = { ssh: require('./connections/ssh'),
                    telnet: require('./connections/telnet'),
                    serial: require('./connections/serial') }[cfg.type];
  if (!ConnCls) return send(ws, { type: 'error', id: tabId, msg: `未知协议: ${cfg.type}` });

  const conn = new ConnCls(cfg);
  const connId = tabId;   // 前端 tab 即连接 id, 简化路由
  conn.id = connId;
  connections.set(connId, conn);
  liveByConfig.set(fpKey, connId);

  send(ws, { type: 'status', id: tabId, state: 'connecting', msg: '连接中…' });
  log('info', `连接 ${cfg.name || cfg.type}:${cfg.host || cfg.port || cfg.port} (${cfg.type})`);

  conn.on('data', (d) => sendBinary(connId, d));
  conn.on('error', (msg) => {
    console.log(`[conn] ${cfg.type} ${tabId} error:`, msg);
    log('error', `[${cfg.name || cfg.type}] ${msg}`);
    send(ws, { type: 'error', id: connId, msg });
  });
  conn.on('close', (reason) => {
    console.log(`[conn] ${cfg.type} ${tabId} close:`, reason);
    log('info', `[${cfg.name || cfg.type}] 断开: ${reason}`);
    send(ws, { type: 'status', id: connId, state: 'closed', msg: reason });
    connections.delete(connId);
    if (liveByConfig.get(fpKey) === connId) liveByConfig.delete(fpKey);
  });
  conn.on('open', () => {
    console.log(`[conn] ${cfg.type} ${tabId} open`);
    log('info', `[${cfg.name || cfg.type}] 已连接`);
    send(ws, { type: 'status', id: connId, state: 'connected', msg: '已连接' });
  });

  try {
    await conn.connect();
  } catch (e) {
    // 连接失败: 状态已由 error/close 事件发出, 这里兜底
    send(ws, { type: 'status', id: connId, state: 'closed', msg: e.message });
    connections.delete(connId);
    if (liveByConfig.get(fpKey) === connId) liveByConfig.delete(fpKey);
  }
}

// ---------- 启动 ----------
const PORT = parseInt(process.argv[process.argv.indexOf('--port') + 1], 10) || 8787;
server.listen(PORT, '127.0.0.1', () => {
  console.log('┌──────────────────────────────────────────────┐');
  console.log('│  sshterm  —  SSH / Telnet / 串口 连接工具     │');
  console.log('└──────────────────────────────────────────────┘');
  console.log(`  地址: http://127.0.0.1:${PORT}`);
  console.log(`  会话: ${CONN_FILE}`);
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
// 崩溃保护: 单个请求异常不杀死整个服务端
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e.message);
  log('error', `服务端异常: ${e.message}`);
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e && e.message);
});
