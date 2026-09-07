'use strict';

// Browser-side encoding helpers (mirrors server/encoding.js without Node Buffer).
const LABELS = {
  'utf-8': 'utf-8', utf8: 'utf-8', gbk: 'gbk', gb2312: 'gbk', gb18030: 'gb18030',
  latin1: 'windows-1252', 'iso-8859-1': 'windows-1252', binary: 'windows-1252',
  ascii: 'windows-1252',
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
  const trails = [];
  for (let t = 0x40; t <= 0xfe; t++) if (t !== 0x7f) trails.push(t);
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    const buf = new Uint8Array(trails.length * 2);
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

function encodeText(str, encoding) {
  const value = String(str == null ? '' : str);
  const enc = String(encoding || 'utf-8').trim().toLowerCase();
  if (enc === 'utf-8' || enc === 'utf8') return new TextEncoder().encode(value);
  if (enc === 'ascii' || enc === 'us-ascii') {
    const out = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0x7f;
    return out;
  }
  if (enc === 'latin1' || enc === 'binary' || enc === 'iso-8859-1') {
    const out = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff;
    return out;
  }
  if (enc === 'gbk' || enc === 'gb2312' || enc === 'gb18030' || enc === 'chinese') {
    const map = buildGbkEncodeMap();
    const parts = [];
    for (const ch of value) {
      const code = ch.codePointAt(0);
      if (code <= 0x7f) parts.push(code);
      else {
        const pair = map.get(ch);
        if (pair) parts.push(pair[0], pair[1]);
        else parts.push(0x3f);
      }
    }
    return Uint8Array.from(parts);
  }
  return new TextEncoder().encode(value);
}

function decodeBuffer(buf, encoding) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return decoderFor(encoding).decode(bytes);
}

class StreamingDecoder {
  constructor(encoding) {
    this.decoder = decoderFor(encoding);
  }
  decode(chunk) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    return this.decoder.decode(bytes, { stream: true });
  }
}

window.SshtermEncoding = { encodeText, decodeBuffer, decoderLabel, StreamingDecoder };
