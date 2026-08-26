// End-to-end VNC transport regression.  A local TCP fixture stands in for the
// remote VNC server while the test-only SSH fixture provides openForward().
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 8908;
const BASE = `http://127.0.0.1:${PORT}`;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sshterm-vnc-'));
const profile = path.join(temp, 'profile');
const fixture = path.join(temp, 'fixture');
fs.mkdirSync(fixture, { recursive: true });

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function httpGet(url) {
  return new Promise((resolve, reject) => http.get(url, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject));
}
async function waitForServer(deadline = Date.now() + 10000) {
  while (Date.now() < deadline) {
    try { const response = await httpGet(`${BASE}/`); if (response.status === 200) return; } catch {}
    await sleep(100);
  }
  throw new Error('server startup timed out');
}
function wsMessage(ws, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('VNC WebSocket message timed out')); }, timeout);
    const onMessage = data => { cleanup(); resolve(Buffer.from(data)); };
    const onClose = (code, reason) => { cleanup(); reject(new Error(`VNC WebSocket closed ${code}: ${reason}`)); };
    const cleanup = () => { clearTimeout(timer); ws.off('message', onMessage); ws.off('close', onClose); };
    ws.on('message', onMessage); ws.on('close', onClose);
  });
}
function wsClose(ws, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('VNC WebSocket close timed out')), timeout);
    ws.once('close', (code, reason) => { clearTimeout(timer); resolve({ code, reason: reason.toString() }); });
    ws.once('error', () => {});
  });
}

(async () => {
  const tcpServer = net.createServer(socket => {
    socket.write('RFB 003.008\n');
    socket.on('data', data => socket.write(Buffer.concat([Buffer.from('ECHO:'), data])));
  });
  await new Promise((resolve, reject) => {
    tcpServer.once('error', reject);
    tcpServer.listen(0, '127.0.0.1', resolve);
  });
  const vncPort = tcpServer.address().port;
  const server = spawn(process.execPath, ['server/index.js', '--port', String(PORT), '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, USERPROFILE: profile, HOME: profile, SSHTERM_TEST_SFTP_ROOT: fixture },
    stdio: 'ignore',
  });
  let ws;
  try {
    await waitForServer();
    const bootstrap = await httpGet(`${BASE}/bootstrap.js`);
    const token = bootstrap.body.toString().match(/__SSHTERM_TOKEN\s*=\s*"([^"]+)"/)[1];

    const moduleResponse = await httpGet(`${BASE}/vendor/@novnc/novnc/core/rfb.js`);
    assert.strictEqual(moduleResponse.status, 200, 'noVNC RFB module must be served locally');
    assert.match(moduleResponse.headers['content-type'] || '', /javascript/, 'noVNC module MIME type');

    const endpoint = `ws://127.0.0.1:${PORT}/vnc?token=${encodeURIComponent(token)}&conn=9900&host=127.0.0.1&port=${vncPort}`;
    ws = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    assert.strictEqual((await wsMessage(ws)).toString(), 'RFB 003.008\n', 'VNC server banner forwarding');
    const reply = wsMessage(ws);
    ws.send(Buffer.from('RFB 003.008\n'));
    assert.strictEqual((await reply).toString(), 'ECHO:RFB 003.008\n', 'bidirectional VNC byte forwarding');
    ws.close();

    const forbidden = new WebSocket(`ws://127.0.0.1:${PORT}/vnc?token=${encodeURIComponent(token)}&conn=9900&host=192.168.1.10&port=5901`);
    const closed = wsClose(forbidden);
    assert.strictEqual((await closed).code, 1008, 'VNC bridge must reject non-loopback remote targets');
    console.log('✅ VNC-over-SSH WebSocket bridge integration passed');
  } finally {
    if (ws) ws.close();
    server.kill();
    tcpServer.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error('❌', error.stack || error.message); process.exit(1); });
