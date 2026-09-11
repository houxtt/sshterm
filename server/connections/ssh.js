// SSH 连接 (ssh2): 密码 / 密钥认证, 交互式 shell
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash } = require('crypto');
const net = require('net');
const { Client } = require('ssh2');
const BaseConnection = require('./base');

const KNOWN_HOSTS_PATH = path.join(os.homedir(), '.sshterm', 'known-hosts.json');
const DEFAULT_READY_TIMEOUT = 30000;

function readyTimeoutFor(config) {
  const value = Number(config.readyTimeout);
  return Number.isFinite(value) && value >= 10000 && value <= 120000
    ? Math.trunc(value) : DEFAULT_READY_TIMEOUT;
}

function answerInteractivePrompts(prompts, password) {
  return (prompts || []).map((p) => {
    const prompt = String((p && p.prompt) || p || '');
    if (/password|passcode|passphrase|口令|密码/i.test(prompt)) return password || '';
    return '';
  });
}

function promptsNeedUserInput(prompts, password) {
  return (prompts || []).some((p) => {
    const prompt = String((p && p.prompt) || p || '');
    if (/password|passcode|passphrase|口令|密码/i.test(prompt)) return !password;
    return true;
  });
}

function attachKeyboardInteractive(client, connection, password) {
  client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
    const normalized = (prompts || []).map((p) => ({
      prompt: String((p && p.prompt) || p || ''),
      echo: !(p && p.echo === false),
    }));
    if (!promptsNeedUserInput(prompts, password)) {
      finish(answerInteractivePrompts(prompts, password));
      return;
    }
    if (connection._pendingInteractive) {
      finish([]);
      return;
    }
    connection._pendingInteractive = {
      finish,
      timer: setTimeout(() => {
        if (!connection._pendingInteractive) return;
        connection._pendingInteractive = null;
        try { finish([]); } catch {}
        connection._emitError('MFA 验证超时');
      }, 120000),
    };
    connection.emit('interactive-auth', {
      name: String(name || ''),
      instructions: String(instructions || ''),
      prompts: normalized,
    });
  });
}

function keepaliveOpts() {
  // ssh2 keepalive is GLOBAL_REQUEST keepalive@openssh.com with wantReply.
  // BusyBox/old dropbear/network-gear sshd often ignore it. countMax=3 then
  // looks like a dead peer after ~45s idle even though TCP is fine. Tolerate
  // many unanswered SSH keepalives; TCP keepalive still refreshes NAT.
  return { keepaliveInterval: 20000, keepaliveCountMax: 12 };
}

function armSocketKeepalive(client) {
  const sock = client && client._sock;
  if (sock && !sock.destroyed && typeof sock.setKeepAlive === 'function') {
    try { sock.setKeepAlive(true, 10000); } catch {}
  }
}

function connectionErrorMessage(error, timeout) {
  if (error && error.level === 'client-timeout') {
    return `SSH 服务端未发送握手信息（TCP 已连接，等待 ${Math.round(timeout / 1000)} 秒超时）。`
      + '请检查服务端 sshd 的 MaxStartups/连接数、负载或安全设备限流，并关闭多余的未完成 SSH 连接';
  }
  return error && error.message ? error.message : String(error);
}

