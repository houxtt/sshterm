// e2e 测试: SFTP 断点续传 (HEAD 检测) + 分块写入 (offset PUT) — 真实服务器
const { WebSocket } = require('ws');
const http = require('http');
const WS_URL = process.argv[2] || 'ws://127.0.0.1:8787';
const HTTP_BASE = 'http://127.0.0.1:' + (WS_URL.match(/:(\d+)/) || [null, '8787'])[1];
const ws = new WebSocket(WS_URL);

const TABID = 103;
const FILE = `sshterm_resume_${Date.now()}.bin`;
let connId = null, gotShell = false, out = '', home = null;

function putChunk(path, name, offset, content) {
  return new Promise((resolve) => {
    const url = `${HTTP_BASE}/api/sftp/upload?conn=${connId}&path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}&offset=${offset}`;
    const req = http.request(url, { method: 'PUT' }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.write(content);
    req.end();
  });
}
function headSize(path, name) {
  return new Promise((resolve) => {
    const url = `${HTTP_BASE}/api/sftp/upload?conn=${connId}&path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`;
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      resolve({ status: res ? res.statusCode : 0, size: res ? parseInt(res.headers['x-remote-size'] || '0', 10) : 0 });
    };
    const req = http.request(url, { method: 'HEAD' }, (res) => {
      res.on('data', () => {});
      res.on('end', () => finish(res));
      res.on('close', () => finish(res));
    });
    req.on('error', () => finish(null));
    req.end();
    setTimeout(() => finish(null), 6000);
  });
}

ws.binaryType = 'arraybuffer';
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'connect', id: TABID, session: {
    type: 'ssh', name: '续传测试', host: '192.168.1.216', port: 22,
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
      console.log('[1] shell 就绪, 获取 home...');
      ws.send(JSON.stringify({ type: 'sftp', id: connId, action: 'list', path: '.' }));
    }
  } else {
    const m = JSON.parse(d.toString());
    if (m.type === 'sftp' && m.action === 'list' && !home) {
      home = m.path;
      console.log(`[2] home: ${home}, 分块写入测试...`);
      setTimeout(async () => {
        // 分块 1: offset=0 写 "ABCDEFG"
        const r1 = await putChunk(home, FILE, 0, 'ABC');
        console.log(`[3] 块1(offset=0, 'ABC'): ${r1.status} ${r1.body}`);
        // 分块 2: offset=3 续写 "DEFG"
        const r2 = await putChunk(home, FILE, 3, 'DEFG');
        console.log(`[4] 块2(offset=3, 'DEFG'): ${r2.status} ${r2.body}`);
        // HEAD 检查大小
        const h = await headSize(home, FILE);
        console.log(`[5] HEAD 远端大小: ${h.status} → ${h.size}B (期望 7B)`);
        // 模拟前端续传判断: 远端 size >= 本地 → 跳过
        const resumeSkip = h.size >= 7;
        // 验证内容: 下载检查
        await verifyContent();
        const ok = r1.status === 200 && r2.status === 200 && h.size === 7 && resumeSkip;
        console.log(`\n=== 汇总: ${ok ? '✅ 断点续传/分块写入正常' : '❌ 失败'} ===`);
        cleanup(ok ? 0 : 1);
      }, 1500);
    }
  }
});
function verifyContent() {
  return new Promise((resolve) => {
    http.get(`${HTTP_BASE}/api/sftp/download?conn=${connId}&path=${encodeURIComponent(home + '/' + FILE)}`, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const content = Buffer.concat(chunks).toString('utf8');
        console.log(`[6] 下载校验: "${content}" ${content === 'ABCDEFG' ? '✅ 合并完整' : '❌ 不完整'}`);
        resolve();
      });
    });
  });
}
function cleanup(code) {
  if (connId) {
    const b = Buffer.from(`rm -f ${home}/${FILE}\n`).toString('base64');
    ws.send(JSON.stringify({ type: 'input', id: connId, data: b }));
  }
  ws.send(JSON.stringify({ type: 'disconnect', id: TABID }));
  setTimeout(() => { ws.close(); process.exit(code); }, 600);
}
setTimeout(() => { console.log('❌ 超时'); process.exit(1); }, 30000);
