// e2e 测试: Zmodem 接收 (sz 文件传输) — 真实服务器 + lrzsz
const { WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WS_URL = process.argv[2] || 'ws://127.0.0.1:8787';
const ws = new WebSocket(WS_URL);

const TABID = 105;
let connId = null, gotShell = false, out = '', sentCmd = false;
let zmReceived = null;

ws.binaryType = 'arraybuffer';
ws.on('open', () => {
  console.log('[1] 连接 SSH...');
  ws.send(JSON.stringify({ type: 'connect', id: TABID, session: {
    type: 'ssh', name: 'Zmodem测试', host: '192.168.1.216', port: 22,
    username: 'logic', auth: 'password', password: '1' } }));
});
ws.on('message', (d, isBinary) => {
  if (isBinary) {
    const buf = new Uint8Array(d);
    if ((buf[0] | (buf[1] << 8)) !== TABID) return;
    out += new TextDecoder().decode(buf.subarray(2));
    if (!gotShell && out.includes('$') && out.length > 100) {
      gotShell = true;
      connId = TABID;
      console.log('[2] shell 就绪, 执行 sz (Zmodem 传输测试文件)...');
      setTimeout(() => {
        // 输入走 binary 帧: [connId 2B][data]
        const payload = new TextEncoder().encode('echo "ZM_E2E_CONTENT_123" > /tmp/zme2e.txt && sz /tmp/zme2e.txt\n');
        const frame = new Uint8Array(2 + payload.length);
        frame[0] = TABID & 0xff; frame[1] = (TABID >> 8) & 0xff;
        frame.set(payload, 2);
        ws.send(frame, { binary: true });
        sentCmd = true;
      }, 800);
    }
  } else {
    const m = JSON.parse(d.toString());
    if (m.type === 'status' && m.id === TABID) console.log('  状态:', m.state);
    if (m.type === 'zmodem') {
      console.log(`[3] ✅ Zmodem 收到文件: ${m.filename} (${m.size}B)`);
      zmReceived = m;
      // 验证文件内容
      setTimeout(() => {
        const fp = path.join(os.homedir(), '.sshterm', 'zmodem', m.filename.replace(/[\\/]/g, '_'));
        fs.readFile(fp, 'utf8', (err, content) => {
          const okContent = !err && content.includes('ZM_E2E_CONTENT_123');
          console.log(`[4] 文件内容验证: ${okContent ? '✅ 完整' : '❌ ' + (err ? err.message : content)}`);
          ws.send(JSON.stringify({ type: 'disconnect', id: TABID }));
          setTimeout(() => { ws.close(); process.exit(okContent ? 0 : 1); }, 400);
        });
      }, 500);
    }
    if (m.type === 'error' && m.id === TABID) console.log('  [错误]', m.msg);
  }
});
setTimeout(() => {
  console.log(sentCmd ? '❌ 超时 (Zmodem 未完成)' : '❌ 连接超时');
  process.exit(1);
}, 25000);