function forceDestroyClient(client) {
  // net.Socket.resetAndDestroy() sends RST instead of entering FIN_WAIT_2. This
  // matters when a broken/overloaded sshd accepts TCP but never reads the FIN.
  const socket = client && client._sock;
  if (socket && !socket.destroyed && typeof socket.resetAndDestroy === 'function') {
    try { socket.resetAndDestroy(); return; } catch {}
  }
  try { if (client) client.destroy(); } catch {}
}
function loadKnownHosts() {
  try { return JSON.parse(fs.readFileSync(KNOWN_HOSTS_PATH, 'utf8')); } catch { return {}; }
}
function saveKnownHost(name, fingerprint) {
  const hosts = loadKnownHosts();
  hosts[name] = fingerprint;
  fs.mkdirSync(path.dirname(KNOWN_HOSTS_PATH), { recursive: true });
  fs.writeFileSync(KNOWN_HOSTS_PATH, JSON.stringify(hosts, null, 2), { mode: 0o600 });
  try { fs.chmodSync(KNOWN_HOSTS_PATH, 0o600); } catch { /* Windows ACL controls access */ }
}
function makeHostVerifier(connection, hostName) {
  return (key, verify) => {
    const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
    const known = loadKnownHosts()[hostName];
    if (known === fingerprint) return verify ? verify(true) : true;
    if (known) {
      connection._emitError(`SSH 主机密钥不匹配 (${hostName})，可能存在中间人攻击`);
      return verify ? verify(false) : false;
    }
    connection._pendingHostKey = { hostName, fingerprint, verify, timer: setTimeout(() => connection.resolveHostKey(false), 30000) };
    connection.emit('host-key', { host: hostName, fingerprint });
    return undefined;
  };
}
function applyAuth(cfg, config) {
  const { auth = 'password', password, privateKey, passphrase } = config;
  if (auth === 'key') {
    // Private key path whitelist: only allow files under ~/.ssh or ~/.sshterm.
    // A token holder must not be able to read arbitrary local files as a key.
    if (privateKey) {
      const resolved = path.resolve(privateKey);
      const sshDir = path.join(os.homedir(), '.ssh');
      const sshtermDir = path.join(os.homedir(), '.sshterm');
      const allowed = resolved === sshDir
        || resolved.startsWith(sshDir + path.sep)
        || resolved.startsWith(sshtermDir + path.sep);
      if (!allowed) throw new Error('私钥路径不在允许目录内: ' + privateKey);
    }
    cfg.privateKey = fs.readFileSync(privateKey);
    if (passphrase) cfg.passphrase = passphrase;
  } else if (auth === 'agent') {
    cfg.agent = process.env.SSH_AUTH_SOCK || '\\\\.\\pipe\\openssh-ssh-agent';
    cfg.agentForward = !!config.agentForward;
  } else {
    cfg.password = password;
    if (auth === 'keyboard-interactive') cfg.tryKeyboard = true;
  }
}
function parseJumpChain(value) {
  if (!value) return [];
  const items = String(value).split(',').map(s => s.trim()).filter(Boolean);
  if (items.length > 4) throw new Error('最多支持 4 跳跳板机');
  return items.map(item => {
    const m = item.match(/^(?:([^@\s]+)@)?([^:\s]+)(?::(\d{1,5}))?$/);
    if (!m) throw new Error(`跳板机格式无效: ${item}`);
    const port = m[3] ? Number(m[3]) : 22;
    if (port < 1 || port > 65535) throw new Error(`跳板机端口无效: ${item}`);
    return { username: m[1], host: m[2], port };
  });
}
function waitReady(client, cfg) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`跳板机连接超时: ${cfg.host}`)), cfg.readyTimeout || 10000);
    client.once('ready', () => { clearTimeout(timer); resolve(); });
    client.once('error', e => { clearTimeout(timer); reject(e); });
    client.connect(cfg);
  });
}
function forwardThrough(client, host, port) {
  return new Promise((resolve, reject) => client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => err ? reject(err) : resolve(stream)));
}

function parseRemoteMem(body) {
  const readKb = (text, key) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
    return m ? Number(m[1]) : 0;
  };
  const infoStart = body.indexOf('MEMINFO_START');
  const infoEnd = body.indexOf('MEMINFO_END');
  if (infoStart >= 0 && infoEnd > infoStart) {
    const info = body.slice(infoStart, infoEnd);
    const totalKb = readKb(info, 'MemTotal');
    const availKb = readKb(info, 'MemAvailable') || readKb(info, 'MemFree');
    if (totalKb > 0) {
      const usedKb = Math.max(0, totalKb - availKb);
      return { memUsed: usedKb * 1024, memTotal: totalKb * 1024 };
    }
  }
  const memMatches = body.match(/MEM\s+(\d+)\s+(\d+)/g);
  const memLine = memMatches ? memMatches[memMatches.length - 1].match(/MEM\s+(\d+)\s+(\d+)/) : null;
  if (memLine) {
    return { memUsed: Number(memLine[1]), memTotal: Number(memLine[2]) };
  }
  return { memUsed: 0, memTotal: 0 };
}

function parseCpuTicks(body, label = 'CPUSTAT') {
  const m = String(body || '').match(new RegExp(`${label}\\s+([0-9]+(?:\\s+[0-9]+)*)`));
  if (!m) return null;
  const n = m[1].trim().split(/\s+/).map(Number);
  if (n.length < 4 || n.some((x) => !Number.isFinite(x))) return null;
  const idle = n[3] + (n[4] || 0);
  let total = 0;
  for (const x of n) total += x;
  return { idle, total };
}

function cpuPctBetween(prev, cur) {
  if (!prev || !cur) return null;
  const total = cur.total - prev.total;
  if (total <= 0) return null;
  const used = Math.max(0, total - (cur.idle - prev.idle));
  return Math.round((used / total) * 1000) / 10;
}

class SSHConnection extends BaseConnection {
  constructor(config) {
    super(config);
    this._ptySize = { cols: 120, rows: 32 };
  }

  _shellOptions() {
    return { term: 'xterm-256color', ...this._ptySize };
  }

