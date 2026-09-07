// 行为测试: 统一编码转换模块 (GBK 收发链路的核心)
// 覆盖: GBK 编码往返、ASCII 透传、未知编码回退、日志解码。
const assert = require('assert');
const { encodeText, decodeBuffer, decoderLabel } = require('../server/encoding');

const zh = '中文 123！';
const gbk = encodeText(zh, 'gbk');
const roundtrip = decodeBuffer(gbk, 'gbk');
assert.strictEqual(roundtrip, zh, 'GBK 编码→解码必须无损往返');
assert.strictEqual(gbk.toString('hex'), 'd6d0cec420313233a3a1',
  '中文 123！ 的 GBK 字节必须正确 (d6d0 中 / cec4 文 / 20 / 313233 / a3a1 ！)');

// ASCII/半角内容按 latin1 透传 (GBK 单字节区兼容 ASCII)
assert.strictEqual(encodeText('hello, sshterm', 'gbk').toString(), 'hello, sshterm');

// 未映射字符用 '?' 替换, 不抛异常
const q = encodeText('\uFFFD\u2028', 'gbk');
assert.ok(q.includes(0x3f), '无法映射的字符替换为 0x3F');

// UTF-8 走 Buffer 快路径
assert.strictEqual(encodeText('abc', 'utf-8').toString(), 'abc');
assert.strictEqual(encodeText('中文', 'utf-8').toString('hex'),
  Buffer.from('中文', 'utf8').toString('hex'));

// latin1 / ascii
assert.strictEqual(encodeText('abc', 'latin1').toString(), 'abc');
assert.strictEqual(encodeText('中文', 'latin1').length, 2, 'latin1 按字节截断');

// 空字符串与 undefined 不抛异常
assert.strictEqual(encodeText('', 'gbk').length, 0);
assert.strictEqual(encodeText(undefined, 'gbk').length, 0);

// 未知编码回退 UTF-8 (不丢数据)
assert.strictEqual(encodeText('中文', 'not-a-real-encoding').toString('hex'),
  Buffer.from('中文', 'utf8').toString('hex'));

// 日志解码: 日志写入不再触发 Unknown encoding
assert.strictEqual(decodeBuffer(Buffer.from('abc'), 'gbk'), 'abc');
assert.strictEqual(decodeBuffer(Buffer.from([0xd6, 0xd0]), 'gbk'), '中');

// decoderLabel 名称归一
assert.strictEqual(decoderLabel('GBK'), 'gbk');
assert.strictEqual(decoderLabel('utf8'), 'utf-8');
assert.strictEqual(decoderLabel('gb2312'), 'gbk');
assert.strictEqual(decoderLabel(undefined), 'utf-8');

console.log('✅ GBK encoding chain contract passed');