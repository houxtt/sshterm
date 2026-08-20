// sshterm 服务端: HTTP 静态 + WebSocket 路由 + 连接管理 + 会话持久化
// 启动: node server/index.js [--port 8787] [--no-open]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID, randomBytes } = require('crypto');
const { WebSocketServer } = require('ws');
const { createBackup, readBackup, parseOpenSSHConfig } = require('./session-backup');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const CONN_DIR = path.join(os.homedir(), '.sshterm');
const CONN_FILE = path.join(CONN_DIR, 'sessions.json');
const MAX_SFTP_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

const connections = new Map();   // connId -> BaseConnection
const windows = new Map();       // opaque window capability -> WebSocket
function connectionKey(ws, id) { return `${ws.windowId}:${id}`; }
function getConnection(ws, id) { return connections.get(connectionKey(ws, id)); }
function getHttpConnection(qs) {
  const ws = windows.get(String(qs.get('window') || ''));
  if (ws) return getConnection(ws, parseInt(qs.get('conn'), 10));
  // Isolated fixture has no browser window; never enabled in normal startup.
  return process.env.SSHTERM_TEST_SFTP_ROOT ? connections.get(parseInt(qs.get('conn'), 10)) : null;
}
const liveByConfig = new Map();  // 配置指纹 -> connId (去重: 同一配置只开一个)
// Enables an isolated local SFTP fixture for transport integration tests only.
// The variable is intentionally undocumented for end users and is never set by
// normal launchers or release workflows.
if (process.env.SSHTERM_TEST_SFTP_ROOT) {
  const { installLocalSftpFixture } = require('./test-sftp-fixture');
  installLocalSftpFixture(connections, process.env.SSHTERM_TEST_SFTP_ROOT);
}
// P2 FIX: SFTP 上传并发控制
const MAX_CONCURRENT_UPLOADS = 3;  // 最大并发上传数
let activeUploads = 0;
const activeUploadKeys = new Set(); // connId:remotePath; prevents overlapping r+/w writes
// A random per-process capability prevents arbitrary web pages from controlling
// the loopback service.  Loopback is not an authentication boundary by itself.
const CLIENT_TOKEN = randomBytes(32).toString('base64url');
const PORT = parseInt(process.argv[process.argv.indexOf('--port') + 1], 10) || 8787; // P0 FIX: 移到此处供 isTrustedOrigin 使用

function hasClientToken(req) {
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    return u.searchParams.get('token') === CLIENT_TOKEN;
  } catch { return false; }
}

// 新增：双重来源校验 - 防止恶意网页通过 <script src="..."> 抓取 token
// 由端口函数获取，确保与 server.listen 的端口一致
function isTrustedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 非浏览器请求(CLI)，放行
  try {
    const u = new URL(origin);
    const validHost = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    // Origin port 应该匹配实际监听端口；若未指定则默认 8787
    const origPort = u.port || (u.protocol === 'https:' ? '443' : '80');
    const validPort = origPort === String(PORT);
    return validHost && validPort;
  } catch { return false; }
}

function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}

