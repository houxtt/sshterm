// Protocol-level regression for encrypted backups and OpenSSH config import.
// The server runs with a disposable Windows profile, so no user session data is
// read or changed by this test.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 8901;
const BASE = `http://127.0.0.1:${PORT}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sshterm-transfer-'));

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function getToken(deadline = Date.now() + 10000) {
  while (Date.now() < deadline) {
    try {
      const script = await new Promise((resolve, reject) => http.get(`${BASE}/bootstrap.js`, {
        headers: { Origin: `http://127.0.0.1:${PORT}`, Referer: `http://127.0.0.1:${PORT}/` },
      }, res => {
        let body = ''; res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}`)));
      }).on('error', reject));
      const match = script.match(/__SSHTERM_TOKEN\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    } catch {}
    await sleep(100);
  }
  throw new Error('server startup timed out');
}
function onceMessage(ws, predicate, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('WebSocket response timed out')); }, timeout);
    const handler = raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'error') { cleanup(); reject(new Error(message.msg)); return; }
      if (predicate(message)) { cleanup(); resolve(message); }
    };
    const cleanup = () => { clearTimeout(timer); ws.off('message', handler); };
    ws.on('message', handler);
  });
}
function onceError(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('expected WebSocket error timed out')); }, 8000);
    const handler = raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'error') { cleanup(); resolve(message); }
    };
    const cleanup = () => { clearTimeout(timer); ws.off('message', handler); };
    ws.on('message', handler);
  });
}

(async () => {
  const server = spawn(process.execPath, ['server/index.js', '--port', String(PORT), '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, USERPROFILE: profile, HOME: profile },
    stdio: 'ignore',
  });
  let ws;
  try {
    const token = await getToken();
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(token)}`, {
      headers: { Origin: `http://127.0.0.1:${PORT}` },
    });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

    const source = [{ name: 'production', type: 'ssh', host: 'prod.example', port: 22,
      username: 'ops', password: 'encrypted-only', rememberPassword: true }];
    const backupResponse = onceMessage(ws, m => m.type === 'session-export');
    ws.send(JSON.stringify({ type: 'export-sessions', passphrase: 'long test backup passphrase', }));
    const emptyBackup = await backupResponse;
    assert(!emptyBackup.data.includes('encrypted-only'), 'empty backup unexpectedly leaked credentials');

    const importResponse = onceMessage(ws, m => m.type === 'session-import' && m.source === 'backup');
    // Import a valid pre-built payload through the public protocol instead of
    // invoking server helpers directly.
    const { createBackup } = require('../server/session-backup');
    ws.send(JSON.stringify({ type: 'import-sessions-backup', passphrase: 'long test backup passphrase',
      data: createBackup(source, 'long test backup passphrase') }));
    assert.strictEqual((await importResponse).count, 1, 'encrypted backup import count');

    const duplicateResponse = onceMessage(ws, m => m.type === 'session-import' && m.source === 'backup');
    ws.send(JSON.stringify({ type: 'import-sessions-backup', passphrase: 'long test backup passphrase',
      data: createBackup(source, 'long test backup passphrase') }));
    await duplicateResponse;

    const openSshResponse = onceMessage(ws, m => m.type === 'session-import' && m.source === 'openssh');
    ws.send(JSON.stringify({ type: 'import-openssh-config', data: 'Host staging\n  HostName stage.example\n  User deploy\n\nHost *\n  ServerAliveInterval 30\n' }));
    assert.strictEqual((await openSshResponse).count, 1, 'OpenSSH import count');

    const listResponse = onceMessage(ws, m => m.type === 'sessions' && m.list.length === 3);
    ws.send(JSON.stringify({ type: 'list' }));
    const names = (await listResponse).list.map(item => item.name).sort();
    assert.deepStrictEqual(names, ['production', 'production (2)', 'staging'], 'import conflict handling');

    const exported = onceMessage(ws, m => m.type === 'session-export');
    ws.send(JSON.stringify({ type: 'export-sessions', passphrase: 'long test backup passphrase' }));
    assert(!((await exported).data).includes('encrypted-only'), 'protocol export leaked credentials');

    const rejected = onceError(ws);
    ws.send(JSON.stringify({ type: 'import-sessions-backup', passphrase: 'wrong backup passphrase',
      data: createBackup(source, 'long test backup passphrase') }));
    assert.match((await rejected).msg, /口令错误|已损坏/, 'wrong backup passphrase must be rejected');
    console.log('✅ WebSocket session transfer integration passed');
  } finally {
    if (ws) ws.close();
    server.kill();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error('❌', error.stack || error.message); process.exit(1); });