  async connect() {
    this.state = 'connecting';
    const { host, port = 22, username, auth = 'password',
            password, privateKey, passphrase, proxy } = this.config;
    const readyTimeout = readyTimeoutFor(this.config);
    const cfg = {
      host, port, username, readyTimeout,
      ...keepaliveOpts(),
    };
    cfg.hostVerifier = makeHostVerifier(this, `${host}:${port}`);

    // Zmodem protocol detection is performed in the browser.  It needs the
    // raw terminal byte stream to negotiate browser-local file transfers.
    const jumps = parseJumpChain(this.config.proxyJump);
    const jumpAuth = this.config.jumpAuth || null;
    if (jumps.length && proxy) throw new Error('跳板机与 HTTP/SOCKS 代理不能同时使用');

    // 代理支持: SOCKS5 / HTTP CONNECT (公司网络场景)
    if (proxy && proxy.host && proxy.port) {
      try {
        const { connectProxy } = require('./proxy');
        const sock = await connectProxy({ host, port }, proxy);
        cfg.sock = sock;
        sock.on('error', (e) => this._emitError(`代理连接错误: ${e.message}`));
      } catch (e) {
        this._emitError(`代理连接失败: ${e.message}`);
        return Promise.reject(e);
      }
    }

    applyAuth(cfg, this.config);

    // ProxyJump: each hop is authenticated and host-key verified, then its
    // direct-tcpip channel becomes the socket for the next hop/target.
    let upstream = null;
    this.jumpClients = [];
    for (const hop of jumps) {
      // A jump chain can use credentials unrelated to the destination.  The
      // UI supplies one credential set for the chain; an explicit user@host
      // in ProxyJump remains the highest-priority username.
      const jumpCredentials = jumpAuth ? { ...this.config, ...jumpAuth } : this.config;
      const jumpCfg = { host: hop.host, port: hop.port, username: hop.username || jumpAuth?.username || username, readyTimeout,
        ...keepaliveOpts(), hostVerifier: makeHostVerifier(this, `${hop.host}:${hop.port}`) };
      applyAuth(jumpCfg, jumpCredentials);
      if (upstream) jumpCfg.sock = await forwardThrough(upstream, hop.host, hop.port);
      const jump = new Client();
      if (jumpCredentials.auth === 'keyboard-interactive') {
        jump.on('keyboard-interactive', (n, i, l, prompts, finish) => finish(answerInteractivePrompts(prompts, jumpCredentials.password)));
      }
      await waitReady(jump, jumpCfg);
      armSocketKeepalive(jump);
      this.jumpClients.push(jump);
      upstream = jump;
    }
    if (upstream) cfg.sock = await forwardThrough(upstream, host, port);

    return new Promise((resolve, reject) => {
      const client = new Client();
      this.client = client;
      let connectErrorReported = false;
      let settled = false;
      const finish = (fn) => { if (settled) return; settled = true; fn(); };
      if (auth === 'keyboard-interactive') {
        attachKeyboardInteractive(client, this, password);
      }
      client.on('ready', () => {
        armSocketKeepalive(client);
        // The browser commonly sends its fitted size while SSH is still
        // authenticating.  Use the cached value when allocating the PTY so
        // progress displays do not start at the obsolete 120x32 fallback.
        client.shell(this._shellOptions(), (err, stream) => {
          if (err) { this._emitError(`shell: ${err.message}`); return finish(() => reject(err)); }
          this.stream = stream;
          this.state = 'connected';
          stream.on('data', (d) => {
            for (const chunk of this._consumeShellData(d)) {
              this._trackOsc7Cwd(chunk);
              this._emitData(chunk);
            }
          });
          stream.on('close', () => {
            this._emitClose('SSH 会话已关闭');
            this._disposeResources();
          });
          stream.on('error', (e) => this._emitError(e.message));
          this.emit('open');
          finish(() => resolve());
        });
      });
      client.on('error', (e) => {
        // A timeout destroys ssh2's socket, which then emits the secondary
        // "Connection lost before handshake" error.  Report the useful root
        // cause once instead of showing two contradictory failures.
        if (this.state === 'closing' || this.state === 'closed') return;
        if (e && e.level === 'client-timeout') forceDestroyClient(client);
        // 连接建立后中断 vs 建连失败: 给出具体原因
        const detail = connectionErrorMessage(e, readyTimeout);
        const msg = this.state === 'connected'
          ? `SSH 连接中断: ${detail}`
          : `SSH 连接失败: ${detail}`;
        if (this.state !== 'connected' && connectErrorReported) return;
        if (this.state !== 'connected') connectErrorReported = true;
        this._emitError(msg);
        if (this.state !== 'connected') finish(() => reject(e));
      });
      client.on('close', (hadError) => {
        if (this.state === 'closing') {
          finish(() => reject(Object.assign(new Error('SSH 连接已取消'), { code: 'SSH_CONNECT_CANCELLED' })));
          return;
        }
        if (this.state === 'connected' || this.state === 'connecting') {
          this._emitClose(hadError
            ? `SSH 连接异常中断(网络问题)`
            : 'SSH 连接已关闭(远端)');
          if (this.state !== 'connected') {
            finish(() => reject(new Error(hadError ? 'SSH 连接异常中断(网络问题)' : 'SSH 连接已关闭(远端)')));
          }
          this._disposeResources();
        }
      });
      client.connect(cfg);
    });
  }

  write(data) {
    if (this.stream) this.stream.write(data);
  }

  resolveHostKey(accept) {
    const pending = this._pendingHostKey;
    if (!pending) return false;
    this._pendingHostKey = null;
    clearTimeout(pending.timer);
    if (accept) saveKnownHost(pending.hostName, pending.fingerprint);
    if (pending.verify) pending.verify(!!accept);
    return true;
  }

