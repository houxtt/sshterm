'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.SSHTERM_DESKTOP = '1';
delete process.env.SSHTERM_TEST_HTTP;
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sshterm-desktop-contract-'));
process.env.USERPROFILE = testHome;
process.env.HOME = testHome;
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function () { throw new Error('desktop attempted to listen on a port'); };
const backend = require('../server/index');
http.Server.prototype.listen = originalListen;

async function request(url) {
  return new Promise(resolve => {
    const response = new PassThrough();
    const chunks = [];
    let status = 200;
    response.writeHead = code => { status = code; return response; };
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status, data: Buffer.concat(chunks).toString('utf8') }));
    const req = new PassThrough();
    req.method = 'GET';
    req.url = url;
    req.headers = { 'x-sshterm-token': backend.clientToken };
    backend.desktopRequest(req, response);
    req.end();
  });
}

(async () => {
  const html = await request('/');
  assert.equal(html.status, 200);
  assert.match(html.data, /quick-command-bar/);
  const bootstrap = await request('/bootstrap.js');
  assert.equal(bootstrap.status, 200);
  assert.match(bootstrap.data, /__SSHTERM_TOKEN/);
  const events = [];
  const ws = backend.openDesktopSocket('/?window=' + 'a'.repeat(40), (kind, value) => events.push({ kind, value }));
  ws.emit('message', Buffer.from('{"type":"list"}'), false);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(events.some(event => event.kind === 'message' && !event.value.binary && JSON.parse(event.value.data.toString()).type === 'window-id'));
  assert.ok(events.some(event => event.kind === 'message' && !event.value.binary && JSON.parse(event.value.data.toString()).type === 'sessions'));
  ws.close();
  console.log('desktop contract passed');
  fs.rmSync(testHome, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });
