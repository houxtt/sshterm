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
    this._loginScan = '';
    this._sbMax = 4096;
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

  _subnegEnd(buf, sbIndex) {
    // Skip IAC IAC inside subnegotiation; only IAC SE ends it.
    let i = sbIndex + 2;
    while (i < buf.length - 1) {
      if (buf[i] !== IAC) { i++; continue; }
      if (buf[i + 1] === IAC) { i += 2; continue; }
      if (buf[i + 1] === SE) return i + 2;
      i++;
    }
    return -1;
  }

  // 处理 IAC 协商: 接受 SGA/NAWS, 拒绝其他 DO; 响应逻辑按标准客户端行为
  _onData(raw) {
    this._buf = Buffer.concat([this._buf, raw]);
    const out = [];
    let i = 0;
    while (i < this._buf.length) {
      const b = this._buf[i];
      if (b !== IAC) { out.push(b); i++; continue; }
      if (i + 1 >= this._buf.length) break;                            // 孤立 IAC, 等下一帧
      const cmd = this._buf[i + 1];
      if (cmd === IAC) { out.push(IAC); i += 2; continue; }             // IAC IAC = 0xFF 数据
      if (cmd === NOP) { i += 2; continue; }
      if (cmd === SE) { i += 2; continue; }
      if (cmd === SB) {
        const end = this._subnegEnd(this._buf, i);
        if (end < 0) {
          if (this._buf.length - i > this._sbMax) this._buf = this._buf.slice(i);
          break;
        }
        const payload = this._buf.subarray(i + 2, end - 2);
        if (payload[0] === OPT_NAWS && payload.length >= 4) {
          // server-initiated NAWS request handled above
        }
        i = end;
        continue;
      }
      if (cmd !== DO && cmd !== DONT && cmd !== WILL && cmd !== WONT) {
        i += 2;
        continue;
      }
      if (i + 2 >= this._buf.length) break;                            // 缺选项字节
      const opt = this._buf[i + 2];
      if (cmd === DO) {
        if (opt === OPT_NAWS) { this._respond([IAC, WILL, OPT_NAWS]); this._sendNaws(); }
        else if (opt === OPT_ECHO) { this._respond([IAC, DO, OPT_ECHO]); }
        else this._respond([IAC, WONT, opt]);
      } else if (cmd === WILL) {
        if (opt === OPT_SGA) { this._respond([IAC, DO, OPT_SGA]); }
        else if (opt === OPT_ECHO) { this._respond([IAC, DO, OPT_ECHO]); }
        else this._respond([IAC, DONT, opt]);
      }
      i += 3;
    }
    this._buf = this._buf.slice(i);
    if (out.length) this._process(out);

    // 自动登录: 跨包拼接提示符 (每个字符一帧时单包无法匹配 login:)
    if (out.length) {
      this._loginScan = (this._loginScan + Buffer.from(out).toString('latin1')).slice(-400);
    }
    const text = this._loginScan.toLowerCase();
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
      this._pendingLogin = false;
    }
  }

  _respond(bytes) {
    try { this.sock.write(Buffer.from(bytes)); } catch (e) { /* 忽略 */ }
  }

  _encodeTelnet(data) {
    const src = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const out = [];
    for (const b of src) {
      out.push(b);
      if (b === IAC) out.push(IAC);
    }
    return Buffer.from(out);
  }

  _telnetByte(value) {
    return value === 255 ? Buffer.from([255, 255]) : Buffer.from([value & 0xff]);
  }

  // 发送窗口尺寸 (NAWS 子协商): 255 必须按 RFC 1073 加倍
  _sendNaws(cols = 80, rows = 24) {
    if (!this.sock || this.state !== 'connected') return;
    try {
      this.sock.write(Buffer.concat([
        Buffer.from([IAC, SB, OPT_NAWS]),
        this._telnetByte((cols >> 8) & 0xff), this._telnetByte(cols & 0xff),
        this._telnetByte((rows >> 8) & 0xff), this._telnetByte(rows & 0xff),
        Buffer.from([IAC, SE]),
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
    if (this.sock && this.state === 'connected') this.sock.write(this._encodeTelnet(data));
  }

  close() {
    if (this.state === 'closed') return;
    this.state = 'closing';
    try { this.sock.end(); this.sock.destroy(); } catch (e) { /* 忽略 */ }
    setTimeout(() => this._emitClose('已断开'), 50);
  }
}

module.exports = TelnetConnection;
