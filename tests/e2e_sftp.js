// e2e 测试: SFTP 浏览(进入/返回) + 下载, 验证绝对路径一致性 (真实服务器 192.168.1.216)
const { WebSocket } = require('ws');
const http = require('http');
const WS_URL = process.argv[2] || 'ws://127.0.0.1:8787';
const HTTP_BASE = 'http://127.0.0.1:' + (WS_URL.match(/:(\d+)/) || [null, '8787'])[1];
const ws = new WebSocket(WS_URL);

const TABID = 88;
let connId = null, gotShell = false, out = '';
let homePath = null, subDirPath = null, backPath = null, downloaded = false;

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
      console.log('[2] shell 就绪, 列目录 "." (应返回绝对路径)...');
      ws.send(JSON.stringify({ type: 'sftp', id: connId, action: 'list', path: '.' }));
    }
  } else {
    const m = JSON.parse(d.toString());
    if (m.type === 'status' && m.id === TABID) console.log('  状态:', m.state);
    if (m.type === 'error' && m.id === TABID) console.log('  [错误]', m.msg);
    if (m.type === 'sftp' && m.action === 'list') {
      if (!homePath) {
        homePath = m.path;
        console.log(`[3] ✅ home 绝对路径: ${m.path} | ${m.entries.length} 项`);
        const dir = m.entries.find(e => e.isDir && !e.name.startsWith('.'));
        if (!dir) { console.log('⚠️ 无子目录可测'); cleanup(1); return; }
        console.log(`[4] 进入子目录: ${dir.name}...`);
        ws.send(JSON.stringify({ type: 'sftp', id: connId, action: 'list', path: `${homePath}/${dir.name}` }));
      } else if (!subDirPath) {
        subDirPath = m.path;
        console.log(`[5] ✅ 子目录路径: ${m.path} | ${m.entries.length} 项`);
        const expectSub = `${homePath}/${m.path.split('/').pop()}`;
        console.log(`    路径为绝对且正确: ${m.path === expectSub ? '✅' : '❌ 期望 ' + expectSub}`);
        console.log('[6] 返回上级...');
        ws.send(JSON.stringify({ type: 'sftp', id: connId, action: 'list', path: m.path.slice(0, m.path.lastIndexOf('/')) }));
      } else {
        backPath = m.path;
        console.log(`[7] ✅ 返回上级路径: ${m.path}`);
        console.log(`    与 home 一致: ${m.path === homePath ? '✅' : '❌ 期望 ' + homePath}`);
        // 下载验证
        const file = m.entries.find(e => !e.isDir && e.size > 0);
        if (file) testDownload(file);
        else { console.log('⚠️ 无文件可下载'); cleanup(0); }
      }
    }
  }
});

function testDownload(file) {
  const full = `${homePath}/${file.name}`;
  console.log(`[8] 下载: ${full} (${file.size}B)...`);
  http.get(`${HTTP_BASE}/api/sftp/download?conn=${connId}&path=${encodeURIComponent(full)}`,
    (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ok = buf.length === file.size;
        console.log(`[9] ✅ 下载 ${buf.length}B (远端 ${file.size}B, ${ok ? '一致' : '❌ 不一致'})`);
        downloaded = true;
        cleanup(ok ? 0 : 1);
      });
    }).on('error', (e) => { console.log('❌ 下载失败:', e.message); cleanup(1); });
}

function cleanup(code) {
  const ok = homePath && subDirPath && backPath && backPath === homePath && downloaded;
  console.log(`\n=== 汇总: ${ok && code === 0 ? '✅ 全部通过' : '❌ 失败'} ===`);
  ws.send(JSON.stringify({ type: 'disconnect', id: TABID }));
  setTimeout(() => { ws.close(); process.exit(ok && code === 0 ? 0 : 1); }, 300);
}

setTimeout(() => { console.log('❌ 超时'); process.exit(1); }, 20000);
