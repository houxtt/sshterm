// 串口连接 (serialport): 波特率/数据位/停止位/校验位, hex 模式由前端处理
const { SerialPort } = require('serialport');
const BaseConnection = require('./base');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Windows COM10+ (and some USB-UART stacks even for COM1-9) need the
// device namespace.  Other tools open `\\.\COMx`; without it sshterm can
// fail while they succeed.
function winSerialPath(port) {
  const raw = String(port || '').trim();
  const idx = raw.toUpperCase().lastIndexOf('COM');
  const name = idx >= 0 ? raw.slice(idx).toUpperCase() : raw;
  if (!/^COM\d+$/.test(name)) return raw;
  if (process.platform === 'win32') return '\\\\.\\' + name;
  return name;
}

function classifySerialError(err) {
  const msg = String((err && err.message) || err || '');
  const code = err && (err.errno != null ? err.errno : err.code);
  const busy = /access denied|resource busy|in use|sharing violation|eacces|ebusy|eperm/i.test(msg)
    || code === 'EACCES' || code === 'EBUSY' || code === 'EPERM'
    || code === 5 || code === 32 || code === 13;
  const notFound = /not found|enoent|cannot find|the system cannot find/i.test(msg)
    || code === 'ENOENT' || code === 2 || code === 3;
  // ERROR_GEN_FAILURE (31) / ERROR_INVALID_PARAMETER (87) often mean the
  // previous handle has not been released yet, not that another app owns it.
  const retryable = busy || notFound === false && (
    /unknown error code\s*(5|22|31|87)|gen_failure|sem_timeout|i\/o error|interrupted|could not open/i.test(msg)
    || code === 22 || code === 31 || code === 87 || code === 'UNKNOWN'
  );
  return { busy, notFound, retryable: !!retryable && !notFound };
}

async function openWithRetry(openOnce, delays = [0, 200, 500, 1000]) {
  let lastErr;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await sleep(delays[i]);
    try {
      await openOnce();
      return;
    } catch (e) {
      lastErr = e;
      const { retryable } = classifySerialError(e);
      if (!retryable || i === delays.length - 1) throw e;
    }
  }
  throw lastErr;
}

class SerialConnection extends BaseConnection {
  async connect() {
    this.state = 'connecting';
    this._openGeneration = (this._openGeneration || 0) + 1;
    const generation = this._openGeneration;
    const { port, baudRate = 115200, dataBits = 8, stopBits = 1,
            parity = 'none', rtscts = false } = this.config;
    this._writeQueue = [];
    this._writing = false;
    this._writeQueueBytes = 0;
    const MAX_WRITE_QUEUE = 4 * 1024 * 1024;
    const path = winSerialPath(port);
    const openOpts = {
      path, baudRate, dataBits, stopBits, parity, rtscts,
      autoOpen: false, highWaterMark: 64 * 1024,
      hupcl: false,
    };
    if (process.platform !== 'win32') openOpts.lock = false;
    const sp = new SerialPort(openOpts);
    this.sp = sp;
    sp.on('data', (d) => this._emitData(d));
    sp.on('error', (e) => {
      this._emitError(`串口: ${e.message}`);
      if (this.state === 'connected') {
        try { if (sp.isOpen) sp.close(); } catch {}
      }
    });
    sp.on('close', () => {
      if (this.state === 'closing') return;
      this._emitClose('串口已关闭');
    });
    try {
      await openWithRetry(() => new Promise((resolve, reject) => {
        sp.open((err) => err ? reject(err) : resolve());
      }));
    } catch (err) {
      if (generation !== this._openGeneration || this.state === 'closing' || this.state === 'closed') {
        try { if (sp.isOpen) sp.close(); } catch {}
        return;
      }
      const { busy, notFound } = classifySerialError(err);
      const msg = busy
        ? `串口 ${port} 被其他程序占用(如 MobaXterm/串口助手), 可等待重试或强制释放`
        : notFound
          ? `串口 ${port} 不存在(设备未连接或驱动异常)`
          : err.message;
      this._emitError(`串口打开失败: ${msg}`, { occupied: busy });
      this.state = 'closed';
      throw Object.assign(err, { sshtermOccupied: busy });
    }
    if (generation !== this._openGeneration || this.state === 'closing' || this.state === 'closed') {
      try { if (sp.isOpen) sp.close(); } catch {}
      return;
    }
    this.state = 'connected';
    this.emit('open');
  }

  write(data) {
    if (!this.sp || this.state !== 'connected') return false;
    const buf = Buffer.from(data);
    if (this._writeQueueBytes + buf.length > 4 * 1024 * 1024) return false;
    this._writeQueue.push(buf);
    this._writeQueueBytes += buf.length;
    this._drainWrites();
    return true;
  }

  _drainWrites() {
    if (this._writing || !this.sp || !this.sp.isOpen || this.state !== 'connected') return;
    const data = this._writeQueue.shift();
    if (!data) return;
    this._writeQueueBytes = Math.max(0, this._writeQueueBytes - data.length);
    this._writing = true;
    this.sp.write(data, (err) => {
      this._writing = false;
      if (err) {
        this._emitError(`串口写入失败: ${err.message}`);
        this._drainWrites();
      } else this.sp.drain(() => this._drainWrites());
    });
  }

  setSignals(signals) {
    if (!this.sp || !this.sp.isOpen) throw new Error('串口未连接');
    return new Promise((resolve, reject) => this.sp.set(signals, (err) => err ? reject(err) : resolve()));
  }

  sendBreak(duration = 250) {
    if (!this.sp || !this.sp.isOpen) throw new Error('串口未连接');
    return new Promise((resolve, reject) => this.sp.set({ brk: true }, (err) => {
      if (err) return reject(err);
      setTimeout(() => this.sp.set({ brk: false }, (e) => e ? reject(e) : resolve()), duration);
    }));
  }

  close() {
    if (this.state === 'closed') return;
    this._openGeneration = (this._openGeneration || 0) + 1;
    this.state = 'closing';
    this._writeQueue = [];
    this._writeQueueBytes = 0;
    const finish = () => this._emitClose('已断开');
    if (this.sp && this.sp.isOpen) {
      let done = false;
      const once = () => { if (done) return; done = true; finish(); };
      try {
        this.sp.close(() => once());
      } catch {
        once();
        return;
      }
      setTimeout(once, 2000);
      return;
    }
    finish();
  }
}

SerialConnection._test = { winSerialPath, classifySerialError, openWithRetry };
module.exports = SerialConnection;
