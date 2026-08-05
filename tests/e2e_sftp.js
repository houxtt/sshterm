// e2e 测试: SFTP 文件浏览 + 下载 (真实服务器 192.168.1.216)
const { WebSocket } = require('ws');
const http = require('http');
const WS_URL = process.argv[2] || 'ws://127.0.0.1:8787';
const HTTP_BASE = 'http://127.0.0.1:' + (WS_URL.match(/:(\d+)/) || [null, '8787'])[1];
const ws = new WebSocket(WS_URL);

const TABID = 88;
let connId = null, gotShell = false, listed = false, downloaded = false, out = '';

ws.binaryType = 'arraybuffer';
ws.on('open', () => {
  console.log('[1] 连接 SSH (192.168.1.216)...');
  ws.send(JSON.stringify({ type: 'connect', id: TABID, session: {
    type: 'ssh', name: 'SFTP测试', host: '192.168.1.216', port: 22,
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
      console.log('[2] shell 就绪, 请求 SFTP 列目录 /home/logic...');
      ws.send(JSON.stringify({ type: 'sftp', id: connId, action: 'list', path: '/home/logic' }));
    }
  } else {
    const m = JSON.parse(d.toString());
    if (m.type === 'status' && m.id === TABID) console.log('  状态:', m.state);
    if (m.type === 'sftp' && m.action === 'list') {
      listed = true;
      const dirs = m.entries.filter(e => e.isDir).length;
      const files = m.entries.length - dirs;
      console.log(`[3] ✅ SFTP 列目录成功: ${m.path} | ${m.entries.length} 项 (目录${dirs}/文件${files})`);
      console.log('      前 3 项:', m.entries.slice(0, 3).map(e => `${e.isDir ? '📁' : '📄'} ${e.name} (${e.size}B)`).join(' | '));
      // 找一个文件下载
      const file = m.entries.find(e => !e.isDir && e.size > 0);
      if (file) testDownload(file);
      else { console.log('⚠️ 目录无文件可下载'); cleanup(1); }
    }
    if (m.type === 'error' && m.id === TABID) console.log('  [错误]', m.msg);
  }
});

function testDownload(file) {
  const full = `/home/logic/${file.name}`;
  console.log(`[4] 下载测试: ${full} (${file.size}B)...`);
  http.get(`${HTTP_BASE}/api/sftp/download?conn=${connId}&path=${encodeURIComponent(full)}`,
    (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const okSize = buf.length === file.size;
        console.log(`[5] ✅ 下载完成: ${buf.length} 字节 (远端 ${file.size}B, ${okSize ? '大小一致' : '❌ 不一致'})`);
        console.log(`     Content-Disposition: ${res.headers['content-disposition'] || '(无)'}`);
        downloaded = true;
        cleanup(okSize && downloaded ? 0 : 1);
      });
    }).on('error', (e) => { console.log('❌ 下载请求失败:', e.message); cleanup(1); });
}

function cleanup(code) {
  ws.send(JSON.stringify({ type: 'disconnect', id: TABID }));
  setTimeout(() => { ws.close(); process.exit(code); }, 300);
}

setTimeout(() => {
  console.log(listed && downloaded ? '' : '❌ 超时');
  process.exit(listed && downloaded ? 0 : 1);
}, 15000);
