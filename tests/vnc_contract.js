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
assert.doesNotMatch(html, /id="btn-vnc"[^>]*class="[^"]*hidden/, 'VNC toolbar button must remain visible without an SSH session');
assert.match(html, /id="vnc-host"(?![^>]*readonly)/, 'VNC host input must be editable');
assert.match(html, /无需先打开 SSH\/终端会话/, 'UI must explain that VNC is independent from SSH sessions');
assert.match(html, /id="vnc-password"[^>]*type="password"/, 'VNC password must use a password input');
assert.match(html, /VNC 密码（不保存）/, 'UI must state that the VNC password is not saved');

assert.match(app, /import\('\/vendor\/@novnc\/novnc\/core\/rfb\.js'\)/, 'UI must load the bundled noVNC client');
assert.match(app, /new RFB\(/, 'UI must create an RFB session');
assert.match(app, /token: clientToken, host, port: String\(port\)/, 'UI must send only the direct VNC target to the bridge');
assert.match(app, /\$\('btn-vnc'\)\.onclick = openVncPanel/, 'VNC entry must not depend on the active terminal tab');
assert.doesNotMatch(app, /请先连接一个 SSH 会话|VNC 需要活跃的 SSH 会话|vncTabId/, 'UI must not require an SSH session for VNC');
assert.match(app, /\$\('vnc-password'\)\.value = '';/, 'UI must clear the VNC password after use');
assert.doesNotMatch(app, /localStorage[^\n]*vnc-password|sessionStorage[^\n]*vnc-password/i, 'VNC password must not be persisted in browser storage');

assert.match(server, /new WebSocketServer\(\{ noServer: true/, 'VNC bridge must share the authenticated HTTP upgrade path');
assert.match(server, /pathname === '\/vnc'/, 'Server must expose the VNC WebSocket endpoint');
assert.match(server, /net\.connect\(\{ host: remoteHost, port: remotePort \}\)/, 'VNC bridge must connect directly to the requested host and port');
assert.match(server, /validVncHost\(remoteHost\)/, 'VNC bridge must validate the direct target');
assert.doesNotMatch(server, /conn\.openForward\(remoteHost, remotePort\)|VNC 需要活跃的 SSH 会话/, 'VNC bridge must not use an SSH-forwarded stream');
assert.doesNotMatch(ssh, /openForward\(remoteHost, remotePort\)/, 'SSH connection must not expose the removed VNC forwarding helper');

console.log('✅ standalone VNC direct-connect static contract passed');
