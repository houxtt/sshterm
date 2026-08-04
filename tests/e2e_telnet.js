// 端到端测试 2: Telnet (本地模拟 telnetd: IAC 协商 + 自动登录)
const net = require('net');
const TelnetConnection = require('../server/connections/telnet');

const IAC=255, DO=253, WILL=251, ECHO=1;

// ---- 模拟 telnetd ----
let iacOk = false, loginOk = false, cmdOk = false;
const mockServer = net.createServer((sock) => {
  sock.write(Buffer.from([IAC, DO, ECHO]));            // 服务器要求回显
  setTimeout(() => sock.write('telnetd-embedded login: '), 200);
  let authed = false;
  sock.on('data', (d) => {
    const t = d.toString('utf8');
    if (!authed) {
      if (/root/.test(t)) { authed = true; setTimeout(() => sock.write('Password: '), 150); }
      return;
    }
    if (/pass123/.test(t)) {
      loginOk = true;
      setTimeout(() => sock.write('\r\nBusyBox v1.36 #1\r\n/ # '), 200);
      return;
    }
    if (/echo TELNET_OK/.test(t)) {
      cmdOk = true;
      sock.write('TELNET_OK\r\n/ # ');
    } else if (/^exit/.test(t)) sock.end();
  });
  // 检测客户端是否回 WONT (IAC 协商正确)
  const orig = sock.write.bind(sock);
});
const srv = mockServer.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  console.log(`[mock telnetd] 127.0.0.1:${port}  (发出 IAC DO ECHO + login 提示)`);

  const conn = new TelnetConnection({
    type: 'telnet', host: '127.0.0.1', port,
    autoLogin: true, loginUser: 'root', loginPass: 'pass123',
  });
  let out = '';
  conn.on('data', (d) => { out += d.toString('utf8'); });
  conn.on('error', (m) => console.log('[错误]', m));

  try {
    await conn.connect();
    console.log('✓ Telnet 连接成功, 等待自动登录...');
    await new Promise(r => setTimeout(r, 2500));
    conn.write('echo TELNET_OK\n');
    await new Promise(r => setTimeout(r, 1200));
    console.log('--- 输出片段 ---');
    console.log(out.slice(-400));
    const ok = loginOk && cmdOk;
    console.log(ok ? '\n✅ Telnet 端到端: IAC 协商 + 自动登录 + 命令回显 全部通过'
                   : `\n❌ 部分失败 login=${loginOk} cmd=${cmdOk}`);
    conn.close();
    srv.close();
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.log('❌ Telnet 连接失败:', e.message);
    srv.close(); process.exit(1);
  }
});
