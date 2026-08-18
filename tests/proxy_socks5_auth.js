// Unit integration test for RFC 1929 SOCKS5 username/password authentication.
const assert = require('assert');
const net = require('net');
const { connectProxy } = require('../server/connections/proxy');

const server = net.createServer((socket) => {
  let buf = Buffer.alloc(0);
  let stage = 'method';
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (stage === 'method' && buf.length >= 4) {
      assert.deepStrictEqual([...buf.subarray(0, 4)], [5, 2, 0, 2]);
      buf = buf.subarray(4);
      socket.write(Buffer.from([5, 2]));
      stage = 'auth';
    }
    if (stage === 'auth' && buf.length >= 2) {
      const userLen = buf[1];
      if (buf.length < 3 + userLen) return;
      const user = buf.subarray(2, 2 + userLen).toString();
      const passwordLen = buf[2 + userLen];
      if (buf.length < 3 + userLen + passwordLen) return;
      const password = buf.subarray(3 + userLen, 3 + userLen + passwordLen).toString();
      assert.strictEqual(user, 'alice');
      assert.strictEqual(password, 'secret');
      buf = buf.subarray(3 + userLen + passwordLen);
      socket.write(Buffer.from([1, 0]));
      stage = 'connect';
    }
    if (stage === 'connect' && buf.length >= 5) {
      const hostLen = buf[4];
      if (buf.length < 7 + hostLen) return;
      assert.strictEqual(buf.subarray(5, 5 + hostLen).toString(), 'target.internal');
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
      stage = 'done';
    }
  });
});

server.listen(0, '127.0.0.1', async () => {
  try {
    const port = server.address().port;
    const socket = await connectProxy({ host: 'target.internal', port: 22 }, {
      type: 'socks5', host: '127.0.0.1', port, username: 'alice', password: 'secret',
    });
    socket.destroy();
    console.log('✅ SOCKS5 username/password authentication passed');
  } finally {
    server.close();
  }
});
server.on('error', (err) => { console.error(err); process.exitCode = 1; });
