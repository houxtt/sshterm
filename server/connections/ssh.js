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

  // 列出目录: 返回 [{name, isDir, size, mtime}]
  async sftpList(dir) {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      sftp.readdir(dir, (err, list) => {
        if (err) return reject(err);
        resolve(list.map(f => ({
          name: f.filename,
          isDir: f.attrs.isDirectory(),
          size: f.attrs.size,
          mtime: f.attrs.mtime * 1000,   // sftp 返回秒, 转 ms
        })).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name)));
      });
    });
  }

  sftpCreateReadStream(remotePath) {
    return this.getSftp().then(sftp => sftp.createReadStream(remotePath));
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