  submitInteractiveAuth(responses) {
    const pending = this._pendingInteractive;
    if (!pending) return false;
    clearTimeout(pending.timer);
    this._pendingInteractive = null;
    try {
      pending.finish(Array.isArray(responses) ? responses.map(v => String(v ?? '')) : []);
    } catch {}
    return true;
  }

  cancelInteractiveAuth() {
    const pending = this._pendingInteractive;
    if (!pending) return false;
    clearTimeout(pending.timer);
    this._pendingInteractive = null;
    try { pending.finish([]); } catch {}
    return true;
  }

  // ---------- SFTP 文件访问 (独立子系统, 与 shell 通道共存) ----------
  getSftp() {
    return new Promise((resolve, reject) => {
      if (this._sftp) return resolve(this._sftp);
      // 单飞: 并发请求共享一次子系统打开, 避免重复初始化
      if (this._sftpPending) {
        this._sftpPending.then(resolve, reject);
        return;
      }
      if (!this.client) return reject(new Error('SSH 未连接'));
      this._sftpPending = new Promise((res, rej) => {
        this.client.sftp((err, sftp) => {
          queueMicrotask(() => {
            if (err) return rej(err);
            this._sftp = sftp;
            const clear = () => { if (this._sftp === sftp) this._sftp = null; };
            sftp.once('close', clear);
            sftp.once('end', clear);
            res(sftp);
          });
        });
      });
      const pending = this._sftpPending;
      pending.finally(() => { if (this._sftpPending === pending) this._sftpPending = null; }).then(resolve, reject);
    });
  }

