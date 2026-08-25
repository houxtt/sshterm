// 临时验证: 目录下载返回 X-Total-Size 头且 zip 可收完 (fixture, 无需真实 SSH)
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-dirtest-'));
fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
fs.writeFileSync(path.join(root, 'a.txt'), Buffer.alloc(1000, 7));
fs.writeFileSync(path.join(root, 'sub', 'b.bin'), Buffer.alloc(5000, 9));

process.env.SSHTERM_TEST_SFTP_ROOT = root;
const BASE = 'http://127.0.0.1:8791';
const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js'), '--port', '8791'], { stdio: ['ignore', 'ignore', 'inherit'] });

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
(async () => {
  try {
    // 等服务器就绪
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { await get(`${BASE}/`); up = true; } catch { await new Promise(r => setTimeout(r, 200)); }
    }
    if (!up) throw new Error('server not up');
    const boot = await get(`${BASE}/bootstrap.js`);
    const m = boot.body.toString().match(/__SSHTERM_TOKEN\s*=\s*"([^"]+)"/);
    if (!m) throw new Error('no token');
    const t = encodeURIComponent(m[1]);
    const r = await get(`${BASE}/api/sftp/download-dir?conn=9900&path=${encodeURIComponent('/sub')}&token=${t}`);
    console.log('status:', r.status);
    console.log('X-Total-Size:', r.headers['x-total-size']);
    console.log('zip bytes:', r.body.length, 'zip magic:', r.body.subarray(0, 2).toString());
    if (r.status === 200 && r.headers['x-total-size'] === '5000' && r.body.subarray(0, 2).toString() === 'PK') {
      console.log('✅ 目录下载: X-Total-Size 头正确, zip 流完整');
    } else {
      console.log('❌ 验证失败'); process.exitCode = 1;
    }
  } catch (e) {
    console.log('❌ 异常:', e.message); process.exitCode = 1;
  } finally {
    child.kill();
  }
})();
