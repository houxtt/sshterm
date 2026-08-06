// e2e 测试: SFTP 文件上传 (PUT 流式) — 真实服务器 192.168.1.216
const { WebSocket } = require('ws');
const http = require('http');
const WS_URL = process.argv[2] || 'ws://127.0.0.1:8787';
const HTTP_BASE = 'http://127.0.0.1:' + (WS_URL.match(/:(\d+)/) || [null, '8787'])[1];
const ws = new WebSocket(WS_URL);

const TABID = 97;
const TEST_FILE = `sshterm_upload_test_${Date.now()}.txt`;
const TEST_CONTENT = 'sshterm upload test ' + Date.now() + '\nline2\n';
let connId = null, gotShell = false, out = '', home = null, verifying = false,
    uploaded = false, verified = false;

ws.binaryType = 'arraybuffer';
ws.on('open', () => {
  console.log('[1] 连接 SSH...');
  ws.send(JSON.stringify({ type: 'connect', id: TABID, session: {
    type: 'ssh', name: '上传测试', host: '192.168.1.216', port: 22,
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
      console.log('[2] shell 就绪, 获取 home...');
      ws.send(JSON.stringify({ type: 'sftp', id: connId, action: 'list', path: '.' }));
    }
  } else {
    const m = JSON.parse(d.toString());
    if (m.type === 'status' && m.id === TABID) console.log('  状态:', m.state);
    if (m.type === 'error' && m.id === TABID) console.log('  [错误]', m.msg);
    if (m.type === 'sftp' && m.action === 'list' && !home) {
      home = m.path;
      console.log(`[3] home: ${home}, 稍等后上传文件 ${TEST_FILE}...`);
      // 延迟确保 sftp 通道就绪
      setTimeout(() => {
        const url = `${HTTP_BASE}/api/sftp/upload?conn=${connId}&path=${encodeURIComponent(home)}&name=${encodeURIComponent(TEST_FILE)}`;
        const req = http.request(url, { method: 'PUT' }, (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => {
            console.log(`[4] 上传响应: ${res.statusCode} ${body}`);
            uploaded = res.statusCode === 200;
            console.log('[5] 验证远端文件存在...');
            verifying = true;
            ws.send(JSON.stringify({ type: 'sftp', id: connId, action: 'list', path: home }));
          });
        });
        req.on('error', (e) => { console.log('❌ 上传请求失败:', e.message); cleanup(1); });
        req.write(TEST_CONTENT);
        req.end();
      }, 1500);
    }
    if (m.type === 'sftp' && m.action === 'list' && verifying) {
      const f = m.entries.find(e => e.name === TEST_FILE);
      if (f) {
        console.log(`[6] ✅ 远端存在: ${f.name} (${f.size}B, 期望 ${TEST_CONTENT.length}B)`);
        verified = f.size === TEST_CONTENT.length;
      } else {
        console.log('[6] ❌ 远端未找到上传文件');
      }
      cleanup(verified ? 0 : 1);
    }
  }
});

function cleanup(code) {
  console.log(`\n=== 汇总: ${uploaded && verified ? '✅ 上传成功且内容完整' : '❌ 失败'} ===`);
  // 清理远端测试文件
  if (home) {
    ws.send(JSON.stringify({ type: 'sftp', id: connId, action: 'list', path: home }));
    // 删除: 通过 shell rm
    setTimeout(() => {
      if (connId) ws.send(JSON.stringify({ type: 'input', id: connId, data: Buffer.from(`rm -f ${home}/${TEST_FILE}\n`).toString('base64') }));
    }, 200);
  }
  ws.send(JSON.stringify({ type: 'disconnect', id: TABID }));
  setTimeout(() => { ws.close(); process.exit(uploaded && verified ? 0 : 1); }, 800);
}
setTimeout(() => { console.log('❌ 超时'); process.exit(1); }, 30000);
