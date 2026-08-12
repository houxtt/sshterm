// 串口连接 (serialport): 波特率/数据位/停止位/校验位, hex 模式由前端处理
const { SerialPort } = require('serialport');
const BaseConnection = require('./base');

class SerialConnection extends BaseConnection {
  async connect() {
    this.state = 'connecting';
    const { port, baudRate = 115200, dataBits = 8, stopBits = 1,
            parity = 'none', rtscts = false } = this.config;
    this._writeQueue = [];
    this._writing = false;
    return new Promise((resolve, reject) => {
      const sp = new SerialPort({
        path: port, baudRate, dataBits, stopBits, parity, rtscts,
        autoOpen: false, highWaterMark: 64 * 1024,
      });
      this.sp = sp;
      sp.open((err) => {
        if (err) {
          const isBusy = /access denied|resource busy|in use/i.test(err.message);
          const isNotFound = /not found|enoent/i.test(err.message);
          const msg = isBusy
            ? `串口 ${port} 被其他程序占用(如 MobaXterm/串口助手), 可等待重试或强制释放`
            : isNotFound
              ? `串口 ${port} 不存在(设备未连接或驱动异常)`
              : err.message;
          this._emitError(`串口打开失败: ${msg}`, { occupied: isBusy });
          return reject(Object.assign(err, { sshtermOccupied: isBusy }));
        }
        this.state = 'connected';
        this.emit('open');
        resolve();
      });
      sp.on('data', (d) => this._emitData(d));
      sp.on('error', (e) => this._emitError(`串口: ${e.message}`));
      sp.on('close', () => this._emitClose('串口已关闭'));
    });
  }

  write(data) {
    if (!this.sp || this.state !== 'connected') return false;
    this._writeQueue.push(Buffer.from(data));
    this._drainWrites();
    return true;
  }

  _drainWrites() {
    if (this._writing || !this.sp || !this.sp.isOpen || this.state !== 'connected') return;
    const data = this._writeQueue.shift();
    if (!data) return;
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
    this.state = 'closing';
    this._writeQueue = [];
    try {
      if (this.sp && this.sp.isOpen) this.sp.close();
    } catch (e) { /* 忽略 */ }
    setTimeout(() => this._emitClose('已断开'), 50);
  }
}

module.exports = SerialConnection;
