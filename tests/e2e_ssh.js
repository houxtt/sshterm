// 端到端测试 1: SSH 真实连接 (192.168.1.216) + 交互验证
const SSHConnection = require('../server/connections/ssh');

async function main() {
  const conn = new SSHConnection({
    type: 'ssh', host: '192.168.1.216', port: 22,
    username: 'logic', auth: 'password', password: '1',
  });
  let out = Buffer.alloc(0);
  conn.on('data', (d) => { out = Buffer.concat([out, d]); });
  conn.on('error', (m) => console.log('[错误]', m));
  conn.on('close', (r) => console.log('[关闭]', r));

  try {
    await conn.connect();
    console.log('✓ SSH 连接成功, 发送测试命令...');
    conn.write('echo SSHTERM_END_TO_END_OK && hostname && uname -a\n');
    await new Promise(r => setTimeout(r, 3000));
    const text = out.toString('utf8');
    console.log('--- 输出片段 ---');
    console.log(text.slice(-500));
    const ok = text.includes('SSHTERM_END_TO_END_OK');
    console.log(ok ? '\n✅ SSH 端到端: 数据双向流通' : '\n❌ 未找到预期输出');
    conn.close();
    setTimeout(() => process.exit(ok ? 0 : 1), 300);
  } catch (e) {
    console.log('❌ SSH 连接失败:', e.message);
    process.exit(1);
  }
}
main();
