// SSH 连接 (ssh2): 密码 / 密钥认证, 交互式 shell
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash } = require('crypto');
const net = require('net');
const { Client } = require('ssh2');
const BaseConnection = require('./base');

const KNOWN_HOSTS_PATH = path.join(os.homedir(), '.sshterm', 'known-hosts.json');
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

class SSHConnection extends BaseConnection {
  async connect() {
    this.state = 'connecting';
    const { host, port = 22, username, auth = 'password',
            password, privateKey, passphrase, proxy } = this.config;
    const cfg = {
      host, port, username, readyTimeout: 10000,
      keepaliveInterval: 15000,   // 15 秒心跳, 防空闲断链(网络设备 idle timeout)
      keepaliveCountMax: 3,       // 连续 3 次无响应才判定连接死亡
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
      const jumpCfg = { host: hop.host, port: hop.port, username: hop.username || jumpAuth?.username || username, readyTimeout: 10000,
        keepaliveInterval: 15000, keepaliveCountMax: 3, hostVerifier: makeHostVerifier(this, `${hop.host}:${hop.port}`) };
      applyAuth(jumpCfg, jumpCredentials);
      if (upstream) jumpCfg.sock = await forwardThrough(upstream, hop.host, hop.port);
      const jump = new Client();
      if (jumpCredentials.auth === 'keyboard-interactive') {
        jump.on('keyboard-interactive', (n, i, l, prompts, finish) => finish(prompts.map(() => jumpCredentials.password || '')));
      }
      await waitReady(jump, jumpCfg);
      this.jumpClients.push(jump);
      upstream = jump;
    }
    if (upstream) cfg.sock = await forwardThrough(upstream, host, port);

    return new Promise((resolve, reject) => {
      const client = new Client();
      this.client = client;
      if (auth === 'keyboard-interactive') {
        client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
          // One password is appropriate for common OTP/password prompts.  For
          // arbitrary MFA challenges the server will reject rather than expose
          // the prompt content to untrusted local pages.
          finish(prompts.map(() => password || ''));
        });
      }
      client.on('ready', () => {
        client.shell({ term: 'xterm-256color', cols: 120, rows: 32 }, (err, stream) => {
          if (err) { this._emitError(`shell: ${err.message}`); return reject(err); }
          this.stream = stream;
          this.state = 'connected';
          stream.on('data', (d) => {
            this._emitData(d);
          });
          stream.on('close', () => {
            this._emitClose('SSH 会话已关闭');
            client.end();
          });
          stream.on('error', (e) => this._emitError(e.message));
          this.emit('open');
          resolve();
        });
      });
      client.on('error', (e) => {
        // 连接建立后中断 vs 建连失败: 给出具体原因
        const msg = this.state === 'connected'
          ? `SSH 连接中断: ${e.message}`
          : `SSH 连接失败: ${e.message}`;
        this._emitError(msg);
        if (this.state !== 'connected') reject(e);
      });
      client.on('close', (hadError) => {
        // 连接建立后 client 关闭: 报告具体原因
        if (this.state === 'connected' || this.state === 'connecting') {
          this._emitClose(hadError
            ? `SSH 连接异常中断(网络问题)`
            : 'SSH 连接已关闭(远端)');
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

  // ---------- SFTP 文件访问 (独立子系统, 与 shell 通道共存) ----------
  getSftp() {
    return new Promise((resolve, reject) => {
      if (this._sftp) return resolve(this._sftp);
      if (!this.client) return reject(new Error('SSH 未连接'));
      this.client.sftp((err, sftp) => {
        if (err) return reject(err);
        this._sftp = sftp;
        resolve(sftp);
      });
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
    const seen = new Set([dir]);
    const stack = [{ dir, base }];
    const readdirWithTimeout = (d, ms = 30000) => new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
      sftp.readdir(d, (err, list) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(err ? null : list);
      });
    });
    while (stack.length) {
      const batch = stack.splice(0, limit * 8);
      const results = await Promise.all(batch.map(async (item) => {
        const entries = await readdirWithTimeout(item.dir);
        if (!entries) return null;                 // 无法读取/超时的目录跳过
        const sub = { files: [], dirs: [] };
        for (const e of entries) {
          const full = item.dir.endsWith('/') ? item.dir + e.filename : `${item.dir}/${e.filename}`;
          const name = item.base ? `${item.base}/${e.filename}` : e.filename;
          if (e.attrs.isDirectory()) {
            if (!seen.has(full)) { seen.add(full); sub.dirs.push({ dir: full, base: name }); }
          } else {
            sub.files.push({ path: full, name, size: e.attrs.size });
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
    return files;
  }

  getSftpInst() { return this._sftp; }

  // 获取 shell 当前目录 (通过 shell 通道发 pwd, 带标记; 终端会显示命令回显)
  // 实现: data 只累积, 轮询解析 (避免事件回调时序问题)
  getShellCwd() {
    if (!this.stream || this.state !== 'connected') return Promise.resolve(null);
    const stream = this.stream;
    const marker = '__SSHTERM_CWD_END__';
    let buf = '';
    const onData = (d) => { buf += d.toString('utf8'); };
    stream.on('data', onData);
    stream.write(`pwd && echo ${marker}\r\n`);
    return new Promise((resolve) => {
      const t0 = Date.now();
      const check = () => {
        const idx = buf.lastIndexOf(marker);
        if (idx >= 0) {
          stream.removeListener('data', onData);
          // 提取绝对路径: 白名单字符 + 至少两级目录 (排除提示符 ~/xxx 的干扰)
          const text = buf.slice(0, idx);
          const match = text.match(/(\/[a-zA-Z0-9_\-\.\/]+)/g) || [];
          const paths = match.filter(p => (p.match(/\//g) || []).length >= 2);
          resolve(paths.length ? paths.reduce((a, b) => (b.length > a.length ? b : a)) : null);
        } else if (Date.now() - t0 > 5000) {
          stream.removeListener('data', onData);
          resolve(null);
        } else {
          setTimeout(check, 50);
        }
      };
      setTimeout(check, 50);
    });
  }

  resize(cols, rows) {
    if (this.stream) this.stream.setWindow(rows, cols);
  }

  // ---------- SSH 隧道 / 端口转发 ----------
  // 单会话上限由服务端控制
  _nextTunnelId = 1;
  get tunnels() { return this._tunnels || (this._tunnels = new Map()); }
  _pipeTunnel(tunnel, socket, stream) {
    tunnel.connections++;
    const count = (field) => chunk => { tunnel[field] += chunk.length; };
    socket.on('data', count('txBytes'));
    stream.on('data', count('rxBytes'));
    const done = () => { tunnel.connections = Math.max(0, tunnel.connections - 1); };
    socket.once('close', done);
    stream.once('close', done);
    socket.pipe(stream).pipe(socket);
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
      const handler = (info, accept, reject) => {
        if (info.destPort !== targetPort) return reject();
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.once('error', () => { try { reject(); } catch {} });
        socket.once('connect', () => {
          const stream = accept();
          this._pipeTunnel(tunnel, socket, stream);
        });
      };
      this.client.on('tcp connection', handler);
      const tunnel = { id, type, localPort: port, remoteHost: '127.0.0.1', remotePort: targetPort, handler, state: 'active', createdAt: Date.now(), rxBytes: 0, txBytes: 0, connections: 0, lastError: '' };
      this.tunnels.set(id, tunnel);
      return { id, type, localPort: port, remoteHost: '127.0.0.1', remotePort: targetPort };
    }

    if (type === 'dynamic') {
      // RFC 1928 CONNECT-only SOCKS5 proxy.  It deliberately listens only on
      // loopback, exposes no UDP/BIND modes, and forwards each approved TCP
      // stream through the already authenticated SSH connection.
      const tunnel = { id, type, localPort: port, remoteHost: 'SOCKS5', remotePort: 0, server: null, state: 'active', createdAt: Date.now(), rxBytes: 0, txBytes: 0, connections: 0, lastError: '' };
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
            if (atyp === 0x01) { // IPv4
              if (buffer.length < 10) return;
              host = [...buffer.subarray(4, 8)].join('.'); portOffset = 8;
            } else if (atyp === 0x03) { // domain
              const len = buffer[4];
              if (!len || buffer.length < 7 + len) return;
              host = buffer.subarray(5, 5 + len).toString('utf8'); portOffset = 5 + len;
            } else if (atyp === 0x04) { // IPv6
              if (buffer.length < 22) return;
              const groups = []; for (let i = 4; i < 20; i += 2) groups.push(buffer.readUInt16BE(i).toString(16));
              host = groups.join(':'); portOffset = 20;
            } else return fail();
            const dstPort = buffer.readUInt16BE(portOffset);
            if (!host || !dstPort || host.length > 253) return fail();
            const rest = buffer.subarray(portOffset + 2);
            socket.removeListener('data', onData);
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
    const tunnel = { id, type, localPort: port, remoteHost, remotePort: targetPort, server: null, state: 'active', createdAt: Date.now(), rxBytes: 0, txBytes: 0, connections: 0, lastError: '' };
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
      if (t.handler) {
        this.client.unforwardIn('127.0.0.1', t.remotePort, () => {});
        this.client.removeListener('tcp connection', t.handler);
      } else if (t.server) {
        t.server.close();
      }
      if (t._remoteStream) t._remoteStream.end();
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

  close() {
      if (this.state === 'closed') return;
      this.state = 'closing';
      try {
        // 关闭所有隧道
        if (this._tunnels) {
          for (const t of this._tunnels.values()) {
            try {
              if (t.handler) {
                this.client.unforwardIn('127.0.0.1', t.remotePort, () => {});
                this.client.removeListener('tcp connection', t.handler);
              } else if (t.server) {
                t.server.close();
              }
            } catch {}
            try { if (t._remoteStream) t._remoteStream.end(); } catch {}
          }
          this._tunnels = new Map();
        }
        if (this._sftp) { this._sftp.end(); this._sftp = null; }
        if (this.stream) { this.stream.end(); this.stream = null; }
      if (this.client) { this.client.end(); }
        for (const jump of this.jumpClients || []) { try { jump.end(); } catch {} }
        this.resolveHostKey(false);
      } catch (e) { /* 忽略 */ }
      setTimeout(() => this._emitClose('已断开'), 50);
    }

    // ---------- ZMODEM 文件发送 ----------
    // 通过 sz 命令发送文件到远端 (终端需要支持 ZMODEM)
    // 用法: conn.sendZmodem(filePath) → 终端会显示文件传输进度
    sendZmodem(filePath) {
      if (!this.stream || this.state !== 'connected') {
        return Promise.reject(new Error('SSH 未连接'));
      }
      // 发送 sz 命令，终端会自动收发 ZMODEM 协议
      const cmd = `sz -vv "${filePath}"
\n`;
      this.stream.write(cmd);
      return Promise.resolve();
    }
  }

module.exports = SSHConnection;
