// 最终验证: 完整 WS 链路 (模拟前端行为)
// connect(SSH) → status → binary 数据流 → binary 输入 → 回显
const { WebSocket } = require('ws');
const ws = new WebSocket(process.argv[2] || 'ws://127.0.0.1:8787');
ws.binaryType = 'arraybuffer';

const TABID = 42;   // 模拟前端分配的标签 id
let gotData = false, gotReply = false;

ws.on('open', () => {
  console.log('[1] 发起 SSH 连接 (192.168.1.216)...');
  ws.send(JSON.stringify({ type: 'connect', id: TABID, session: {
    type: 'ssh', name: '联调测试', host: '192.168.1.216', port: 22,
    username: 'logic', auth: 'password', password: '1' } }));
});

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    const buf = new Uint8Array(data);
    const id = buf[0] | (buf[1] << 8);
    if (id !== TABID) return;
    const text = new TextDecoder().decode(buf.subarray(2));
    if (!gotData) {
      gotData = true;
      console.log('[4] ✅ 收到远端数据 (binary 路由正确):', JSON.stringify(text.trim().slice(0, 50)));
      console.log('[5] 发送输入: echo WS_CHAIN_OK');
      const payload = new TextEncoder().encode('echo WS_CHAIN_OK\n');
      const frame = new Uint8Array(2 + payload.length);
      frame[0] = TABID & 0xff; frame[1] = (TABID >> 8) & 0xff;
      frame.set(payload, 2);
      ws.send(frame, { binary: true });
    }
    if (text.includes('WS_CHAIN_OK') && !gotReply) {
      gotReply = true;
      console.log('[6] ✅ 输入回显收到, 双向链路完整');
      ws.send(JSON.stringify({ type: 'disconnect', id: TABID }));
      setTimeout(() => { ws.close(); process.exit(0); }, 300);
    }
  } else {
    const m = JSON.parse(data.toString());
    if (m.type === 'status' && m.id === TABID) {
      console.log(`[2→3] 状态: ${m.state} — ${m.msg || ''}`);
      if (m.state === 'connected') gotConnected = true;
    }
    if (m.type === 'error') console.log('  [错误]', m.msg);
  }
});

setTimeout(() => {
  console.log(gotConnected && gotData ? '⚠️ 链路基本通但回显超时' : '❌ 链路未完成');
  process.exit(1);
}, 15000);
