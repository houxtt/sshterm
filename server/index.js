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

// ---------- 操作日志 (内存环形 + 每次启动新日志文件落盘) ----------
const MAX_LOGS = 1000;
const logs = [];
// 每次启动生成新的日志文件: ~/.sshterm/logs/sshterm-YYYYMMDD-HHMMSS.log (关闭后保留)
const LOG_DIR = path.join(CONN_DIR, 'logs');
function newLogFile() {
  const d = new Date();
  const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  return path.join(LOG_DIR, `sshterm-${ts}.log`);
}
let LOG_FILE = newLogFile();
function log(level, msg) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const entry = {
    t: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    level, msg,
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${entry.t}] [${level}] ${msg}\n`);
  } catch (e) { /* 日志写入失败不影响功能 */ }
  return entry;
}

// ---------- 会话持久化 ----------
function loadSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONN_FILE, 'utf8'));
    // Migrate older versions that persisted credentials. Credentials are
    // intentionally process-memory-only and must not survive a restart.
    let migrated = false;
    const clean = Object.fromEntries(Object.entries(raw).map(([id, s]) => {
      const { password, passphrase, loginPass, ...safe } = s || {};
      if ([password, passphrase, loginPass].some(v => v !== undefined)) migrated = true;
      return [id, safe];
    }));
    if (migrated) {
      fs.mkdirSync(CONN_DIR, { recursive: true });
      fs.writeFileSync(CONN_FILE, JSON.stringify(clean, null, 2));
    }
    return clean;
  }
  catch { return {}; }
}
function saveSessions(data) {
  try {
    fs.mkdirSync(CONN_DIR, { recursive: true });
    // Never write reusable credentials to disk. Secrets remain in memory only
    // for the lifetime of this server process; after restart the user must
    // enter them again. This avoids plaintext passwords in sessions.json.
    const diskData = Object.fromEntries(Object.entries(data).map(([id, s]) => {
      // privateKey is a local file path, not private-key material; preserve it.
      const { password, passphrase, loginPass, ...safe } = s;
      return [id, safe];
    }));
    fs.writeFileSync(CONN_FILE, JSON.stringify(diskData, null, 2));
  } catch (e) { console.error('[会话] 保存失败:', e.message); }
}
let sessions = loadSessions();

// ---------- SSH config 解析 ----------
// 支持: Host 别名 → Hostname IP/Port/User/IdentityFile
const SSH_CONFIG_PATH = path.join(os.homedir(), '.ssh', 'config');
let sshConfig = null;
function loadSSHConfig() {
  try {
    const raw = fs.readFileSync(SSH_CONFIG_PATH, 'utf8');
    const hosts = {};
    let current = null;
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*(Host|Hostname|Port|User|IdentityFile|ProxyJump)\s+(.+)$/i);
      if (!m) continue;
      const [, key, val] = m;
      const k = key.toLowerCase();
      if (k === 'host') {
        current = val.replace(/['"]/g, '').trim();
        hosts[current] = { hostname: '', port: 22, user: 'root', identity: '' };
      } else if (current) {
        if (k === 'hostname') hosts[current].hostname = val.replace(/['"]/g, '').trim();
        else if (k === 'port') hosts[current].port = parseInt(val, 10);
        else if (k === 'user') hosts[current].user = val.replace(/['"]/g, '').trim();
        else if (k === 'identityfile') hosts[current].identity = val.replace(/['"]/g, '').trim();
      }
    }
    sshConfig = hosts;
    console.log('[ssh-config] 加载', Object.keys(hosts).length, '个 Host 条目');
  } catch (e) {
    if (e.code !== 'ENOENT') console.log('[ssh-config] 加载失败:', e.message);
    sshConfig = {};
  }
}
loadSSHConfig();

// ---------- HTTP 静态服务 ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);

  // Zmodem 文件下载: /api/zmodem/download?file=<文件名>
  if (url.startsWith('/api/zmodem/download')) {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const name = qs.get('file') || '';
    const safe = path.basename(name).replace(/[\\/]/g, '_');
    const fp = path.join(os.homedir(), '.sshterm', 'zmodem', safe);
    fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404); return res.end('文件不存在'); }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(safe)}"`,
      });
      res.end(data);
    });
    return;
  }

  // SFTP 上传: HEAD 查询远端文件已存在大小 (断点续传判断)
  // PUT /api/sftp/upload?conn=<id>&path=<dir>&name=<file>&offset=N → 从 N 偏移续写
  if (req.method === 'HEAD' && url.startsWith('/api/sftp/upload')) {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const conn = connections.get(parseInt(qs.get('conn'), 10));
    const dir = qs.get('path') || '.';
    const name = qs.get('name') || '';
    if (!conn || !conn.getSftpInst() || !name) { res.writeHead(400); return res.end(); }
    const remotePath = dir.endsWith('/') ? dir + name : `${dir}/${name}`;
    const sftp = conn.getSftpInst();
    sftp.stat(remotePath, (err, st) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Remote-Size': String(st.size) });
      res.end(JSON.stringify({ size: st.size }));
    });
    return;
  }
  if (req.method === 'PUT' && url.startsWith('/api/sftp/upload')) {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const conn = connections.get(parseInt(qs.get('conn'), 10));
    const dir = qs.get('path') || '.';
    const name = qs.get('name') || '';
    const offset = parseInt(qs.get('offset'), 10) || 0;
    if (!conn || !conn.getSftpInst() || !name) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('上传参数错误(连接或文件名无效)');
    }
    const remotePath = dir.endsWith('/') ? dir + name : `${dir}/${name}`;
    const sftp = conn.getSftpInst();
    console.log(`[sftp-upload] ${remotePath} offset=${offset}`);
    // 递归创建父目录 (文件夹上传的子目录可能不存在)
    const parent = remotePath.slice(0, remotePath.lastIndexOf('/'));
    const mkdirs = (p) => new Promise((resolve) => {
      const parts = p.split('/').filter(Boolean);
      let cur = '';
      const next = (i) => {
        if (i >= parts.length) return resolve();
        cur += '/' + parts[i];
        sftp.mkdir(cur, () => next(i + 1));   // 已存在则忽略错误
      };
      next(0);
    });
    mkdirs(parent).then(() => {
      // offset>0 用 r+ 模式续写, offset=0 用 w 新建
      const ws = sftp.createWriteStream(remotePath, {
        flags: offset > 0 ? 'r+' : 'w',
        start: offset,
      });
      req.pipe(ws);
      ws.on('close', () => { res.writeHead(200); res.end('ok'); });
      ws.on('error', (e) => {
        console.log('[sftp-upload] 错误:', e.message);
        try { res.writeHead(500); res.end(e.message); } catch (err) { /* 忽略 */ }
      });
      req.on('error', () => { try { ws.destroy(); } catch (e) { /* 忽略 */ } });
    });
    return;
  }

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

