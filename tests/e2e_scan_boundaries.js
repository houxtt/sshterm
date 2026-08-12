// 网络扫描解析边界：正确 CIDR、跨第三字节范围、过大网段拒绝。
const { WebSocket } = require('ws');
const ws = new WebSocket(process.argv[2] || 'ws://127.0.0.1:8799');
const cases = [
  ['192.168.1.0/30', 4],
  ['192.168.1.254-192.168.2.1', 4],
];
let i = 0;
function next() {
  if (i >= cases.length) {
    ws.send(JSON.stringify({ type: 'scan-net', target: '10.0.0.0/16' }));
    return;
  }
  ws.send(JSON.stringify({ type: 'scan-net', target: cases[i][0] }));
}
ws.on('open', next);
ws.on('message', (raw, binary) => {
  if (binary) return;
  const m = JSON.parse(raw.toString());
  if (m.type === 'scan-net') {
    const [target, expected] = cases[i++];
    if (m.target !== target) { console.error('❌ target 错误'); process.exit(1); }
    console.log(`✅ ${target} 已完成解析/探测`);
    next();
  } else if (m.type === 'error' && /过大/.test(m.msg)) {
    console.log('✅ /16 超大网段被安全拒绝:', m.msg);
    ws.close(); process.exit(0);
  } else if (m.type === 'error') {
    console.error('❌ 非预期错误:', m.msg); process.exit(1);
  }
});
setTimeout(() => { console.error('❌ 扫描边界测试超时'); process.exit(1); }, 30000);
