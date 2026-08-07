// e2e 测试: 网络扫描 (网段设备发现) — 真实局域网
const { WebSocket } = require('ws');
const ws = new WebSocket(process.argv[2] || 'ws://127.0.0.1:8787');
ws.on('open', () => {
  console.log('[1] 网络扫描 192.168.1.210-220...');
  ws.send(JSON.stringify({ type: 'scan-net', target: '192.168.1.210-220' }));
});
ws.on('message', (d, isBinary) => {
  if (isBinary) return;
  const m = JSON.parse(d.toString());
  if (m.type === 'scan-net') {
    console.log('[2] 发现设备数:', m.hosts.length);
    for (const h of m.hosts) console.log('   ', h.ip, '开放:', h.open.join(','));
    const has216 = m.hosts.some(h => h.ip === '192.168.1.216' && h.open.includes(22));
    console.log(`\n=== ${has216 ? '✅ 网络扫描正常 (发现 .216 SSH)' : '❌ 未发现 .216'} ===`);
    ws.close();
    process.exit(has216 ? 0 : 1);
  }
  if (m.type === 'error') { console.log('错误:', m.msg); process.exit(1); }
});
setTimeout(() => { console.log('超时'); process.exit(1); }, 30000);
