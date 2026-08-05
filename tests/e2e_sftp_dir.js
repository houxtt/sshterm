// e2e 测试: SFTP 目录打包下载 (递归 zip) — 真实服务器 192.168.1.216
const { WebSocket } = require('ws');
const http = require('http');
const WS_URL = process.argv[2] || 'ws://127.0.0.1:8787';
const HTTP_BASE = 'http://127.0.0.1:' + (WS_URL.match(/:(\d+)/) || [null, '8787'])[1];
const ws = new WebSocket(WS_URL);

const TABID = 89;
let connId = null, gotShell = false, out = '';
let homePath = null, zipOk = false;

ws.binaryType = 'arraybuffer';
ws.on('open', () => {
  console.log('[1] 连接 SSH...');
  ws.send(JSON.stringify({ type: 'connect', id: TABID, session: {
    type: 'ssh', name: 'SFTP目录测试', host: '192.168.1.216', port: 22,
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
      console.log('[2] shell 就绪, 获取 home 路径...');
      ws.send(JSON.stringify({ type: 'sftp', id: connId, action: 'list', path: '.' }));
    }
  } else {
    const m = JSON.parse(d.toString());
    if (m.type === 'status' && m.id === TABID) console.log('  状态:', m.state);
    if (m.type === 'error' && m.id === TABID) console.log('  [错误]', m.msg);
    if (m.type === 'sftp' && m.action === 'list' && !homePath) {
      homePath = m.path;
      console.log(`[3] home: ${m.path}`);
      // 用小目录验证功能 (1221 大目录 1.3 万文件需数分钟, 单独验证)
      const dir = m.entries.find(e => e.isDir && e.name === '.ai_completion') ||
                  m.entries.find(e => e.isDir && !e.name.startsWith('.'));
      if (!dir) { console.log('⚠️ 无子目录'); cleanup(1); return; }
      console.log(`[4] 打包下载目录: ${homePath}/${dir.name} ...`);
      http.get(`${HTTP_BASE}/api/sftp/download-dir?conn=${connId}&path=${encodeURIComponent(`${homePath}/${dir.name}`)}`,
        (res) => {
          const chunks = [];
          let total = 0;
          res.on('data', c => { chunks.push(c); total += c.length; });
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;   // 'PK'
            const cd = res.headers['content-disposition'] || '';
            console.log(`[5] 收到 ${total} 字节 | Content-Type: ${res.headers['content-type']}`);
            console.log(`    Content-Disposition: ${cd}`);
            console.log(`    ZIP 格式校验: ${isZip ? '✅ (PK 头)' : '❌'}`);
            zipOk = isZip && total > 0;
            cleanup(zipOk ? 0 : 1);
          });
        }).on('error', (e) => { console.log('❌ 下载失败:', e.message); cleanup(1); });
    }
  }
});

function cleanup(code) {
  console.log(`\n=== 汇总: ${zipOk && code === 0 ? '✅ 目录 zip 下载成功' : '❌ 失败'} ===`);
  ws.send(JSON.stringify({ type: 'disconnect', id: TABID }));
  setTimeout(() => { ws.close(); process.exit(zipOk && code === 0 ? 0 : 1); }, 300);
}
setTimeout(() => { console.log('❌ 超时'); process.exit(1); }, 90000);
