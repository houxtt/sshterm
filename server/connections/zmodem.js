// ZMODEM 接收端 (最小实现): 接收 sz 发送的文件
// 状态机: 检测 ZPAD ZDLE → 帧解析(二进制+HEX) → ZRQINIT/ZFILE/ZDATA/ZEOF/ZFIN
const fs = require('fs');
const path = require('path');
const os = require('os');

const ZPAD = 0x2a, ZDLE = 0x18;
const ZRQINIT = 0, ZRINIT = 1, ZSINIT = 2, ZACK = 3, ZFILE = 4, ZSKIP = 5,
      ZNAK = 6, ZABORT = 7, ZFIN = 8, ZRPOS = 9, ZDATA = 10, ZEOF = 11,
      ZFERR = 12, ZCRC = 13, ZCHALLENGE = 14, ZCOMPL = 15, ZCAN = 16,
      ZFREECNT = 17, ZCOMMAND = 18, ZSTDERR = 19;
// 子包结束标志
const ZCRCE = 0x68, ZCRCG = 0x69, ZCRCQ = 0x42, ZCRCW = 0x43;

// ZMODEM CRC16 (XMODEM 多项式)
function crc16(buf) {
  let crc = 0;
  for (const byte of buf) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
    }
  }
  return crc & 0xffff;
}
// 构造二进制帧: ZPAD ZDLE <type> <fcs_lo> <fcs_hi> <data...>
function makeFrame(type, data) {
  const body = Buffer.concat([Buffer.from([type]), data || Buffer.alloc(0)]);
  const crc = crc16(body);
  return Buffer.concat([Buffer.from([ZPAD, ZDLE]), body,
    Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
}

class ZmodemReceiver {
  constructor(sendFn, onFile) {
    this.send = sendFn;          // 发送字节给远端
    this.onFile = onFile;        // 文件完成回调 (filename, data)
    this.tmpDir = path.join(os.homedir(), '.sshterm', 'zmodem');
    fs.mkdirSync(this.tmpDir, { recursive: true });
    this.reset();
  }
  reset() {
    this.state = 'idle';         // idle | frame
    this.buf = Buffer.alloc(0);
    this.filename = '';
    this.fileData = Buffer.alloc(0);
    this.frameType = -1;
    this.frameData = Buffer.alloc(0);
  }
  // 流数据入口
  feed(data) {
    if (this.state === 'idle') {
      const i = data.indexOf(Buffer.from([ZPAD, ZDLE]));
      if (i < 0) return;
      this.buf = Buffer.concat([this.buf, data.slice(i)]);
      this.state = 'frame';
    } else {
      this.buf = Buffer.concat([this.buf, data]);
    }
    this._parse();
  }

  _parse() {
    // 需要至少 ZPAD ZDLE <type> (3字节) + 模式判断
    if (this.buf.length < 3) return;
    // HEX 模式: ZPAD ZDLE ZDLE; 二进制: ZPAD ZDLE <type>
    let hexMode = false;
    if (this.buf[0] === ZPAD && this.buf[1] === ZDLE && this.buf[2] === ZDLE) {
      hexMode = true;
    }
    if (hexMode) {
      this._parseHex();
    } else {
      this._parseBinary();
    }
  }

  // 二进制帧: ZPAD ZDLE <type> <fcs2> <data...> (ZDLE 转义, 子包结束 ZDLE <ZCRC?>)
  _parseBinary() {
    const b = this.buf;
    if (b.length < 5) return;
    const type = b[2];
    this._fcs = (b[3] | (b[4] << 8));   // 帧头 CRC-16
    this._hexMode = false;
    let i = 5;
    const data = [];
    while (i < b.length) {
      const c = b[i];
      if (c === ZDLE) {
        if (i + 1 >= b.length) { this.buf = b.slice(i); return; }
        const d = b[i + 1];
        if (d === ZDLE) { data.push(ZDLE); i += 2; continue; }
        if (d === ZCRCW || d === ZCRCE || d === ZCRCQ || d === ZCRCZ || d === ZCRCG) {
          this._frameDone(type, Buffer.from(data), d);
          this.buf = b.slice(i + 2);
          return this._parse();
        }
        i += 2;
        continue;
      }
      data.push(c);
      i++;
    }
    this.buf = b;
  }

  // HEX 帧: ZPAD ZDLE ZDLE <type> <fcs4hex> <data hex> <ZDLE CR LF?>
  _parseHex() {
    const b = this.buf;
    if (b.length < 5) return;
    const type = b[3];
    this._fcs = undefined;   // hex 帧暂不校验 CRC
    this._hexMode = true;
    let i = 8;
    const hexs = [];
    while (i < b.length) {
      const c = b[i];
      if (c === ZDLE || c === 0x0d || c === 0x0a) {
        // 帧尾 (ZDLE 或 CR/LF)
        this.buf = b.slice(i + (c === ZDLE ? 1 : 0));
        this._frameDone(type, this._hexDecode(hexs.join('')), -1);
        return this._parse();
      }
      hexs.push(String.fromCharCode(c));
      i++;
    }
    this.buf = b;
  }
  _hexDecode(hexstr) {
    const out = [];
    for (let i = 0; i + 1 < hexstr.length; i += 2) {
      out.push(parseInt(hexstr.slice(i, i + 2), 16));
    }
    return Buffer.from(out);
  }

  // 帧完成处理
  _frameDone(type, data, subType) {
    // 帧头 CRC 校验 (二进制帧, 非 hex 模式)
    if (!this._hexMode && this._fcs !== undefined) {
      const body = Buffer.concat([Buffer.from([type]), data]);
      const calc = crc16(body);
      if (calc !== this._fcs) {
        console.log(`[zmodem] CRC 错误: type=${type} calc=${calc.toString(16)} fcs=${this._fcs.toString(16)}`);
        this.send(Buffer.from([ZPAD, ZDLE, ZNAK, 0x00, 0x00]));
        return;
      }
    }
    this._fcs = undefined;
    console.log(`[zmodem] 帧 type=${type} len=${data.length} sub=${subType} state=${this.state}`);
    if (type === ZRQINIT) {
      // 回 ZRINIT (二进制, flags=0): ZPAD ZDLE 01 <fcs> 00 00 00 00
      const zrinit = makeFrame(ZRINIT, Buffer.from([0x00, 0x00, 0x00, 0x00]));
      this.send(zrinit);
      this.state = 'idle';
    } else if (type === ZFILE) {
      // ZFILE 帧: 文件名 (子包 ZCRCW 带文件名 + 大小)
      const text = data.toString('latin1');
      this.filename = text.split('\0')[0] || 'zmodem_file';
      this.fileData = Buffer.alloc(0);
      if (subType === ZCRCW) {
        // 需要响应 ZACK
        this.send(Buffer.from([ZPAD, ZDLE, ZACK, 0x00, 0x00]));
      }
    } else if (type === ZDATA) {
      // ZDATA 帧: 头后跟子包数据 (ZCRCQ/ZCRCE...)
      if (subType === ZCRCQ) {
        this.fileData = Buffer.concat([this.fileData, data]);
        this.send(Buffer.from([ZPAD, ZDLE, ZACK, 0x00, 0x00]));
      } else {
        this.fileData = Buffer.concat([this.fileData, data]);
      }
    } else if (type === ZEOF) {
      // 文件完成
      if (this.filename && this.fileData.length) {
        this._saveFile();
      }
      this.filename = '';
      this.fileData = Buffer.alloc(0);
    } else if (type === ZFIN) {
      // 会话结束: 回 ZFIN + OO
      this.send(Buffer.from([ZPAD, ZDLE, ZFIN, 0x00, 0x00]));
      this.send(Buffer.from('OO', 'latin1'));
      this.state = 'idle';
    } else if (type === ZCAN || type === ZABORT) {
      this.reset();
    }
  }

  _saveFile() {
    const safe = this.filename.replace(/[\\/]/g, '_');
    const fp = path.join(this.tmpDir, safe);
    try {
      fs.writeFileSync(fp, this.fileData);
      this.onFile && this.onFile(safe, fp, this.fileData.length);
    } catch (e) { /* 忽略 */ }
    this.fileData = Buffer.alloc(0);
  }
}

module.exports = ZmodemReceiver;
