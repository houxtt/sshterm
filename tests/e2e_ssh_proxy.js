// e2e 测试: SSH 通过 SOCKS5 代理连接 (内置最小 SOCKS5 服务器验证握手)
const net = require('net');
const { WebSocket } = require('ws');
const WS_URL = process.argv[2] || 'ws://127.0.0.1:8787';

// 最小 SOCKS5 服务器 (无认证, 转发到目标)
function startSocks5() {
  return new Promise((resolve) => {
    const srv = net.createServer((client) => {
      let stage = 0;
      client.on('data', (d) => {
        try {
          if (stage === 0) {
            client.write(Buffer.from([0x05, 0x00]));   // 方法协商: 无认证
            stage = 1;
          } else if (stage === 1) {
            const atyp = d[3];
            let host, port;
            if (atyp === 0x03) {                        // 域名
              const len = d[4];
              host = d.slice(5, 5 + len).toString('utf8');
              port = d.readUInt16BE(5 + len);
            } else if (atyp === 0x01) {                 // IPv4
              host = [...d.slice(4, 8)].join('.');
              port = d.readUInt16BE(8);
            } else { client.destroy(); return; }
            const target = net.connect({ host, port }, () => {
              client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));  // success
              stage = 2;
              client.pipe(target);
              target.pipe(client);
            });
            target.on('error', () => client.destroy());
          }
        } catch (e) { client.destroy(); }
      });
      client.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  const proxy = await startSocks5();
  const proxyPort = proxy.address().port;
  console.log(`[0] 测试 SOCKS5 代理已启动: 127.0.0.1:${proxyPort}`);

  const ws = new WebSocket(WS_URL);
  const TABID = 101;
  let gotShell = false, out = '';
  ws.binaryType = 'arraybuffer';
  ws.on('open', () => {
    console.log('[1] 通过代理连接 SSH 192.168.1.216...');
    ws.send(JSON.stringify({ type: 'connect', id: TABID, session: {
      type: 'ssh', name: '代理测试', host: '192.168.1.216', port: 22,
      username: 'logic', auth: 'password', password: '1',
      proxy: { type: 'socks5', host: '127.0.0.1', port: proxyPort },
    } }));
  });
  ws.on('message', (d, isBinary) => {
    if (isBinary) {
      const buf = new Uint8Array(d);
      if ((buf[0] | (buf[1] << 8)) !== TABID) return;
      out += new TextDecoder().decode(buf.subarray(2));
      if (!gotShell && out.includes('$') && out.length > 100) {
        gotShell = true;
        console.log('[2] ✅ SOCKS5 代理连接成功, shell 就绪');
        ws.send(JSON.stringify({ type: 'disconnect', id: TABID }));
        proxy.close();
        setTimeout(() => { ws.close(); process.exit(0); }, 400);
      }
    } else {
      const m = JSON.parse(d.toString());
      if (m.type === 'status' && m.id === TABID) console.log('  状态:', m.state, m.msg || '');
      if (m.type === 'error' && m.id === TABID) { console.log('  [错误]', m.msg); proxy.close(); process.exit(1); }
    }
  });
  setTimeout(() => {
    console.log(gotShell ? '' : '❌ 超时');
    proxy.close();
    process.exit(gotShell ? 0 : 1);
  }, 20000);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
