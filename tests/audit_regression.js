'use strict';

const assert = require('assert');
const { PassThrough } = require('stream');
const { sanitizeSession } = require('../server/session-schema');
const { encodeText, StreamingDecoder } = require('../server/encoding');
const { receiveParallelUpload } = require('../server/sftp-transfer');
const { parseOpenSSHConfig } = require('../server/session-backup');

(async () => {
  // F01 serial port preserved
  {
    const out = sanitizeSession({ type: 'serial', name: 'audit', port: 'COM27', port2: 'COM27' });
    assert.strictEqual(out.port, 'COM27');
    assert.strictEqual(out.port2, 'COM27');
  }

  // F02 proxy type and jump auth preserved
  {
    const out = sanitizeSession({
      type: 'ssh', name: 'audit', host: 'target',
      proxy: { type: 'socks5', host: 'proxy', port: 1080, username: 'u', password: 'fake' },
      jumpAuth: { auth: 'key', username: 'jump', privateKey: 'fake-path' },
      group: 'lab', autoCmds: ['ls'], hexMode: true,
    });
    assert.strictEqual(out.proxy.type, 'socks5');
    assert.strictEqual(out.proxy.username, 'u');
    assert.strictEqual(out.jumpAuth.auth, 'key');
    assert.strictEqual(out.jumpAuth.username, 'jump');
    assert.strictEqual(out.group, 'lab');
    assert.deepStrictEqual(out.autoCmds, ['ls']);
    assert.strictEqual(out.hexMode, true);
  }

  // F07 upload close error propagated
  {
    const sftp = {
      open: (_p, _f, _m, cb) => cb(null, 'h1'),
      write: (_h, buf, _o, len, _pos, cb) => cb(null, len),
      close: (_h, cb) => cb(new Error('remote flush failed')),
    };
    const req = new PassThrough();
    const { promise } = receiveParallelUpload(req, sftp, '/tmp/a', {});
    req.end(Buffer.from('test'));
    await assert.rejects(promise, /remote flush failed/);
  }

  // F09 GBK input bytes + streaming decode
  {
    const gbk = encodeText('中', 'gbk');
    assert.strictEqual(gbk.toString('hex'), 'd6d0');
    const dec = new StreamingDecoder('gbk');
    assert.strictEqual(dec.decode(Buffer.from([0xd6])), '');
    assert.strictEqual(dec.decode(Buffer.from([0xd0])), '中');
  }

  // F18 HTTP proxy banner preserved (header/body split)
  {
    const buf = Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\nSSH-2.0-audit\r\n', 'latin1');
    const marker = buf.indexOf('\r\n\r\n');
    assert.ok(marker >= 0);
    assert.strictEqual(buf.subarray(marker + 4).toString('latin1'), 'SSH-2.0-audit\r\n');
  }

  // F31 OpenSSH Match block skipped
  {
    const entries = parseOpenSSHConfig([
      'Host app',
      '  HostName app.internal',
      '  User normal',
      'Match User root',
      '  User root',
    ].join('\n'));
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].username, 'normal');
  }

  console.log('✅ audit regression contract passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
