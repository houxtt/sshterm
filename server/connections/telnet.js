// Telnet 连接: net socket + 最小 IAC 协商 + 可选自动登录
const net = require('net');
const BaseConnection = require('./base');

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251;
const SB = 250, SE = 240, NOP = 241;
const OPT_ECHO = 1, OPT_SGA = 3, OPT_NAWS = 31;

class TelnetConnection extends BaseConnection {
  constructor(config) {
    super(config);
    this._buf = Buffer.alloc(0);
    this._loginSent = false;
    this._passSent = false;
    this._pendingLogin = false;
  }

  async connect() {
    this.state = 'connecting';
    const { host, port = 23 } = this.config;
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host, port });
      this.sock = sock;
      sock.setKeepAlive(true, 30000);   // TCP keepalive 防空闲断链
      sock.setNoDelay(true);
      // 仅建连阶段超时 (Node 的 socket timeout 是空闲超时, 连接后不能用)
      const connTimer = setTimeout(() => {
        this._emitError('Telnet 连接超时');
        sock.destroy();
        reject(new Error('Telnet 连接超时'));
      }, 10000);
      sock.on('connect', () => {
        clearTimeout(connTimer);
        this.state = 'connected';
        this.emit('open');
        resolve();
      });
      sock.on('data', (d) => this._onData(d));
      sock.on('error', (e) => { clearTimeout(connTimer); this._emitError(`Telnet: ${e.message}`); reject(e); });
      sock.on('close', () => this._emitClose('Telnet 连接已关闭'));
      sock.on('timeout', () => { /* 不设空闲超时, 忽略 */ });
    });
  }

  // 处理 IAC 协商: 接受 SGA/NAWS, 拒绝其他 DO; 响应逻辑按标准客户端行为
  _onData(raw) {
    this._buf = Buffer.concat([this._buf, raw]);
    const out = [];
    let i = 0;
    while (i < this._buf.length) {
      const b = this._buf[i];
      if (b === IAC && i + 1 < this._buf.length) {
        const cmd = this._buf[i + 1];
        if (cmd === IAC) { out.push(IAC); i += 2; continue; }          // IAC IAC = 0xFF 数据
        if (cmd === SE) { i += 2; continue; }                          // 子协商结束标记
        if (cmd === SB) {                                              // 子协商: 跳到 SE
          const se = this._buf.indexOf(IAC, i + 2);
          if (se < 0) break;                                           // 不完整, 等更多数据
          i = se;
          continue;
        }
        const opt = this._buf[i + 2];
        if (cmd === DO) {
          if (opt === OPT_NAWS) { this._respond([IAC, WILL, OPT_NAWS]); this._sendNaws(); }
          else if (opt === OPT_ECHO) { this._respond([IAC, WONT, OPT_ECHO]); }  // 客户端不做回显
          else this._respond([IAC, WONT, opt]);
        } else if (cmd === WILL) {
          if (opt === OPT_SGA) { this._respond([IAC, WILL, OPT_SGA]); }         // 接受 SGA
          else this._respond([IAC, DONT, opt]);
        }
        i += 3;
        continue;
      }
      out.push(b);
      i++;
    }
    this._buf = this._buf.slice(i);
    if (out.length) this._process(out);

    // 自动登录: 匹配提示符
    const text = Buffer.from(out).toString('latin1').toLowerCase();
    const c = this.config;
    if (c.autoLogin && !this._loginSent && /login:/.test(text)) {
      this._loginSent = true;
      this._pendingLogin = true;
      setTimeout(() => this.write((c.loginUser || '') + '\r\n'), 300);
      // 免密兜底: 某些设备(root 无密码)无 Password: 阶段直接进 shell,
      // 2.5s 未收到密码提示则视为免密直进, 重置状态避免卡死
      setTimeout(() => { this._pendingLogin = false; }, 2500);
    } else if (c.autoLogin && this._pendingLogin && !this._passSent && /password:/.test(text)) {
      this._passSent = true;
      this._pendingLogin = false;
      setTimeout(() => this.write((c.loginPass || '') + '\r\n'), 300);
    } else if (this._pendingLogin && /(#|\$|>)\s*$/.test(text)) {
      // 检测到 shell 提示符 → 登录已完成
      this._pendingLogin = false;
    }
  }

  _respond(bytes) {
    try { this.sock.write(Buffer.from(bytes)); } catch (e) { /* 忽略 */ }
  }

  // 发送窗口尺寸 (NAWS 子协商): 嵌入式 telnetd 依赖它确定终端大小
  _sendNaws(cols = 80, rows = 24) {
    if (!this.sock || this.state !== 'connected') return;
    try {
      this.sock.write(Buffer.from([
        IAC, SB, OPT_NAWS,
        (cols >> 8) & 0xff, cols & 0xff,
        (rows >> 8) & 0xff, rows & 0xff,
        IAC, SE,
      ]));
    } catch (e) { /* 忽略 */ }
  }

  resize(cols, rows) {
    if (this.state === 'connected') this._sendNaws(cols, rows);
  }

  _process(data) {
    this._emitData(Buffer.from(data));
  }

  write(data) {
    if (this.sock && this.state === 'connected') this.sock.write(data);
  }

  close() {
    if (this.state === 'closed') return;
    this.state = 'closing';
    try { this.sock.end(); this.sock.destroy(); } catch (e) { /* 忽略 */ }
    setTimeout(() => this._emitClose('已断开'), 50);
  }
}

module.exports = TelnetConnection;
