// 串口控制面板回归：验证 UI 字段入参和服务端错误处理不崩。
const { WebSocket } = require('ws');
const ws = new WebSocket(process.argv[2] || 'ws://127.0.0.1:8799');
let got = false;
ws.on('open', () => {
  // 使用不存在的连接 id，服务端应返回可理解错误，而不是崩溃。
  ws.send(JSON.stringify({ type: 'serial-control', id: 655, action: 'break', duration: 250 }));
});
ws.on('message', (raw, binary) => {
  if (binary) return;
  const m = JSON.parse(raw.toString());
  if (m.type === 'error' && /不是串口连接/.test(m.msg)) {
    got = true;
    console.log('✅ 串口 Break/控制路由错误处理正常');
    ws.close();
    process.exit(0);
  }
});
setTimeout(() => { if (!got) { console.error('❌ 串口控制路由未返回预期错误'); process.exit(1); } }, 5000);
