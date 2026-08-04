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

  resize(cols, rows) {
    if (this.stream) this.stream.setWindow(rows, cols);
  }

  close() {
    if (this.state === 'closed') return;
    this.state = 'closing';
    try {
      if (this.stream) { this.stream.end(); this.stream = null; }
      if (this.client) { this.client.end(); }
    } catch (e) { /* 忽略 */ }
    setTimeout(() => this._emitClose('已断开'), 50);
  }
}

module.exports = SSHConnection;
