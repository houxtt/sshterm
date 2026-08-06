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

// SOCKS5 握手 (显式 stage: 0=方法协商, 1=连接请求)
function handshakeSocks5(sock, target, cfg) {
  return new Promise((resolve, reject) => {
    let stage = 0;
    const timer = setTimeout(() => reject(new Error('SOCKS5 握手超时')), 10000);
    const onData = (d) => {
      if (stage === 0 && d.length >= 2) {
        if (d[1] !== 0x00) {
          clearTimeout(timer);
          return reject(new Error('代理需要认证(仅支持无认证 SOCKS5)'));
        }
        // 发送连接请求 (域名类型)
        const hostBuf = Buffer.from(target.host, 'utf8');
        sock.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
          hostBuf,
          Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff]),
        ]));
        stage = 1;
      } else if (stage === 1 && d.length >= 2) {
        clearTimeout(timer);
        if (d[1] !== 0x00) return reject(new Error(`SOCKS5 连接失败 code=${d[1]}`));
        resolve();
      }
    };
    sock.on('data', onData);
    sock.write(Buffer.from([0x05, 0x01, 0x00]));   // 无认证
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
