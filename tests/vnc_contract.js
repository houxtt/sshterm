'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const html = read('web/index.html');
const app = read('web/app.js');
const server = read('server/index.js');
const ssh = read('server/connections/ssh.js');

assert.match(html, /id="btn-vnc"/, 'VNC toolbar button must exist');
assert.match(html, /id="vnc-password"[^>]*type="password"/, 'VNC password must use a password input');
assert.match(html, /VNC 密码（不保存）/, 'UI must state that the VNC password is not saved');

assert.match(app, /import\('\/vendor\/@novnc\/novnc\/core\/rfb\.js'\)/, 'UI must load the bundled noVNC client');
assert.match(app, /new RFB\(/, 'UI must create an RFB session');
assert.match(app, /\$\('vnc-password'\)\.value = '';/, 'UI must clear the VNC password after use');
assert.doesNotMatch(app, /localStorage[^\n]*vnc-password|sessionStorage[^\n]*vnc-password/i, 'VNC password must not be persisted in browser storage');

assert.match(server, /new WebSocketServer\(\{ noServer: true/, 'VNC bridge must share the authenticated HTTP upgrade path');
assert.match(server, /pathname === '\/vnc'/, 'Server must expose the VNC WebSocket endpoint');
assert.match(server, /remoteHost !== '127\.0\.0\.1' && remoteHost !== 'localhost'/, 'VNC target must remain limited to remote loopback');
assert.match(server, /conn\.openForward\(remoteHost, remotePort\)/, 'VNC traffic must use the active SSH connection');
assert.match(ssh, /openForward\(remoteHost, remotePort\)/, 'SSH connections must support forwarded streams');

console.log('✅ VNC-over-SSH static contract passed');
