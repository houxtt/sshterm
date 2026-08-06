// e2e 测试: SFTP 文件夹上传 (多层路径, 自动创建目录树) — 真实服务器
const { WebSocket } = require('ws');
const http = require('http');
const WS_URL = process.argv[2] || 'ws://127.0.0.1:8787';
const HTTP_BASE = 'http://127.0.0.1:' + (WS_URL.match(/:(\d+)/) || [null, '8787'])[1];
const ws = new WebSocket(WS_URL);

const TABID = 99;
const DIR = `sshterm_dirtest_${Date.now()}`;
const FILES = [
  { rel: `${DIR}/main.c`, content: 'int main(){return 0;}\n' },
  { rel: `${DIR}/src/util.h`, content: '#ifndef UTIL_H\n#define UTIL_H\n#endif\n' },
  { rel: `${DIR}/src/sub/readme.txt`, content: 'hello folder upload\n' },
];
let connId = null, gotShell = false, out = '', home = null;
let uploadResults = [], verifying = false, verified = false;

ws.binaryType = 'arraybuffer';
ws.on('open', () => {
  console.log('[1] 连接 SSH...');
  ws.send(JSON.stringify({ type: 'connect', id: TABID, session: {
    type: 'ssh', name: '目录上传测试', host: '192.168.1.216', port: 22,
    username: 'logic', auth: 'password', password: '1' } }));
});

function uploadOne(f, i) {
  const url = `${HTTP_BASE}/api/sftp/upload?conn=${connId}` +
    `&path=${encodeURIComponent(home)}&name=${encodeURIComponent(f.rel)}`;
  const req = http.request(url, { method: 'PUT' }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      console.log(`[上传 ${i + 1}/${FILES.length}] ${f.rel} → ${res.statusCode} ${body}`);
      uploadResults.push(res.statusCode === 200);
      if (uploadResults.length === FILES.length) verify();
    });
  });
  req.on('error', (e) => { console.log('❌', f.rel, e.message); uploadResults.push(false); if (uploadResults.length === FILES.length) verify(); });
  req.write(f.content);
  req.end();
}

function verify() {
  console.log('[验证] 检查远端目录树...');
  verifying = true;
  ws.send(JSON.stringify({ type: 'sftp', id: connId, action: 'list', path: `${home}/${DIR}` }));
}

ws.on('message', (d, isBinary) => {
  if (isBinary) {
    const buf = new Uint8Array(d);
    if ((buf[0] | (buf[1] << 8)) !== TABID) return;
    out += new TextDecoder().decode(buf.subarray(2));
    if (!gotShell && out.includes('$') && out.length > 100) {
      gotShell = true;
      connId = TABID;
      ws.send(JSON.stringify({ type: 'sftp', id: connId, action: 'list', path: '.' }));
    }
  } else {
    const m = JSON.parse(d.toString());
    if (m.type === 'status' && m.id === TABID) console.log('  状态:', m.state);
    if (m.type === 'error' && m.id === TABID) console.log('  [错误]', m.msg);
    if (m.type === 'sftp' && m.action === 'list' && !home) {
      home = m.path;
      console.log(`[2] home: ${home}, 开始上传 ${FILES.length} 个文件 (多层路径)...`);
      setTimeout(() => FILES.forEach((f, i) => uploadOne(f, i)), 1200);
    }
    if (m.type === 'sftp' && m.action === 'list' && verifying) {
      const names = m.entries.map(e => e.name);
      console.log(`[验证] ${m.path} 内容: ${names.join(', ')}`);
      if (m.path.endsWith('/src/sub')) {
        verified = names.includes('readme.txt');
        console.log(`[验证] sub/readme.txt: ${verified ? '✅' : '❌'}`);
        cleanup(verified ? 0 : 1);
      } else if (m.path.endsWith('/src')) {
        console.log(`[验证] src 含 util.h: ${names.includes('util.h') ? '✅' : '❌'}`);
        ws.send(JSON.stringify({ type: 'sftp', id: connId, action: 'list', path: `${m.path}/sub` }));
      } else {
        // 顶层 DIR
        console.log(`[验证] 顶层含 main.c: ${names.includes('main.c') ? '✅' : '❌'} 含 src: ${names.includes('src') ? '✅' : '❌'}`);
        ws.send(JSON.stringify({ type: 'sftp', id: connId, action: 'list', path: `${m.path}/src` }));
      }
    }
  }
});

function cleanup(code) {
  const allOk = uploadResults.every(Boolean) && verified;
  console.log(`\n=== 汇总: ${allOk ? '✅ 目录上传成功(3 文件/3 层目录)' : '❌ 失败'} ===`);
  // 清理远端
  if (connId) {
    const b = Buffer.from(`rm -rf ${home}/${DIR}\n`).toString('base64');
    ws.send(JSON.stringify({ type: 'input', id: connId, data: b }));
  }
  ws.send(JSON.stringify({ type: 'disconnect', id: TABID }));
  setTimeout(() => { ws.close(); process.exit(allOk ? 0 : 1); }, 600);
}
setTimeout(() => { console.log('❌ 超时'); process.exit(1); }, 40000);
