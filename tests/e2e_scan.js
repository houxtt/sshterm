// e2e 测试: 端口扫描 (真实服务器, 应发现 22 SSH)
const { WebSocket } = require('ws');
const ws = new WebSocket(process.argv[2] || 'ws://127.0.0.1:8787');
ws.on('open', () => {
  console.log('[1] 扫描 192.168.1.216 常见端口...');
  ws.send(JSON.stringify({ type: 'scan', host: '192.168.1.216', ports: [22, 23, 80, 443, 8080, 3389, 5555, 2000] }));
});
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'scan') {
    console.log(`[2] 开放端口: ${m.open.join(', ')}`);
    const ok = m.open.includes(22) && m.open.includes(23);
    console.log(`\n=== 汇总: ${ok ? '✅ 端口扫描正常 (SSH/Telnet 均发现)' : '❌'} ===`);
    ws.close();
    process.exit(ok ? 0 : 1);
  }
  if (m.type === 'error') { console.log('错误:', m.msg); process.exit(1); }
});
setTimeout(() => { console.log('❌ 超时'); process.exit(1); }, 15000);
