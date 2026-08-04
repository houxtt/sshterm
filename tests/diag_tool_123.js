// 用工具实际连接 192.168.1.123 (root 无密码), 观察卡点
const TelnetConnection = require('../server/connections/telnet');

async function main() {
  const conn = new TelnetConnection({
    type: 'telnet', name: '123设备', host: '192.168.1.123', port: 23,
    autoLogin: true, loginUser: 'root', loginPass: '',
  });
  let out = '';
  const t0 = Date.now();
  conn.on('data', (d) => {
    out += d.toString('utf8');
    const now = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`[${now}s] 收 ${d.length}B: ${JSON.stringify(d.toString('utf8').slice(0, 60))}\n`);
  });
  conn.on('error', (m) => console.log('[错误]', m));
  conn.on('close', (r) => { console.log('[关闭]', r, '\n--- 总输出 ---\n', out.slice(0, 400)); process.exit(0); });

  try {
    await conn.connect();
    console.log('✓ 连接成功 (autoLogin=true, root, 空密码)');
    console.log('_loginSent:', conn._loginSent, '_pendingLogin:', conn._pendingLogin, '_passSent:', conn._passSent);
    setTimeout(() => {
      console.log('\n3 秒后状态: _loginSent=', conn._loginSent, '_pendingLogin=', conn._pendingLogin, '_passSent=', conn._passSent);
      console.log('--- 已收输出 ---\n', out.slice(0, 300));
      console.log('\n尝试手动发命令确认 shell 是否已就绪...');
      conn.write('echo TOOL_TEST_READY\n');
      setTimeout(() => {
        console.log('\n--- 发命令后输出 ---\n', out.slice(-400));
        console.log('含 TOOL_TEST_READY:', out.includes('TOOL_TEST_READY'));
        conn.close();
        setTimeout(() => process.exit(0), 400);
      }, 2000);
    }, 3000);
  } catch (e) {
    console.log('❌ 连接失败:', e.message);
    process.exit(1);
  }
}
main();
