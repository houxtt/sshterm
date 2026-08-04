// 连接抽象基类: 所有协议统一事件/方法接口
// events: 'data'(Buffer) | 'close'(reason) | 'error'(msg) | 'open'()
// methods: write(data) | close() | resize(cols, rows)?
const { EventEmitter } = require('events');

class BaseConnection extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.id = null;          // 服务端分配
    this.state = 'idle';     // idle|connecting|connected|closing|closed
  }

  _emitData(buf) {
    this.emit('data', buf);
  }

  _emitClose(reason = 'closed') {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.emit('close', reason);
  }

  _emitError(msg) {
    this.emit('error', msg);
  }

  // 子类实现
  async connect() { throw new Error('not implemented'); }
  write(data) { throw new Error('not implemented'); }
  close() { throw new Error('not implemented'); }
  resize(cols, rows) { /* 可选 */ }
}

module.exports = BaseConnection;