// ---------- 操作日志 (内存环形 + 每次启动新日志文件落盘) ----------
const MAX_LOGS = 1000;
const logs = [];
// 每次启动生成新的日志文件: ~/.sshterm/logs/sshterm-YYYYMMDD-HHMMSS.log (关闭后保留)
const LOG_DIR = path.join(CONN_DIR, 'logs');
const SESSION_LOG_DIR = path.join(CONN_DIR, 'session-logs');
function newLogFile() {
  const d = new Date();
  const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  return path.join(LOG_DIR, `sshterm-${ts}.log`);
}
let LOG_FILE = newLogFile();
function redactLog(value) {
  return String(value)
    .replace(/(password|passphrase|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, '$1\n[REDACTED]\n$2')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
}
function log(level, msg) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const entry = {
    t: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    level, msg: redactLog(msg),
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${entry.t}] [${level}] ${entry.msg}\n`);
  } catch (e) { /* 日志写入失败不影响功能 */ }
  return entry;
}

// ---------- 会话持久化 ----------
let sessions = loadSessions();

// Retain both operation logs and terminal transcripts.  Session transcripts
// used to grow without bound because only LOG_DIR was cleaned.
const MAX_LOG_FILES = 100;
const MAX_LOG_AGE_DAYS = 30;
function cleanupLogDirectory(dir, matcher) {
  try {
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter(f => f.isFile() && matcher.test(f.name))
      .map(f => ({ name: f.name, path: path.join(dir, f.name), mtime: fs.statSync(path.join(dir, f.name)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);
    const cutoff = Date.now() - MAX_LOG_AGE_DAYS * 24 * 3600 * 1000;
    for (let i = MAX_LOG_FILES; i < files.length; i++) {
      try { fs.unlinkSync(files[i].path); } catch {}
    }
    for (const f of files.slice(0, MAX_LOG_FILES)) {
      if (f.mtime.getTime() < cutoff) {
        fs.unlinkSync(f.path);
        console.log(`[log-cleanup] 删除过期日志: ${f.name} (${f.mtime.toISOString().split('T')[0]})`);
      }
    }
  } catch (e) { /* 静默处理 */ }
}
function cleanupOldLogs() {
  cleanupLogDirectory(LOG_DIR, /^sshterm-\d{8}-\d{6}\.log$/);
  cleanupLogDirectory(SESSION_LOG_DIR, /\.log$/i);
}
// 启动时清理旧日志
setTimeout(cleanupOldLogs, 1000);
const { writeSecrets, readSecrets } = require('./dpapi');
function loadSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONN_FILE, 'utf8'));
    // Migrate older versions that persisted credentials. Credentials are
    // intentionally process-memory-only and must not survive a restart unless
    // the session opts in to DPAPI-backed "remember password".
    let migrated = false;
    const clean = Object.fromEntries(Object.entries(raw).map(([id, s]) => {
      const { password, passphrase, loginPass, privateKey, proxy, jumpAuth, ...safe } = s || {};
      const { password: proxyPassword, ...safeProxy } = proxy || {};
      const { password: jumpPassword, privateKey: jumpPrivateKey, passphrase: jumpPassphrase, ...safeJumpAuth } = jumpAuth || {};
      if ([password, passphrase, loginPass, privateKey, proxyPassword, jumpPassword, jumpPrivateKey, jumpPassphrase].some(v => v !== undefined)) migrated = true;
      if (proxy) safe.proxy = safeProxy;
      if (jumpAuth) safe.jumpAuth = safeJumpAuth;
      return [id, safe];
    }));
    if (migrated) {
      fs.mkdirSync(CONN_DIR, { recursive: true });
      fs.writeFileSync(CONN_FILE, JSON.stringify(clean, null, 2));
    }
    // Load DPAPI-backed secrets for sessions that opted into "remember password"
    const secrets = readSecrets();
    for (const [id, s] of Object.entries(clean)) {
      if (s.rememberPassword && secrets[id]) {
        const saved = secrets[id];
        clean[id] = {
          ...s,
          password: saved.password,
          passphrase: saved.passphrase,
          loginPass: saved.loginPass,
          privateKey: saved.privateKey,
          proxy: s.proxy ? { ...s.proxy, ...(saved.proxyPassword ? { password: saved.proxyPassword } : {}) } : s.proxy,
          jumpAuth: s.jumpAuth ? {
            ...s.jumpAuth,
            ...(saved.jumpPassword ? { password: saved.jumpPassword } : {}),
            ...(saved.jumpPrivateKey ? { privateKey: saved.jumpPrivateKey } : {}),
            ...(saved.jumpPassphrase ? { passphrase: saved.jumpPassphrase } : {}),
          } : s.jumpAuth,
        };
      }
    }
    return clean;
  }
  catch { return {}; }
}
function saveSessions(data) {
  try {
    fs.mkdirSync(CONN_DIR, { recursive: true });
    // Write DPAPI-backed secrets only for opted-in sessions
    const secrets = {};
    for (const [id, s] of Object.entries(data)) {
      if (s.rememberPassword && (s.password || s.passphrase || s.loginPass || s.privateKey || s.proxy?.password ||
          s.jumpAuth?.password || s.jumpAuth?.privateKey || s.jumpAuth?.passphrase)) {
        secrets[id] = {
          password: s.password,
          passphrase: s.passphrase,
          loginPass: s.loginPass,
          privateKey: s.privateKey,
          proxyPassword: s.proxy?.password,
          jumpPassword: s.jumpAuth?.password,
          jumpPrivateKey: s.jumpAuth?.privateKey,
          jumpPassphrase: s.jumpAuth?.passphrase,
        };
      }
    }
    writeSecrets(secrets);
    // Never write reusable credentials to disk in plain JSON.
    const diskData = Object.fromEntries(Object.entries(data).map(([id, s]) => {
      const { password, passphrase, loginPass, privateKey, proxy, jumpAuth, ...safe } = s;
      if (proxy) {
        const { password: proxyPassword, ...safeProxy } = proxy;
        safe.proxy = safeProxy;
      }
      if (jumpAuth) {
        const { password: jumpPassword, privateKey: jumpPrivateKey, passphrase: jumpPassphrase, ...safeJumpAuth } = jumpAuth;
        safe.jumpAuth = safeJumpAuth;
      }
      return [id, safe];
    }));
    fs.writeFileSync(CONN_FILE, JSON.stringify(diskData, null, 2));
  } catch (e) { console.error('[会话] 保存失败:', e.message); }
}

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
        hosts[current] = { hostname: '', port: 22, user: 'root', identity: '', proxyJump: '' };
      } else if (current) {
        if (k === 'hostname') hosts[current].hostname = val.replace(/['"]/g, '').trim();
        else if (k === 'port') hosts[current].port = parseInt(val, 10);
        else if (k === 'user') hosts[current].user = val.replace(/['"]/g, '').trim();
        else if (k === 'identityfile') hosts[current].identity = val.replace(/['"]/g, '').trim();
        else if (k === 'proxyjump') hosts[current].proxyJump = val.replace(/['"]/g, '').trim();
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

  // The UI obtains this only from the loopback bootstrap script.  State-changing
    // and file-transfer endpoints require it; static assets remain public but
    // cannot perform privileged actions.
    // P0 FIX: bootstrap.js 也要 Origin 校验，防止 <script src="..."> 抓取 token
    if (url === '/bootstrap.js') {
      if (!isTrustedOrigin(req)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('forbidden: untrusted origin');
      }
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      return res.end(`window.__SSHTERM_TOKEN=${JSON.stringify(CLIENT_TOKEN)};`);
    }
    if (url.startsWith('/api/') && (!hasClientToken(req) || !isTrustedOrigin(req))) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('forbidden');
      }

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
    const conn = getHttpConnection(qs);
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
    const conn = getHttpConnection(qs);
    const dir = qs.get('path') || '.';
    const name = qs.get('name') || '';
    const rawOffset = qs.get('offset');
    const offset = rawOffset === null ? 0 : Number(rawOffset);
    const segments = String(name).replace(/\\/g, '/').split('/');
    const contentLength = Number(req.headers['content-length'] || 0);
    if (!conn || !conn.getSftpInst() || !name || !Number.isSafeInteger(offset) || offset < 0 ||
        segments.some(p => !p || p === '.' || p === '..' || p.includes('\0')) ||
        (contentLength && (!Number.isSafeInteger(contentLength) || contentLength > MAX_SFTP_UPLOAD_BYTES))) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('上传参数错误(连接或文件名无效)');
    }
    const remotePath = dir.endsWith('/') ? dir + name : `${dir}/${name}`;
    const uploadKey = `${conn.id}:${remotePath}`;
    if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '2' });
      return res.end('上传队列繁忙，请稍后重试');
    }
    if (activeUploadKeys.has(uploadKey)) {
      res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('同一远端文件正在上传');
    }
    activeUploads++;
    activeUploadKeys.add(uploadKey);
    let finished = false;
    const finish = (status, message, payload) => {
      if (finished) return;
      finished = true;
      activeUploads--;
      activeUploadKeys.delete(uploadKey);
      if (res.writableEnded) return;
      if (payload) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      } else {
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(message);
      }
    };
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
      // offset>0 用 r+ 模式续写, offset=0 用 w 新建。一个远端文件同
      // 一时间仅允许一个请求，避免分块上传之间的创建/覆盖竞态。
      const ws = sftp.createWriteStream(remotePath, {
        flags: offset > 0 ? 'r+' : 'w',
        start: offset,
      });
      let received = 0;
      let aborted = false;
      req.setTimeout(30 * 60 * 1000, () => {
        aborted = true;
        req.destroy(new Error('上传超时'));
        ws.destroy(new Error('上传超时'));
      });
      req.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_SFTP_UPLOAD_BYTES) {
          aborted = true;
          req.destroy(new Error('上传文件超过大小上限'));
          ws.destroy(new Error('上传文件超过大小上限'));
        }
      });
      req.on('aborted', () => { aborted = true; try { ws.destroy(); } catch {} });
      req.on('error', () => { aborted = true; try { ws.destroy(); } catch {} });
      req.pipe(ws);
      ws.on('close', () => {
        if (aborted) return finish(499, '上传已取消或超时');
        // A complete remote hash is calculated exactly once, after the only
        // writer closes. It is used by the UI to verify the local file.
        const crypto = require('crypto');
        const hash = crypto.createHash('sha256');
        const rs = conn.getSftpInst().createReadStream(remotePath);
        rs.on('data', d => hash.update(d));
        rs.on('error', (e) => {
          console.log('[sftp-upload] 校验错误:', e.message);
          finish(500, `校验文件哈希失败: ${e.message}`);
        });
        rs.on('end', () => {
          const fileHash = hash.digest('hex');
          console.log(`[sftp-upload] ${remotePath} 完成, size=${received}, hash=${fileHash.substring(0, 16)}...`);
          finish(200, '', {
            ok: true, size: received, hash: fileHash,
            message: offset > 0 ? '续写完成' : '上传完成',
          });
        });
      });
      ws.on('error', (e) => {
        console.log('[sftp-upload] 错误:', e.message);
        finish(500, e.message);
      });
    }).catch((e) => finish(500, `创建远端目录失败: ${e.message}`));
    return;
  }

  // SHA-256 is calculated server-side from the remote SFTP stream so uploads
  // can be verified without running shell commands on the remote machine.
  if (url.startsWith('/api/sftp/checksum')) {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const conn = getHttpConnection(qs);
    const rpath = qs.get('path') || '';
    if (!conn || !conn.getSftpInst() || !rpath) { res.writeHead(400); return res.end('SFTP 通道未就绪'); }
    const hash = require('crypto').createHash('sha256');
    const rs = conn.getSftpInst().createReadStream(rpath);
    rs.on('data', d => hash.update(d));
    rs.on('error', e => { res.writeHead(500); res.end(e.message); });
    rs.on('end', () => {
      if (!res.writableEnded) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ algorithm: 'sha256', hash: hash.digest('hex') })); }
    });
    return;
  }

  // SFTP 目录下载 (递归打包 zip, 流式): /api/sftp/download-dir?conn=<id>&path=<远端目录>
  if (url.startsWith('/api/sftp/download-dir')) {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const conn = getHttpConnection(qs);
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

  // SFTP file download with single-range support.  Range lets an interrupted
  // browser download continue without asking the remote server to resend the
  // bytes already received.
  if (url.startsWith('/api/sftp/download')) {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const conn = getHttpConnection(qs);
    const rpath = qs.get('path') || '';
    if (!conn || !conn.getSftpInst()) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('SFTP 通道未就绪(连接可能已断开)');
    }
    const sftp = conn.getSftpInst();
    sftp.stat(rpath, (statErr, st) => {
      if (statErr || !st || !Number.isSafeInteger(st.size)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('远端文件不存在或无法读取');
      }
      const size = st.size;
      const name = path.basename(rpath);
      let start = 0;
      let end = Math.max(0, size - 1);
      let partial = false;
      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!m) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          return res.end();
        }
        start = Number(m[1]);
        end = m[2] ? Number(m[2]) : end;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          return res.end();
        }
        end = Math.min(end, size - 1);
        partial = true;
      }
      const length = size === 0 ? 0 : end - start + 1;
      const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`,
        'Cache-Control': 'no-cache',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(length),
      };
      if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      res.writeHead(partial ? 206 : 200, headers);
      if (size === 0) return res.end();
      const rs = sftp.createReadStream(rpath, { start, end });
      rs.on('error', (e) => { if (!res.writableEnded) res.destroy(e); });
      req.on('aborted', () => { try { rs.destroy(); } catch {} });
      rs.pipe(res);
    });
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
  // Do not use a prefix check here: paths such as ../sshterm-private pass a
  // textual prefix check.  Assets must be in exactly their intended root.
  const allowedRoot = url.startsWith('/vendor/')
    ? path.join(ROOT, 'node_modules')
    : WEB;
  if (!isInside(allowedRoot, file)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
                         'Cache-Control': 'no-cache',
                         'X-Content-Type-Options': 'nosniff',
                         'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws:; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'" });
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
  verifyClient: ({ origin, req }) => {
    if (!hasClientToken(req)) return false;
    // A browser UI must originate on the loopback server.  Non-browser test
    // clients also need the per-process capability token.
    if (!origin) return true;
    try {
      const u = new URL(origin);
      return (u.hostname === '127.0.0.1' || u.hostname === 'localhost') &&
        (u.protocol === 'http:' || u.protocol === 'https:');
    } catch { return false; }
  },
});
wss.on('connection', (ws) => {
  ws.windowId = randomBytes(24).toString('base64url');
  windows.set(ws.windowId, ws);
  send(ws, { type: 'window-id', windowId: ws.windowId });
  wsCount++;
  clearTimeout(idleExitTimer);
  ws.on('close', () => {
    wsCount--;
    scheduleIdleExit();
    windows.delete(ws.windowId);
    for (const [key, conn] of connections) if (key.startsWith(`${ws.windowId}:`)) conn.close();
  });
  ws.on('message', (msg, isBinary) => {
    if (isBinary) {
      // binary: [connId: 2B LE][data...] → 路由到连接的 write
      if (msg.length < 2) return;
      const id = msg.readUInt16LE(0);
      const conn = getConnection(ws, id);
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
  const { password, privateKey, passphrase, loginPass, proxy, jumpAuth, ...rest } = s;
  if (proxy) {
    const { password: proxyPassword, ...safeProxy } = proxy;
    rest.proxy = safeProxy;
  }
  if (jumpAuth) {
    const { password: jumpPassword, privateKey: jumpPrivateKey, passphrase: jumpPassphrase, ...safeJumpAuth } = jumpAuth;
    rest.jumpAuth = safeJumpAuth;
  }
  return rest;
}
function sessionSortOrder(session, fallback) {
  const value = Number(session && session.sortOrder);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
function sessionsList() {
  return Object.values(sessions)
    .map((session, index) => ({ session, index }))
    .sort((a, b) => sessionSortOrder(a.session, a.index) - sessionSortOrder(b.session, b.index))
    .map(({ session }) => sanitize(session));
}
function nextSessionSortOrder() {
  return Object.values(sessions).reduce(
    (max, session, index) => Math.max(max, sessionSortOrder(session, index)), -1) + 1;
}
function importSessionEntries(entries, source) {
  if (!Array.isArray(entries) || entries.length > 500) throw new Error('导入会话数量无效（最多 500 个）');
  const names = new Set(Object.values(sessions).map(s => s.name));
  const acceptedTypes = new Set(['ssh', 'telnet', 'serial']);
  let count = 0;
  for (const item of entries) {
    if (!item || typeof item !== 'object' || !acceptedTypes.has(item.type)) continue;
    const session = JSON.parse(JSON.stringify(item)); // drops hostile prototypes
    let name = String(session.name || '').trim().slice(0, 120);
    if (!name) continue;
    const original = name;
    let suffix = 2;
    while (names.has(name)) name = `${original} (${suffix++})`;
    names.add(name);
    session.id = randomUUID();
    session.name = name;
    // Imported OpenSSH IdentityFile paths use the existing DPAPI-backed key
    // path field; a portable backup retains its own rememberPassword choice.
    if (source === 'openssh' && session.privateKey) session.rememberPassword = true;
    session.sortOrder = nextSessionSortOrder();
    sessions[session.id] = session;
    count++;
  }
  if (!count) throw new Error('没有可导入的有效会话');
  saveSessions(sessions);
  log('audit', `导入 ${count} 个会话（${source}）`);
  return count;
}
function broadcast(obj) {
  for (const c of wss.clients) send(c, obj);
}
function sendBinary(ws, id, data) {
  const frame = Buffer.allocUnsafe(2 + data.length);
  frame.writeUInt16LE(id, 0);
  data.copy(frame, 2);
  if (ws.readyState === 1) ws.send(frame, { binary: true });
}

async function handle(ws, m) {
  switch (m.type) {
    case 'test-sftp-claim': {
      if (!process.env.SSHTERM_TEST_SFTP_ROOT || !Number.isInteger(m.id)) return;
      const fixture = connections.get(9900);
      if (!fixture) return;
      connections.set(connectionKey(ws, m.id), { ...fixture, id: m.id });
      send(ws, { type: 'test-sftp-claimed', id: m.id });
      break;
    }
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
        if (s.proxy && !s.proxy.password && sessions[s.id].proxy?.password) {
          s.proxy = { ...s.proxy, password: sessions[s.id].proxy.password };
        }
        if (s.jumpAuth && sessions[s.id].jumpAuth) {
          for (const k of ['password', 'privateKey', 'passphrase']) {
            if (!s.jumpAuth[k] && sessions[s.id].jumpAuth[k]) s.jumpAuth[k] = sessions[s.id].jumpAuth[k];
          }
        }
        // The dialog does not expose order, so an edit must retain the
        // position established by drag-and-drop.
        s.sortOrder = sessionSortOrder(sessions[s.id], nextSessionSortOrder());
        sessions[s.id] = s;
        log('info', `更新会话「${s.name}」`);
      } else {
        s.id = randomUUID();
        s.sortOrder = nextSessionSortOrder();
        sessions[s.id] = s;
        log('info', `新建会话「${s.name}」(${s.type})`);
      }
      saveSessions(sessions);
      send(ws, { type: 'sessions', list: sessionsList() });
      break;
    }
    case 'reorder-sessions': {
      const order = Array.isArray(m.order) ? m.order : [];
      const ids = Object.keys(sessions);
      const expected = new Set(ids);
      if (order.length !== ids.length || new Set(order).size !== ids.length || order.some(id => !expected.has(id))) {
        return send(ws, { type: 'error', msg: '会话排序数据无效，请刷新后重试' });
      }
      const groups = m.groups && typeof m.groups === 'object' && !Array.isArray(m.groups) ? m.groups : null;
      const reordered = {};
      for (let index = 0; index < order.length; index++) {
        const id = order[index];
        const session = { ...sessions[id], sortOrder: index };
        if (groups && Object.prototype.hasOwnProperty.call(groups, id)) {
          const group = typeof groups[id] === 'string' ? groups[id].trim().slice(0, 120) : '';
          if (group) session.group = group;
          else delete session.group;
        }
        reordered[id] = session;
      }
      sessions = reordered;
      saveSessions(sessions);
      log('info', `调整会话排序（${order.length} 个）`);
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
    case 'export-sessions': {
      const data = createBackup(Object.values(sessions), m.passphrase);
      const stamp = new Date().toISOString().slice(0, 10);
      log('audit', `导出 ${Object.keys(sessions).length} 个会话（加密备份）`);
      send(ws, { type: 'session-export', filename: `sshterm-backup-${stamp}.json`, data });
      break;
    }
    case 'import-sessions-backup': {
      const count = importSessionEntries(readBackup(m.data, m.passphrase), 'backup');
      send(ws, { type: 'sessions', list: sessionsList() });
      send(ws, { type: 'session-import', source: 'backup', count });
      break;
    }
    case 'import-openssh-config': {
      const count = importSessionEntries(parseOpenSSHConfig(m.data), 'openssh');
      send(ws, { type: 'sessions', list: sessionsList() });
      send(ws, { type: 'session-import', source: 'openssh', count });
      break;
    }
    case 'serial-force-free': {
      // 强制释放被占串口: 提权重启设备 (弹 UAC, 用户确认后 Disable/Enable)
      const { path: comPort } = m;
      if (!/^COM\d+$/i.test(String(comPort || ''))) {
        return send(ws, { type: 'error', msg: '串口号无效' });
      }
      log('audit', `请求提权释放串口 ${String(comPort).toUpperCase()}`);
      const ps1 = path.join(__dirname, 'free-serial.ps1');
      // Use an encoded, fixed PowerShell script and a validated COM value.
      // Never interpolate client-controlled text into a shell command line.
      const escPs = ps1.replace(/'/g, "''");
      const elevated = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${escPs}','-ComPort','${String(comPort).toUpperCase()}')`;
      const encoded = Buffer.from(elevated, 'utf16le').toString('base64');
      const cp = require('child_process');
      cp.execFile('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded],
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
      for (const [key, conn] of connections) if (key.startsWith(`${ws.windowId}:`)) conn.close();
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
        key: cfg.identity || '',
        proxyJump: cfg.proxyJump || ''
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
        if (sess.proxy && !sess.proxy.password && stored.proxy?.password) {
          sess.proxy = { ...sess.proxy, password: stored.proxy.password };
        }
        if (sess.jumpAuth && stored.jumpAuth) {
          for (const k of ['password', 'privateKey', 'passphrase']) {
            if (!sess.jumpAuth[k] && stored.jumpAuth[k]) sess.jumpAuth[k] = stored.jumpAuth[k];
          }
        }
      }
      await doConnect(ws, sess, m.id);
      break;
    }
    case 'host-key-decision': {
      const conn = getConnection(ws, m.id);
      if (!conn || conn.config.type !== 'ssh' || !conn.resolveHostKey) {
        return send(ws, { type: 'error', id: m.id, msg: '没有等待确认的 SSH 主机密钥' });
      }
      if (!conn.resolveHostKey(m.accept === true)) {
        return send(ws, { type: 'error', id: m.id, msg: '主机密钥确认已过期' });
      }
      log('audit', `SSH 主机密钥 ${m.accept === true ? '已信任' : '已拒绝'} (会话 ${m.id})`);
      break;
    }
    case 'serialports': {
      const { SerialPort } = require('serialport');
      const list = await SerialPort.list();
      send(ws, { type: 'serialports', list: list.map(p => ({ path: p.path, manufacturer: p.manufacturer })) });
      break;
    }
    case 'disconnect': {
      const conn = getConnection(ws, m.id);
      if (conn) { conn.close(); }
      break;
    }
    case 'resize': {
      const conn = getConnection(ws, m.id);
      if (conn && conn.resize) conn.resize(m.cols, m.rows);
      break;
    }
    case 'serial-control': {
      const conn = getConnection(ws, m.id);
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
      const conn = getConnection(ws, m.id);
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
    case 'tunnel': {
      const conn = getConnection(ws, m.id);
      if (!conn || conn.config.type !== 'ssh') {
        return send(ws, { type: 'error', id: m.id, msg: '隧道需要活跃的 SSH 连接' });
      }
      try {
        if (m.action === 'list') {
          const list = conn.listTunnels ? conn.listTunnels() : [];
          send(ws, { type: 'tunnel', id: m.id, action: 'list', tunnels: list });
        } else if (m.action === 'add') {
          const item = await conn.addTunnel({
            type: m.tunnelType,
            localPort: m.localPort,
            remoteHost: m.remoteHost,
            remotePort: m.remotePort,
          });
          if (conn.config.id && sessions[conn.config.id]) {
            const saved = sessions[conn.config.id];
            saved.tunnels = [...(saved.tunnels || []), { type: item.type, localPort: item.localPort, remoteHost: item.remoteHost, remotePort: item.remotePort }];
            saveSessions(sessions);
          }
          send(ws, { type: 'tunnel', id: m.id, action: 'add', tunnel: item });
          log('audit', `创建 ${item.type} 隧道: ${item.localPort} → ${item.remoteHost}:${item.remotePort}`);
        } else if (m.action === 'remove') {
          const ok = conn.removeTunnel ? conn.removeTunnel(m.tunnelId) : false;
          send(ws, { type: 'tunnel', id: m.id, action: 'remove', ok, tunnelId: m.tunnelId });
          if (ok) log('audit', `删除 SSH 隧道 ${m.tunnelId}`);
          if (ok && conn.config.id && sessions[conn.config.id]) { sessions[conn.config.id].tunnels = conn.listTunnels().map(t => ({ type: t.type, localPort: t.localPort, remoteHost: t.remoteHost, remotePort: t.remotePort })); saveSessions(sessions); }
        }
      } catch (e) {
        send(ws, { type: 'error', id: m.id, msg: `隧道操作失败: ${e.message}` });
      }
      break;
    }
  }
}

async function doConnect(ws, cfg, tabId) {
  // 串口物理独占, 保留去重; SSH/Telnet 允许同 IP 开多个会话
  const fpKey = cfg.type + '|' + (cfg.host || '') + '|' + (cfg.port || '') + '|' + (cfg.baudRate || '');
  const ownerFpKey = `${ws.windowId}|${fpKey}`;
  if (cfg.type === 'serial' && liveByConfig.has(ownerFpKey)) {
    return send(ws, { type: 'reuse', id: tabId, connId: liveByConfig.get(ownerFpKey) });
  }

  const ConnCls = { ssh: require('./connections/ssh'),
                    telnet: require('./connections/telnet'),
                    serial: require('./connections/serial') }[cfg.type];
  if (!ConnCls) return send(ws, { type: 'error', id: tabId, msg: `未知协议: ${cfg.type}` });

  const conn = new ConnCls(cfg);
  const connId = tabId;   // 前端 tab 即连接 id, 简化路由
  conn.id = connId;
  connections.set(connectionKey(ws, connId), conn);
  liveByConfig.set(ownerFpKey, connId);

  send(ws, { type: 'status', id: tabId, state: 'connecting', msg: '连接中…' });
  log('info', `连接 ${cfg.name || cfg.type}:${cfg.host || cfg.port || cfg.port} (${cfg.type})`);

  // 终端输出自动落盘: ~/.sshterm/session-logs/<会话名>-<时间戳>.log
  const enc = cfg.encoding || 'utf-8';
  const safeName = (cfg.name || cfg.type).replace(/[\\/:*?"<>|]/g, '_');
  const sts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const sessionLogFile = path.join(SESSION_LOG_DIR, `${safeName}-${sts}.log`);
  try { fs.mkdirSync(SESSION_LOG_DIR, { recursive: true }); } catch (e) {}
  let sessionLogStream = null;
  try { sessionLogStream = fs.createWriteStream(sessionLogFile, { flags: 'a' }); }
  catch (e) { console.log('[session-log] 创建失败:', e.message); }

  conn.on('data', (d) => {
    sendBinary(ws, connId, d);
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
      // P1-3 FIX: 关闭会话日志文件句柄，防止 fd 溢出
      if (sessionLogStream) {
        try { sessionLogStream.end(); } catch {}
        sessionLogStream = null;
      }
      connections.delete(connectionKey(ws, connId));
      if (liveByConfig.get(ownerFpKey) === connId) liveByConfig.delete(ownerFpKey);
    });
  conn.on('open', () => {
    console.log(`[conn] ${cfg.type} ${tabId} open`);
    log('info', `[${cfg.name || cfg.type}] 已连接`);
    send(ws, { type: 'status', id: connId, state: 'connected', msg: '已连接' });
    if (cfg.type === 'ssh' && Array.isArray(cfg.tunnels)) {
      (async () => { for (const tunnel of cfg.tunnels) { try { await conn.addTunnel(tunnel); } catch (e) { log('error', `隧道恢复失败 ${tunnel.localPort}: ${e.message}`); send(ws, { type: 'tunnel-alert', id: connId, msg: `隧道恢复失败 ${tunnel.localPort}: ${e.message}` }); } } })();
    }
  });
  conn.on('host-key', (info) => {
    send(ws, { type: 'host-key', id: connId, ...info });
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
    connections.delete(connectionKey(ws, connId));
    if (liveByConfig.get(ownerFpKey) === connId) liveByConfig.delete(ownerFpKey);
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
