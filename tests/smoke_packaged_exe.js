// Validates a locally built caxa artifact without opening a browser.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const exe = path.join(ROOT, 'dist', 'sshterm.exe');
const port = 8903;

if (!fs.existsSync(exe)) throw new Error('dist/sshterm.exe 不存在；请先运行 node scripts/build-exe.js');
function waitForUi(deadline = Date.now() + 30000) {
  return new Promise((resolve, reject) => {
    const attempt = () => http.get(`http://127.0.0.1:${port}/`, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', c => { body += c; });
      res.on('end', () => res.statusCode === 200 && body.includes('sshterm') ? resolve() : retry());
    }).on('error', retry);
    const retry = () => Date.now() < deadline ? setTimeout(attempt, 150) : reject(new Error('packaged EXE did not serve the UI'));
    attempt();
  });
}

(async () => {
  const child = spawn(exe, ['--port', String(port), '--no-open'], { cwd: ROOT, stdio: 'ignore' });
  try {
    await waitForUi();
    console.log('✅ packaged EXE HTTP smoke test passed');
  } finally {
    if (!child.killed) child.kill();
  }
})().catch(error => { console.error('❌', error.stack || error.message); process.exit(1); });
