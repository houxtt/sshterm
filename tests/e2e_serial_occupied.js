// e2e 测试: 串口被占用 → error 带 occupied 标记 (自占 COM1 制造场景)
const { SerialPort } = require('serialport');
const { WebSocket } = require('ws');
const WS_URL = process.argv[2] || 'ws://127.0.0.1:8787';

// 占住 COM1
console.log('[1] 占住 COM1...');
const blocker = new SerialPort({ path: 'COM1', baudRate: 115200 }, (e) => {
  if (e) { console.log('占位失败:', e.message); process.exit(1); }
  console.log('    COM1 已占用');
  runTest();
});

function runTest() {
  const ws = new WebSocket(WS_URL);
  ws.on('open', () => {
    console.log('[2] sshterm 连接 COM1 (应报占用)...');
    ws.send(JSON.stringify({ type: 'connect', id: 889, session: { type: 'serial', name: '占用验证', port: 'COM1', baudRate: 115200 } }));
  });
  ws.on('message', (d, isBinary) => {
    if (isBinary) return;
    const m = JSON.parse(d.toString());
    console.log('收到:', m.type, '| occupied:', m.occupied, '| msg:', (m.msg || '').slice(0, 60));
    if (m.type === 'error' && m.occupied) {
      console.log('✅ occupied 标记正确');
      blocker.close();
      ws.close();
      process.exit(0);
    }
  });
  setTimeout(() => { console.log('❌ 超时'); blocker.close(); process.exit(1); }, 15000);
}
