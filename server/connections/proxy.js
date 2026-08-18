// 代理连接: SOCKS5 / HTTP CONNECT → 返回已建立的 socket
const net = require('net');

// 通过代理连接 target: { host, port } → Promise<socket>
// cfg: { type: 'socks5'|'http', host, port, username?, password? }
function connectProxy(target, cfg) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: cfg.host, port: cfg.port });
    sock.setTimeout(10000);
    sock.once('error', reject);

    if (cfg.type === 'socks5') {
      handshakeSocks5(sock, target, cfg).then(
        () => { sock.setTimeout(0); sock.removeListener('error', reject); resolve(sock); },
        (e) => { sock.destroy(); reject(e); });
    } else {
      handshakeHttp(sock, target, cfg).then(
        () => { sock.setTimeout(0); sock.removeListener('error', reject); resolve(sock); },
        (e) => { sock.destroy(); reject(e); });
    }
  });
}

// SOCKS5 handshake with optional RFC 1929 username/password authentication.
function handshakeSocks5(sock, target, cfg) {
  return new Promise((resolve, reject) => {
    let stage = 'method';
    let buf = Buffer.alloc(0);
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeListener('data', onData);
      reject(error);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeListener('data', onData);
      resolve();
    };
    const timer = setTimeout(() => fail(new Error('SOCKS5 握手超时')), 10000);
    const sendConnect = () => {
      const hostBuf = Buffer.from(target.host, 'utf8');
      if (!hostBuf.length || hostBuf.length > 255) return fail(new Error('SOCKS5 目标主机无效'));
      sock.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf,
        Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff]),
      ]));
      stage = 'connect';
    };
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      while (!settled) {
        if (stage === 'method') {
          if (buf.length < 2) return;
          const [version, method] = buf.subarray(0, 2); buf = buf.subarray(2);
          if (version !== 0x05 || method === 0xff) return fail(new Error('SOCKS5 不接受客户端认证方式'));
          if (method === 0x00) { sendConnect(); continue; }
          if (method !== 0x02) return fail(new Error(`不支持的 SOCKS5 认证方式: ${method}`));
          const user = Buffer.from(cfg.username || '', 'utf8');
          const password = Buffer.from(cfg.password || '', 'utf8');
          if (!user.length || user.length > 255 || !password.length || password.length > 255) {
            return fail(new Error('SOCKS5 用户名或密码无效'));
          }
          sock.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([password.length]), password]));
          stage = 'auth';
          continue;
        }
        if (stage === 'auth') {
          if (buf.length < 2) return;
          const [version, status] = buf.subarray(0, 2); buf = buf.subarray(2);
          if (version !== 0x01 || status !== 0x00) return fail(new Error('SOCKS5 用户名或密码认证失败'));
          sendConnect();
          continue;
        }
        if (stage === 'connect') {
          if (buf.length < 5) return;
          const atyp = buf[3];
          const addressLength = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? (buf.length >= 5 ? buf[4] : 0) : -1;
          const frameLength = atyp === 0x03 ? 7 + addressLength : 6 + addressLength;
          if (addressLength < 0 || buf.length < frameLength) return;
          const status = buf[1]; buf = buf.subarray(frameLength);
          if (status !== 0x00) return fail(new Error(`SOCKS5 连接失败 code=${status}`));
          return succeed();
        }
      }
    };
    sock.on('data', onData);
    const hasCredentials = !!(cfg.username || cfg.password);
    sock.write(Buffer.from(hasCredentials ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
  });
}

// HTTP CONNECT 握手
function handshakeHttp(sock, target, cfg) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const auth = (cfg.username && cfg.password)
      ? 'Proxy-Authorization: Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64') + '\r\n'
      : '';
    sock.write(`CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n${auth}\r\n`);
    const onData = (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        sock.removeListener('data', onData);
        const status = buf.match(/HTTP\/1\.[01] (\d+)/);
        if (status && status[1] === '200') resolve();
        else reject(new Error(`HTTP CONNECT 失败: ${buf.split('\r\n')[0]}`));
      }
    };
    sock.on('data', onData);
    setTimeout(() => { reject(new Error('HTTP CONNECT 超时')); }, 10000);
  });
}

module.exports = { connectProxy };