  // 列出目录: 先 realpath 规范化为绝对路径, 返回 { path, entries:[{name,isDir,size,mtime}] }
  async sftpList(dir) {
    const sftp = await this.getSftp();
    const real = await new Promise((resolve, reject) => {
      sftp.realpath(dir, (err, p) => (err ? reject(err) : resolve(p)));
    });
    const entries = await new Promise((resolve, reject) => {
      sftp.readdir(real, (err, list) => {
        if (err) return reject(err);
        resolve(list.map(f => ({
          name: f.filename,
          isDir: f.attrs.isDirectory(),
          size: f.attrs.size,
          mtime: f.attrs.mtime * 1000,   // sftp 返回秒, 转 ms
        })).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name)));
      });
    });
    return { path: real, entries };
  }

  sftpCreateReadStream(remotePath) {
    return this.getSftp().then(sftp => sftp.createReadStream(remotePath));
  }

  // 递归收集目录下所有文件: 返回 [{path, name(相对目录), size}]
  // 迭代式遍历 (显式栈, 深层目录树不会栈溢出), 批并发 limit 路
  // seen 去重防符号链接循环, 每批 readdir 超时防挂起
  async sftpCollectFiles(dir, base = '', limit = 4) {
    const sftp = await this.getSftp();
    const files = [];
    const emptyDirs = [];
    const skipped = [];
    const seen = new Set([dir]);
    const stack = [{ dir, base, isRoot: true }];
    const readdirWithTimeout = (d, ms = 30000) => new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve({ err: new Error('readdir timeout') }); } }, ms);
      sftp.readdir(d, (err, list) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(err ? { err } : { list });
      });
    });
    while (stack.length) {
      const batch = stack.splice(0, limit * 8);
      const results = await Promise.all(batch.map(async (item) => {
        const entries = await readdirWithTimeout(item.dir);
        if (entries.err || !entries.list) {
          if (item.isRoot) throw entries.err || new Error(`无法读取目录 ${item.dir}`);
          skipped.push({ dir: item.dir, reason: entries.err ? entries.err.message : 'readdir failed' });
          return null;
        }
        const sub = { files: [], dirs: [] };
        if (!entries.list.length) emptyDirs.push(item.base || '.');
        for (const e of entries.list) {
          const filename = String(e.filename || '').trim();
          if (!filename || filename === '.' || filename === '..') continue;
          const full = item.dir.endsWith('/') ? item.dir + filename : `${item.dir}/${filename}`;
          const name = item.base ? `${item.base}/${filename}` : filename;
          if (e.attrs.isDirectory()) {
            if (!seen.has(full)) { seen.add(full); sub.dirs.push({ dir: full, base: name, isRoot: false }); }
          } else {
            sub.files.push({
              path: full, name, size: e.attrs.size,
              isSymlink: typeof e.attrs.isSymbolicLink === 'function' && e.attrs.isSymbolicLink(),
            });
          }
        }
        return sub;
      }));
      for (const r of results) {
        if (!r) continue;
        files.push(...r.files);
        stack.push(...r.dirs);
      }
    }
    return { files, emptyDirs, skipped };
  }

  getSftpInst() { return this._sftp; }

  // fresh: 通过交互式 shell 执行 pwd (与终端 cwd 一致); 否则优先 OSC7 缓存
  getShellCwd(opts = {}) {
    if (!this.client || this.state !== 'connected') return Promise.resolve(this._shellCwd || null);
    if (opts.fresh && this.stream) return this._queryShellCwdViaPty();
    if (this._shellCwd) return Promise.resolve(this._shellCwd);
    return this._execPwdFallback();
  }

  _execPwdFallback() {
    return new Promise((resolve) => {
      this.client.exec('pwd', (err, stream) => {
        if (err) return resolve(this._shellCwd || null);
        let out = '';
        stream.on('data', (d) => { out += d.toString('utf8'); });
        stream.on('close', () => {
          const lines = out.trim().split(/\r?\n/).filter(Boolean);
          const pwd = lines.length ? lines[lines.length - 1].trim() : null;
          if (pwd && pwd.startsWith('/')) this._shellCwd = pwd;
          resolve(pwd || this._shellCwd || null);
        });
        stream.on('error', () => resolve(this._shellCwd || null));
      });
    });
  }

  _finishPwdCapture(pwd) {
    const cap = this._pwdCapture;
    if (!cap) return;
    clearTimeout(cap.timer);
    this._pwdCapture = null;
    cap.resolve(pwd || this._shellCwd || null);
  }

  _consumeShellData(chunk) {
    if (!this._pwdCapture) {
      return [Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))];
    }
    const cap = this._pwdCapture;
    cap.buf = Buffer.concat([
      cap.buf,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
    ]);
    const text = cap.buf.toString('utf8');
    const re = new RegExp(`${cap.startRe}\\r?\\n([^\\r\\n]+)\\r?\\n${cap.endRe}`);
    const m = re.exec(text);
    if (!m) {
      if (text.length > 16384) {
        const leftover = cap.buf;
        this._finishPwdCapture(null);
        return leftover.length ? [leftover] : [];
      }
      return [];
    }
    const pwd = m[1].trim();
    if (pwd.startsWith('/')) this._shellCwd = pwd;
    const after = text.slice(m.index + m[0].length);
    this._finishPwdCapture(pwd);
    // 探测命令的回显/输出全部丢弃，只放行结束标记之后的数据
    return after ? [Buffer.from(after, 'utf8')] : [];
  }

  _queryShellCwdViaPty(timeoutMs = 3500) {
    if (this._pwdCapture) return Promise.resolve(this._shellCwd || null);
    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const start = `__SSHTERM_PWD_START_${token}__`;
    const end = `__SSHTERM_PWD_END_${token}__`;
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new Promise((resolve) => {
      this._pwdCapture = {
        startRe: esc(start),
        endRe: esc(end),
        buf: Buffer.alloc(0),
        resolve,
        timer: setTimeout(() => {
          if (!this._pwdCapture) return;
          this._finishPwdCapture(null);   // 超时丢弃全部缓冲，不回灌终端
        }, timeoutMs),
      };
      // stty -echo 降低命令回显；服务端仍会过滤 START..END 之间的所有输出
      this.stream.write(
        `{ stty -echo 2>/dev/null; printf '\\n${start}\\n'; pwd; printf '${end}\\n\\n'; stty echo 2>/dev/null; } 2>/dev/null\n`,
      );
    });
  }

  resize(cols, rows) {
    const nextCols = Math.max(2, Math.min(1000, Math.trunc(Number(cols) || 120)));
    const nextRows = Math.max(1, Math.min(500, Math.trunc(Number(rows) || 32)));
    this._ptySize = { cols: nextCols, rows: nextRows };
    if (this.stream) this.stream.setWindow(nextRows, nextCols);
  }

  // ---------- SSH 隧道 / 端口转发 ----------
  // 单会话上限由服务端控制
  _nextTunnelId = 1;
  get tunnels() { return this._tunnels || (this._tunnels = new Map()); }
  _pipeTunnel(tunnel, socket, stream) {
    tunnel.connections++;
    if (!tunnel.active) tunnel.active = new Set();
    tunnel.active.add(socket);
    tunnel.active.add(stream);
    const count = (field) => chunk => { tunnel[field] += chunk.length; };
    socket.on('data', count('txBytes'));
    stream.on('data', count('rxBytes'));
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      tunnel.connections = Math.max(0, tunnel.connections - 1);
      tunnel.active.delete(socket);
      tunnel.active.delete(stream);
    };
    socket.once('close', done);
    stream.once('close', done);
    socket.pipe(stream).pipe(socket);
  }

  _ensureRemoteTunnelDispatcher() {
    if (this._remoteTunnelDispatcher || !this.client) return;
    this._remoteTunnelDispatcher = (info, accept, reject) => {
      for (const tunnel of this.tunnels.values()) {
        if (tunnel.type !== 'remote' || info.destPort !== tunnel.remotePort) continue;
        const socket = net.connect({ host: '127.0.0.1', port: tunnel.localPort });
        socket.once('error', () => { try { reject(); } catch {} });
        socket.once('connect', () => {
          const stream = accept();
          this._pipeTunnel(tunnel, socket, stream);
        });
        return;
      }
      try { reject(); } catch {}
    };
    this.client.on('tcp connection', this._remoteTunnelDispatcher);
  }

  async addTunnel({ type = 'local', localPort, remoteHost, remotePort }) {
    if (this.tunnels.size >= 8) throw new Error('单会话隧道已达上限 8');
    const port = Number(localPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('本地端口无效');
    const id = this._nextTunnelId++;
    const targetPort = type === 'dynamic' ? 0 : Number(remotePort);
    if (type !== 'dynamic' && (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535)) throw new Error('目标端口无效');
    if (type !== 'dynamic' && !/^[a-zA-Z0-9_.:-]+$/.test(String(remoteHost || ''))) throw new Error('目标主机无效');

    if (type === 'remote') {
      // Remote forwarding: the SSH server listens on targetPort and each
      // inbound channel is connected to local 127.0.0.1:port. Never bind an
      // unintended LAN interface on the client.
      await new Promise((resolve, reject) => this.client.forwardIn('127.0.0.1', targetPort, err => err ? reject(err) : resolve()));
      this._ensureRemoteTunnelDispatcher();
      const tunnel = { id, type, localPort: port, remoteHost: '127.0.0.1', remotePort: targetPort, state: 'active', createdAt: Date.now(), rxBytes: 0, txBytes: 0, connections: 0, lastError: '', active: new Set() };
      this.tunnels.set(id, tunnel);
      return { id, type, localPort: port, remoteHost: '127.0.0.1', remotePort: targetPort };
    }

    if (type === 'dynamic') {
      // RFC 1928 CONNECT-only SOCKS5 proxy.  It deliberately listens only on
      // loopback, exposes no UDP/BIND modes, and forwards each approved TCP
      // stream through the already authenticated SSH connection.
      const tunnel = { id, type, localPort: port, remoteHost: 'SOCKS5', remotePort: 0, server: null, state: 'active', createdAt: Date.now(), rxBytes: 0, txBytes: 0, connections: 0, lastError: '', active: new Set() };
      await new Promise((resolve, reject) => {
        const server = net.createServer(socket => {
          let buffer = Buffer.alloc(0);
          let stage = 'greeting';
          const fail = () => { try { socket.end(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch {} };
          const onData = (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (stage === 'greeting') {
              if (buffer.length < 2) return;
              const nMethods = buffer[1];
              if (buffer.length < 2 + nMethods) return;
              if (buffer[0] !== 0x05 || !buffer.subarray(2, 2 + nMethods).includes(0x00)) return fail();
              buffer = buffer.subarray(2 + nMethods);
              socket.write(Buffer.from([0x05, 0x00]));
              stage = 'request';
            }
            if (stage !== 'request' || buffer.length < 4) return;
            const [ver, cmd, , atyp] = buffer;
            if (ver !== 0x05 || cmd !== 0x01) return fail();
            let host, portOffset;
            if (atyp === 0x01) {
              if (buffer.length < 10) return;
              host = [...buffer.subarray(4, 8)].join('.'); portOffset = 8;
            } else if (atyp === 0x03) {
              const len = buffer[4];
              if (!len || buffer.length < 7 + len) return;
              host = buffer.subarray(5, 5 + len).toString('utf8'); portOffset = 5 + len;
            } else if (atyp === 0x04) {
              if (buffer.length < 22) return;
              const groups = []; for (let i = 4; i < 20; i += 2) groups.push(buffer.readUInt16BE(i).toString(16));
              host = groups.join(':'); portOffset = 20;
            } else return fail();
            const dstPort = buffer.readUInt16BE(portOffset);
            if (!host || !dstPort || host.length > 253) return fail();
            const rest = buffer.subarray(portOffset + 2);
            socket.removeListener('data', onData);
            socket.setTimeout(0);
            this.client.forwardOut(socket.remoteAddress || '127.0.0.1', socket.remotePort || 0, host, dstPort, (err, stream) => {
              if (err) return fail();
              socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
              if (rest.length) stream.write(rest);
              this._pipeTunnel(tunnel, socket, stream);
            });
          };
          socket.setTimeout(15000, () => socket.destroy());
          socket.on('error', () => {});
          socket.on('data', onData);
        });
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          tunnel.server = server;
          this.tunnels.set(id, tunnel);
          resolve();
        });
      });
      return { id, type, localPort: port, remoteHost: 'SOCKS5', remotePort: 0 };
    }
    if (type !== 'local') throw new Error('未知隧道类型');
    const tunnel = { id, type, localPort: port, remoteHost, remotePort: targetPort, server: null, state: 'active', createdAt: Date.now(), rxBytes: 0, txBytes: 0, connections: 0, lastError: '', active: new Set() };
    await new Promise((resolve, reject) => {
      const server = net.createServer(socket => {
        this.client.forwardOut(socket.remoteAddress || '127.0.0.1', socket.remotePort || 0, remoteHost, targetPort, (err, stream) => {
          if (err) return socket.destroy();
          this._pipeTunnel(tunnel, socket, stream);
        });
      });
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        tunnel.server = server;
        this.tunnels.set(id, tunnel);
        resolve();
      });
    });
    return { id, type, localPort: port, remoteHost, remotePort: targetPort };
  }

  // ===== 修改点 3: 移除Tunnel改进 =====
  removeTunnel(id) {
    const t = this.tunnels.get(id);
    if (!t) return false;
    try {
      if (t.type === 'remote' && this.client && this._remoteTunnelDispatcher) {
        this.client.unforwardIn('127.0.0.1', t.remotePort, () => {});
      } else if (t.server) {
        t.server.close();
      }
      if (t.active) {
        for (const s of t.active) {
          try { s.destroy ? s.destroy() : s.end(); } catch {}
        }
        t.active.clear();
      }
      t.state = 'closed';
    } catch {}
    this.tunnels.delete(id);
    return true;
  }

  listTunnels() {
    return Array.from(this.tunnels.values()).map(t => ({
      id: t.id, type: t.type, localPort: t.localPort,
      remoteHost: t.remoteHost, remotePort: t.remotePort, state: t.state,
      createdAt: t.createdAt, rxBytes: t.rxBytes, txBytes: t.txBytes,
      connections: t.connections, lastError: t.lastError
    }));
  }

  _disposeResources() {
    if (this._disposed) return;
    this._disposed = true;
    try {
      if (this._tunnels) {
        for (const t of this._tunnels.values()) {
          try {
            if (t.type === 'remote' && this.client && this._remoteTunnelDispatcher) {
              this.client.unforwardIn('127.0.0.1', t.remotePort, () => {});
            } else if (t.server) {
              t.server.close();
            }
            if (t.active) {
              for (const s of t.active) {
                try { s.destroy ? s.destroy() : s.end(); } catch {}
              }
            }
          } catch {}
        }
        this._tunnels = new Map();
      }
      if (this._remoteTunnelDispatcher && this.client) {
        this.client.removeListener('tcp connection', this._remoteTunnelDispatcher);
        this._remoteTunnelDispatcher = null;
      }
      if (this._sftp) { this._sftp.end(); this._sftp = null; }
      if (this.stream) { this.stream.end(); this.stream = null; }
      if (this.client) forceDestroyClient(this.client);
      for (const jump of this.jumpClients || []) { try { jump.end(); } catch {} }
      this.jumpClients = [];
      this.resolveHostKey(false);
      this._prevCpuStat = null;
    } catch (e) { /* 忽略 */ }
  }

  close() {
    if (this.state === 'closing' && this._disposed) return;
    const wasConnected = this.state === 'connected';
    this.state = 'closing';
    this._disposeResources();
    setTimeout(() => this._emitClose('已断开'), 50);
  }

    // 轻量 CPU 占用: 只读 /proc/stat, 供状态栏心跳面积图高频轮询
    async getCpuPct() {
      if (!this.client || this.state !== 'connected') {
        return Promise.reject(new Error('SSH 未连接'));
      }
      if (this._cpuPctPending) return this._cpuPctPending;
      this._cpuPctPending = this._collectCpuPct().finally(() => { this._cpuPctPending = null; });
      return this._cpuPctPending;
    }

    _collectCpuPct() {
      const cmd = "awk '/^cpu /{print $2,$3,$4,$5,$6,$7,$8,$9,$10,$11; exit}' /proc/stat 2>/dev/null";
      return new Promise((resolve, reject) => {
        this.client.exec(cmd, (err, stream) => {
          if (err) return reject(err);
          let buf = '';
          let done = false;
          const finish = (e, data) => {
            if (done) return; done = true;
            if (e) return reject(e);
            resolve(data);
          };
          const timer = setTimeout(() => {
            try { stream.destroy(); } catch {}
            finish(new Error('采集 CPU 超时'));
          }, 4000);
          stream.on('data', (d) => { buf += d.toString('utf8'); });
          stream.stderr.on('data', () => {});
          stream.on('close', () => {
            clearTimeout(timer);
            const cur = parseCpuTicks(`CPUSTAT ${buf.trim()}`);
            const cpuPct = cpuPctBetween(this._prevCpuStat, cur);
            if (cur) this._prevCpuStat = cur;
            finish(null, { cpuPct });
          });
        });
      });
    }

    // ---------- 远端主机状态采集 (RAM / 磁盘挂载 / 负载 / 主机名) ----------
    // 通过 exec 通道执行只读命令, 解析 free/df/loadavg/hostname; 不污染 shell 通道
    // 返回: { memUsed, memTotal, memPct, load1..15, cores, hostname, uptimeSec, disk:[{mp,pct,used,total}] }
    async getHostStats() {
      if (!this.client || this.state !== 'connected') {
        return Promise.reject(new Error('SSH 未连接'));
      }
      if (this._hostStatsPending) return this._hostStatsPending;
      this._hostStatsPending = this._collectHostStats().finally(() => { this._hostStatsPending = null; });
      return this._hostStatsPending;
    }

    _joinRemote(_sftp, oldPath, name) {
      const n = String(name || '');
      if (!n || n === '.' || n === '..' || /[\\/]/.test(n)) throw new Error('名称无效');
      const trimmed = String(oldPath || '').replace(/\/+$/, '');
      const parent = trimmed.includes('/') ? trimmed.replace(/[^/]+$/, '') : '/';
      const dir = parent.endsWith('/') ? parent : `${parent}/`;
      return `${dir}${n}`.replace(/\/{2,}/g, '/');
    }

    _trackOsc7Cwd(chunk) {
      try {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        this._osc7Remain = Buffer.concat([this._osc7Remain || Buffer.alloc(0), data]);
        if (this._osc7Remain.length > 4096) this._osc7Remain = this._osc7Remain.subarray(-2048);
        const text = this._osc7Remain.toString('latin1');
        const re = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
        let m;
        let last = 0;
        while ((m = re.exec(text))) {
          last = m.index + m[0].length;
          const payload = m[1] || '';
          const pathPart = payload.replace(/^file:\/\/[^/]*/, '');
          if (!pathPart) continue;
          try {
            const decoded = decodeURIComponent(pathPart);
            if (decoded.startsWith('/')) this._shellCwd = decoded;
          } catch { /* ignore malformed percent-encoding */ }
        }
        this._osc7Remain = Buffer.from(text.slice(last), 'latin1');
      } catch { /* directory tracking must never break the shell stream */ }
    }

    _collectHostStats() {
      // 单条命令尽量兼容主流 Linux/macOS (BusyBox 也基本支持)
      const script = [
        'echo __SSHTERM_STATS_START__',
        'echo MEMINFO_START',
        'head -n 24 /proc/meminfo 2>/dev/null || true',
        'echo MEMINFO_END',
        'free -b 2>/dev/null | awk \'/Mem:/{printf "MEM %d %d\\n", $3, $2; exit}\' || free | awk \'/Mem:/{printf "MEM %d %d\\n", $3*1024, $2*1024; exit}\'',
        // 1/5/15 分钟负载 + CPU 核数
        'echo LOAD $(cat /proc/loadavg 2>/dev/null | awk \'{print $1" "$2" "$3}\') $(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 0)',
        // 主机名
        'echo HOST $(hostname 2>/dev/null)',
        'echo UPTIME $(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0)',
        // 磁盘/挂载: df -Pk (1K 块), 排除伪文件系统, 输出 挂载点 用量% 可用字节($4) 总量字节($2)
        'echo DISK_START',
        'df -Pk 2>/dev/null | awk \'NR>1 && $1 !~ /tmpfs|devtmpfs|squashfs/ && $6 !~ /\\/dev\\/loop/ { gsub(/%/,"",$5); printf "DISK %s %s %d %d\\n", $6, $5, $4*1024, $2*1024 }\'',
        'echo DISK_END',
        'echo __SSHTERM_STATS_END__',
      ].join('\n');

      return new Promise((resolve, reject) => {
        this.client.exec(script, (err, stream) => {
          if (err) return reject(err);
          let buf = '';
          let done = false;
          const finish = (e, data) => {
            if (done) return; done = true;
            if (e) return reject(e);
            resolve(data);
          };
          const timer = setTimeout(() => {
            try { stream.destroy(); } catch {}
            finish(new Error('采集主机状态超时'));
          }, 8000);
          stream.on('data', (d) => { buf += d.toString('utf8'); });
          stream.stderr.on('data', () => {});
          stream.on('close', () => {
            clearTimeout(timer);
            const start = buf.indexOf('__SSHTERM_STATS_START__');
            const end = buf.indexOf('__SSHTERM_STATS_END__');
            if (start < 0 || end < 0) return finish(new Error('主机状态输出无法解析'));
            const body = buf.slice(start, end);
            const { memUsed, memTotal } = parseRemoteMem(body);
            const load = body.match(/LOAD\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)/);
            const host = body.match(/HOST\s+(.+)/);
            const up = body.match(/UPTIME\s+(\d+)/);
            // 磁盘: 每个 DISK 行 -> 挂载点 用量% 可用($4*1024) 总量($2*1024)
            const disk = [];
            const dStart = body.indexOf('DISK_START');
            const dEnd = body.indexOf('DISK_END');
            if (dStart >= 0 && dEnd >= 0) {
              const dBody = body.slice(dStart, dEnd);
              for (const line of dBody.split('\n')) {
                const m = line.match(/DISK\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)/);
                if (m) disk.push({ mp: m[1], pct: Number(m[2]), avail: Number(m[3]), total: Number(m[4]) });
              }
              // 按用量降序, 取前 5 个真实挂载点 (总量>0)
              disk.sort((a, b) => b.pct - a.pct);
              disk.splice(5);
            }
            finish(null, {
              memUsed,
              memTotal,
              memPct: memTotal > 0 ? Math.round((memUsed / memTotal) * 1000) / 10 : 0,
              load1: load ? Number(load[1]) : 0,
              load5: load ? Number(load[2]) : 0,
              load15: load ? Number(load[3]) : 0,
              cores: load ? Number(load[4]) || 0 : 0,
              hostname: host ? host[1].trim() : '',
              uptimeSec: up ? Number(up[1]) : 0,
              disk,
            });
          });
        });
      });
    }
}

SSHConnection._test = { readyTimeoutFor, connectionErrorMessage, forceDestroyClient, parseRemoteMem, parseCpuTicks, cpuPctBetween };
module.exports = SSHConnection;
