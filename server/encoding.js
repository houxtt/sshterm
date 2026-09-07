// 统一编码转换模块 (零第三方依赖)
//
// 问题背景: 浏览器 TextEncoder 只支持 UTF-8; Node Buffer 不识别 'gbk' 编码名。
// 连接配置里的 GBK (嵌入式设备常见) 因此无法贯穿收发链路: 服务端日志解码抛
// "Unknown encoding: gbk" 且异常被吞, 浏览器显示直接写原始字节、输入固定
// UTF-8。这里用 Node 内置 TextDecoder('gbk') 枚举一遍 GBK 双字节区, 反转构造
// Unicode→GBK 编码表 (运行时构建一次并缓存), 无任何第三方依赖。

'use strict';

// 浏览器/Node 支持的 TextDecoder label 与配置里宽松命名的映射
const LABELS = {
  'utf-8': 'utf-8', utf8: 'utf-8', 'unicode-1-1-utf-8': 'utf-8',
  gbk: 'gbk', gb2312: 'gbk', 'gb-2312': 'gbk', 'gb_2312-80': 'gbk',
  'chinese': 'gbk', 'csgb2312': 'gbk',
  gb18030: 'gb18030',
  latin1: 'windows-1252', 'iso-8859-1': 'windows-1252', binary: 'windows-1252',
  ascii: 'windows-1252', 'us-ascii': 'windows-1252',
  big5: 'big5', 'big5-hkscs': 'big5-hkscs',
  'shift_jis': 'shift_jis', sjis: 'shift_jis', 'shift-jis': 'shift_jis', 'windows-31j': 'shift_jis',
  euc_jp: 'euc-jp', eucjp: 'euc-jp',
  euc_kr: 'euc-kr', euckr: 'euc-kr', 'ks_c_5601-1987': 'euc-kr',
};

function decoderLabel(value) {
  const key = String(value == null ? '' : value).trim().toLowerCase();
  return LABELS[key] || 'utf-8';
}

const decoderCache = new Map();
function decoderFor(encoding) {
  const label = decoderLabel(encoding);
  let dec = decoderCache.get(label);
  if (!dec) {
    try { dec = new TextDecoder(label, { fatal: false }); }
    catch { dec = new TextDecoder('utf-8', { fatal: false }); }
    decoderCache.set(label, dec);
  }
  return dec;
}

let gbkEncodeMap = null;
function buildGbkEncodeMap() {
  if (gbkEncodeMap) return gbkEncodeMap;
  const decoder = new TextDecoder('gbk', { fatal: false });
  const map = new Map();
  const leads = [];
  for (let l = 0x81; l <= 0xfe; l++) leads.push(l);          // GBK 首字节区
  const trails = [];
  for (let t = 0x40; t <= 0xfe; t++) if (t !== 0x7f) trails.push(t); // 尾字节区
  // 把所有 (lead,trail) 对拼成一个大 Buffer 一次性解码, 比逐对解码快两个数量级。
  // 首字节不可能等于 0x7f/0x40 以下, 且每对都是完整双字节序列, 解码会按对消费。
  for (const lead of leads) {
    const buf = Buffer.allocUnsafe(trails.length * 2);
    for (let i = 0; i < trails.length; i++) {
      buf[i * 2] = lead;
      buf[i * 2 + 1] = trails[i];
    }
    const text = decoder.decode(buf);
    for (let i = 0; i < trails.length; i++) {
      const ch = text[i];
      if (ch && ch !== '\uFFFD' && !map.has(ch)) map.set(ch, [lead, trails[i]]);
    }
  }
  gbkEncodeMap = map;
  return map;
}

function encodeGbk(value) {
  const map = buildGbkEncodeMap();
  // 任一字符最多 2 字节 (GBK BMP 内); 预分配后再裁剪
  const out = Buffer.allocUnsafe(value.length * 2);
  let n = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code <= 0x7f) { out[n++] = code; continue; }
    const pair = map.get(ch);
    if (pair) { out[n++] = pair[0]; out[n++] = pair[1]; continue; }
    out[n++] = 0x3f; // 未映射字符 → '?' (与 iconv-lite 默认替换策略一致)
  }
  return out.subarray(0, n);
}

// 按会话编码将文本编码为字节; 未知编码回退 UTF-8 (不丢数据)
function encodeText(str, encoding) {
  const value = String(str == null ? '' : str);
  const enc = String(encoding || 'utf-8').trim().toLowerCase();
  if (enc === 'utf-8' || enc === 'utf8' || enc === 'unicode-1-1-utf-8') return Buffer.from(value, 'utf8');
  if (enc === 'ascii' || enc === 'us-ascii') return Buffer.from(value, 'ascii');
  if (enc === 'latin1' || enc === 'binary' || enc === 'iso-8859-1') return Buffer.from(value, 'latin1');
  if (enc === 'gbk' || enc === 'gb2312' || enc === 'gb-2312' || enc === 'chinese' || enc === 'gb18030') {
    return encodeGbk(value);
  }
  return Buffer.from(value, 'utf8');
}

// 按会话编码将字节解码为文本; 未知编码回退 UTF-8
function decodeBuffer(buf, encoding) {
  return decoderFor(encoding).decode(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
}

class StreamingDecoder {
  constructor(encoding) {
    this.decoder = decoderFor(encoding);
    this.tail = new Uint8Array(0);
  }
  decode(chunk) {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!this.tail.length) return this.decoder.decode(input, { stream: true });
    const merged = Buffer.concat([Buffer.from(this.tail), input]);
    this.tail = new Uint8Array(0);
    return this.decoder.decode(merged, { stream: true });
  }
  flush() {
    if (!this.tail.length) return '';
    const out = this.decoder.decode(Buffer.from(this.tail), { stream: false });
    this.tail = new Uint8Array(0);
    return out;
  }
}

module.exports = { encodeText, decodeBuffer, decoderLabel, StreamingDecoder };