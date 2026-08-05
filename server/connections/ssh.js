// SSH 连接 (ssh2): 密码 / 密钥认证, 交互式 shell
const fs = require('fs');
const { Client } = require('ssh2');
const BaseConnection = require('./base');

class SSHConnection extends BaseConnection {
  async connect() {
    this.state = 'connecting';
    const { host, port = 22, username, auth = 'password',
            password, privateKey, passphrase } = this.config;
    const cfg = { host, port, username, readyTimeout: 10000 };

    if (auth === 'key') {
      cfg.privateKey = fs.readFileSync(privateKey);
      if (passphrase) cfg.passphrase = passphrase;
    } else {
      cfg.password = password;
    }

    return new Promise((resolve, reject) => {
      const client = new Client();
      this.client = client;
      client.on('ready', () => {
        client.shell({ term: 'xterm-256color', cols: 120, rows: 32 }, (err, stream) => {
          if (err) { this._emitError(`shell: ${err.message}`); return reject(err); }
          this.stream = stream;
          this.state = 'connected';
          stream.on('data', (d) => this._emitData(d));
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
        this._emitError(`SSH 连接失败: ${e.message}`);
        reject(e);
      });
      client.connect(cfg);
    });
  }

  write(data) {
    if (this.stream) this.stream.write(data);
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

  resize(cols, rows) {
    if (this.stream) this.stream.setWindow(rows, cols);
  }

  close() {
    if (this.state === 'closed') return;
    this.state = 'closing';
    try {
      if (this._sftp) { this._sftp.end(); this._sftp = null; }
      if (this.stream) { this.stream.end(); this.stream = null; }
      if (this.client) { this.client.end(); }
    } catch (e) { /* 忽略 */ }
    setTimeout(() => this._emitClose('已断开'), 50);
  }
}

module.exports = SSHConnection;