// ---------- 空闲自动退出 (桌面启动器 --auto-exit 模式): 无 WS 连接 10 秒后退出 ----------
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
    }, 10000);
  }
}

// ---------- WebSocket 协议 ----------
// The HTTP server is loopback-only; additionally cap a single WebSocket frame
// so a malformed local client cannot allocate unbounded memory.
const wss = new WebSocketServer({
  server,
  maxPayload: 8 * 1024 * 1024,
  verifyClient: ({ origin }) => {
    // Only the local sshterm UI may use this local service. Node-based e2e
    // clients have no Origin header and are allowed for automation.
    if (!origin) return true;
    try {
      const u = new URL(origin);
      return (u.hostname === '127.0.0.1' || u.hostname === 'localhost') &&
        (u.protocol === 'http:' || u.protocol === 'https:');
    } catch { return false; }
  },
});
wss.on('connection', (ws) => {
  wsCount++;
  clearTimeout(idleExitTimer);
  ws.on('close', () => {
    wsCount--;
    scheduleIdleExit();
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
      if (msg.length < 2) return;
      const id = msg.readUInt16LE(0);
      const conn = connections.get(id);
      if (conn && conn.state === 'connected') conn.write(msg.subarray(2));
      return;
    }
    let m;
    try { m = JSON.parse(msg.toString()); } catch { return; }
    handle(ws, m).catch((e) => send(ws, {
      type: 'error', id: m.id, msg: String(e.message || e),
      occupied: !!e.sshtermOccupied,   // 串口被占用标记 (前端弹窗: 等待重试/强制释放)
    }));
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
      send(ws, { type: 'logs', list: logs.slice(-300), file: LOG_FILE });
      break;
    }
    case 'serial-force-free': {
      // 强制释放被占串口: 提权重启设备 (弹 UAC, 用户确认后 Disable/Enable)
      const { path: comPort } = m;
      if (!comPort) return send(ws, { type: 'error', msg: '缺少端口号' });
      const ps1 = path.join(__dirname, 'free-serial.ps1');
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', `"${ps1}"`, '-ComPort', comPort];
      // Start-Process -Verb RunAs 触发 UAC; 非管理员环境会抛错
      const cp = require('child_process');
      cp.exec(`powershell.exe -Command "Start-Process powershell -Verb RunAs -ArgumentList '${args.join("','")}' -Wait"`,
        { timeout: 120000 }, (err, stdout, stderr) => {
          const ok = !err;
          send(ws, {
            type: 'serial-free', path: comPort, ok,
            msg: ok ? `设备 ${comPort} 已强制重启, 占用已释放` : `强制释放失败(需管理员确认 UAC): ${err ? err.message : ''}`,
          });
          if (!ok) console.log('[serial-force-free] 失败:', err && err.message, stderr);
        });
      break;
    }
    case 'scan-net': {
      // 网络扫描: 输入 IP/网段 → 发现存活主机 + 开放端口
      // 支持: 192.168.1.216 | 192.168.1.0/24 | 192.168.1.1-192.168.1.254 | 192.168.1.100-200
      const { target } = m;
      if (!target) return send(ws, { type: 'error', msg: '缺少扫描目标' });
      const ips = expandTarget(String(target).trim());
      if (ips.error) return send(ws, { type: 'error', msg: ips.error });
      if (!ips.length) return send(ws, { type: 'error', msg: '目标格式无法解析: ' + target });
      const probePorts = [22, 23, 21, 80, 443, 3389, 5555, 8080];
      const net = require('net');
      const hosts = [];
      const ipOpen = new Map();
      let idx = 0;
      const test = (ip, port) => new Promise((resolve) => {
        const s = net.connect({ host: ip, port, timeout: 450 });
        s.on('connect', () => {
          const list = ipOpen.get(ip) || (ipOpen.set(ip, []), ipOpen.get(ip));
          list.push(port);
          s.destroy();
          resolve(true);
        });
        s.on('error', () => resolve(false));
        s.on('timeout', () => { s.destroy(); resolve(false); });
      });
      const worker = async () => {
        while (idx < ips.length * probePorts.length) {
          const i = idx++;
          const ip = ips[Math.floor(i / probePorts.length)];
          const port = probePorts[i % probePorts.length];
          await test(ip, port);
        }
      };
      console.log(`[scan-net] 目标 ${target} → ${ips.length} 个 IP 探测中...`);
      await Promise.all(Array.from({ length: 60 }, worker));   // 60 并发
      for (const ip of ips) {
        const open = (ipOpen.get(ip) || []).sort((a, b) => a - b);
        if (open.length) hosts.push({ ip, open });
      }
      console.log(`[scan-net] 完成: 发现 ${hosts.length} 台设备`);
      send(ws, { type: 'scan-net', target, hosts });
      break;
    }
    case 'scan': {
      // 端口扫描: TCP 探测 (并发 20, 单端口 800ms 超时)
      const { host, ports } = m;
      if (!host || !Array.isArray(ports) || !ports.length) {
        return send(ws, { type: 'error', msg: '扫描参数错误' });
      }
      const net = require('net');
      const open = [];
      let idx = 0;
      const test = (port) => new Promise((resolve) => {
        const s = net.connect({ host, port, timeout: 800 });
        s.on('connect', () => { open.push(port); s.destroy(); resolve(); });
        s.on('error', () => resolve());
        s.on('timeout', () => { s.destroy(); resolve(); });
      });
      const workers = Array.from({ length: 20 }, async () => {
        while (idx < ports.length) { const p = ports[idx++]; await test(p); }
      });
      await Promise.all(workers);
      send(ws, { type: 'scan', host, open: open.sort((a, b) => a - b) });
      break;
    }
    case 'cleanup': {
      // 页面加载兜底: 强制关闭该客户端全部连接 (刷新时 close 事件可能未触发导致残留)
      for (const [id, conn] of connections) conn.close();
      connections.clear();
      liveByConfig.clear();
      break;
    }
    case 'ssh-hosts': {
      // 返回本机 SSH config 中的 Host 列表供前端解析
      const hosts = sshConfig || {};
      const list = Object.entries(hosts).map(([name, cfg]) => ({
        name,
        host: cfg.hostname || '',
        port: cfg.port || 22,
        user: cfg.user || 'root',
        key: cfg.identity || ''
      }));
      send(ws, { type: 'ssh-hosts', list });
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
    case 'serial-control': {
      const conn = connections.get(m.id);
      if (!conn || conn.config.type !== 'serial') {
        return send(ws, { type: 'error', id: m.id, msg: '不是串口连接' });
      }
      try {
        if (m.action === 'signals') {
          await conn.setSignals({ dtr: !!m.dtr, rts: !!m.rts });
        } else if (m.action === 'break') {
          await conn.sendBreak(Math.min(Math.max(Number(m.duration) || 250, 20), 2000));
        } else {
          throw new Error('未知串口控制操作');
        }
        send(ws, { type: 'serial-control', id: m.id, ok: true, action: m.action });
      } catch (e) {
        send(ws, { type: 'error', id: m.id, msg: `串口控制失败: ${e.message}` });
      }
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
      } else if (m.action === 'cwd') {
        // 获取 shell 当前目录 (定位文件面板)
        const cwd = await conn.getShellCwd();
        send(ws, { type: 'sftp', id: m.id, action: 'cwd', path: cwd });
      }
      break;
    }
  }
}

