// 回归测试: 保存的 SSH 会话 → 双击列表重连 (前端脱敏副本) → 应成功
// 覆盖 bug: sanitize 剥密码后, 重连时密码丢失 → "All configured authentication methods failed"
const { WebSocket } = require('ws');
const ws = new WebSocket(process.argv[2] || 'ws://127.0.0.1:8787');
ws.binaryType = 'arraybuffer';

const NAME = '回归-重连测试';
let savedId = null, gotShell = false, gotReply = false, step = 0, out = '';

function nextStep() {
  step++;
  if (step === 1) {
    console.log('[1] 保存带密码的 SSH 会话...');
    ws.send(JSON.stringify({ type: 'save', session: { name: NAME, type: 'ssh',
      host: '192.168.1.216', port: 22, username: 'logic', auth: 'password', password: '1' } }));
  } else if (step === 2) {
    console.log('[2] 模拟双击列表: 用脱敏副本(无密码)连接...');
    ws.send(JSON.stringify({ type: 'connect', id: 55, session: {
      id: savedId, name: NAME, type: 'ssh',
      host: '192.168.1.216', port: 22, username: 'logic', auth: 'password' } }));
  }
}

ws.on('open', () => nextStep());
ws.on('message', (d, isBinary) => {
  if (isBinary) {
    const buf = new Uint8Array(d);
    if ((buf[0] | (buf[1] << 8)) !== 55) return;
    out += new TextDecoder().decode(buf.subarray(2));
    if (!gotShell && out.includes('$') && out.length > 100) {
      gotShell = true;
      console.log('[4] ✅ 重连成功, shell 就绪');
      const p = new TextEncoder().encode('echo RECONNECT_OK\n');
      const f = new Uint8Array(2 + p.length); f[0] = 55 & 255; f[1] = (55 >> 8) & 255; f.set(p, 2);
      ws.send(f, { binary: true });
    }
    if (out.includes('RECONNECT_OK') && !gotReply) {
      gotReply = true;
      console.log('[5] ✅ 输入回显正常, 全链路通');
      ws.send(JSON.stringify({ type: 'disconnect', id: 55 }));
      ws.send(JSON.stringify({ type: 'delete', id: savedId }));
      setTimeout(() => { ws.close(); process.exit(0); }, 400);
    }
  } else {
    const m = JSON.parse(d.toString());
    if (m.type === 'sessions') {
      const s = m.list.find(x => x.name === NAME);
      if (s && !savedId) {
        savedId = s.id;
        console.log('   会话已保存 (列表无密码字段:', !('password' in s), ')');
        nextStep();
      }
    }
    if (m.type === 'status' && m.id === 55) {
      console.log(`[3] 状态: ${m.state}${m.msg ? ' - ' + m.msg : ''}`);
      if (m.state === 'closed' && !gotShell) { console.log('❌ 重连失败'); process.exit(1); }
    }
    if (m.type === 'error' && m.id === 55) console.log('   [错误]', m.msg);
  }
});
setTimeout(() => {
  console.log(gotReply ? '' : '❌ 超时未完成');
  process.exit(gotReply ? 0 : 1);
}, 12000);