async function doConnect(ws, cfg, tabId) {
  // 串口物理独占, 保留去重; SSH/Telnet 允许同 IP 开多个会话
  const fpKey = cfg.type + '|' + (cfg.host || '') + '|' + (cfg.port || '') + '|' + (cfg.baudRate || '');
  if (cfg.type === 'serial' && liveByConfig.has(fpKey)) {
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

  // 终端输出自动落盘: ~/.sshterm/session-logs/<会话名>-<时间戳>.log
  const SESSION_LOG_DIR = path.join(CONN_DIR, 'session-logs');
  const enc = cfg.encoding || 'utf-8';
  const safeName = (cfg.name || cfg.type).replace(/[\\/:*?"<>|]/g, '_');
  const sts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const sessionLogFile = path.join(SESSION_LOG_DIR, `${safeName}-${sts}.log`);
  try { fs.mkdirSync(SESSION_LOG_DIR, { recursive: true }); } catch (e) {}
  let sessionLogStream = null;
  try { sessionLogStream = fs.createWriteStream(sessionLogFile, { flags: 'a' }); }
  catch (e) { console.log('[session-log] 创建失败:', e.message); }

  conn.on('data', (d) => {
    sendBinary(connId, d);
    if (sessionLogStream) {
      try {
        const text = Buffer.isBuffer(d) ? d.toString(enc) : String(d);
        sessionLogStream.write(text);
      } catch (e) { /* 忽略解码失败 */ }
    }
  });
  conn.on('error', (msg, meta) => {
    console.log(`[conn] ${cfg.type} ${tabId} error:`, msg);
    log('error', `[${cfg.name || cfg.type}] ${msg}`);
    send(ws, { type: 'error', id: connId, msg, occupied: !!(meta && meta.occupied) });
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
  conn.on('zmodem-file', (filename, filePath, size) => {
    console.log(`[zmodem] 收到文件 ${filename} (${size}B)`);
    log('info', `Zmodem 收到文件 ${filename} (${size}B)`);
    send(ws, { type: 'zmodem', id: connId, filename, filePath, size });
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
// 网段解析: correct IPv4 integer expansion with a safe workload limit.
const MAX_SCAN_HOSTS = 4096;
function parseIPv4(s) {
  const p = String(s).split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3]) >>> 0;
}
function formatIPv4(n) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
function expandTarget(t) {
  t = t.trim();
  const single = parseIPv4(t);
  if (single !== null) return [formatIPv4(single)];

  const cidr = t.match(/^([^/]+)\/(\d{1,2})$/);
  if (cidr) {
    const ip = parseIPv4(cidr[1]);
    const bits = Number(cidr[2]);
    if (ip === null || bits < 0 || bits > 32) return [];
    const size = 2 ** (32 - bits);
    if (size > MAX_SCAN_HOSTS) return { error: `网段过大: ${size} 台, 请缩小到不超过 ${MAX_SCAN_HOSTS} 台` };
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const network = ip & mask;
    return Array.from({ length: size }, (_, i) => formatIPv4((network + i) >>> 0));
  }

  const range = t.match(/^([^\-]+)\s*-\s*(.+)$/);
  if (range) {
    const start = parseIPv4(range[1]);
    const end = parseIPv4(range[2]) ?? (() => {
      const prefix = range[1].trim().split('.').slice(0, 3).join('.');
      const last = Number(range[2].trim());
      return parseIPv4(`${prefix}.${last}`);
    })();
    if (start === null || end === null || end < start) return [];
    const size = end - start + 1;
    if (size > MAX_SCAN_HOSTS) return { error: `扫描范围过大: ${size} 台, 请缩小到不超过 ${MAX_SCAN_HOSTS} 台` };
    return Array.from({ length: size }, (_, i) => formatIPv4((start + i) >>> 0));
  }
  return [];
}

const PORT = parseInt(process.argv[process.argv.indexOf('--port') + 1], 10) || 8787;
server.listen(PORT, '127.0.0.1', () => {
  console.log('┌──────────────────────────────────────────────┐');
  console.log('│  sshterm  —  SSH / Telnet / 串口 连接工具     │');
  console.log('└──────────────────────────────────────────────┘');
  console.log(`  地址: http://127.0.0.1:${PORT}`);
  console.log(`  会话: ${CONN_FILE}`);
  console.log(`  日志: ${LOG_FILE}`);
  log('info', `sshterm 服务启动 (端口 ${PORT})`);   // 每次启动新建日志文件并写首行
  scheduleIdleExit();   // auto-exit 模式: 浏览器未连上则 10 秒后退出
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
