'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const html = read('web/index.html');
const app = read('web/app.js');

function readServerSources() {
  const dir = path.join(root, 'server');
  const files = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.js') && !name.endsWith('.bak') && name !== 'free-serial.ps1')
    .sort();
  const nested = [];
  const connDir = path.join(dir, 'connections');
  if (fs.existsSync(connDir)) {
    for (const name of fs.readdirSync(connDir).filter((n) => n.endsWith('.js')).sort()) {
      nested.push(path.join('connections', name));
    }
  }
  return [...files, ...nested].map((rel) => fs.readFileSync(path.join(dir, rel), 'utf8')).join('\n');
}

const server = readServerSources();
const ssh = read('server/connections/ssh.js');

assert.match(html, /<option value="vnc">VNC<\/option>/, 'VNC must be offered by the +New connection type selector');
assert.match(html, /id="grp-vnc"/, 'the shared connection dialog must contain VNC fields');
assert.match(html, /id="v-host"/, 'VNC host input must exist in +New');
assert.match(html, /id="v-port"[^>]*value="5901"/, 'VNC port must default to 5901');
assert.match(html, /id="v-password"[^>]*type="password"/, 'VNC password must use a password input');
assert.match(html, /独立标签页/, 'the UI must explain that VNC opens as an independent tab');
assert.doesNotMatch(html, /id="btn-vnc"|id="dlg-vnc-mask"/, 'the legacy toolbar/modal VNC entry must be removed');

assert.match(app, /import\('\/vendor\/@novnc\/novnc\/core\/rfb\.js'\)/, 'UI must load the bundled noVNC client');
assert.match(app, /cfg\.type === 'vnc'/, 'tab creation must branch for VNC');
assert.match(app, /initVncSession\(tab\)/, 'each VNC tab must create its own controls and screen');
assert.match(app, /tab\.rfb = instance/, 'the RFB instance must be owned by the individual tab');
assert.match(app, /disconnectVncTab\(tab/, 'closing a tab must disconnect only that VNC instance');
assert.match(app, /new RFB\(tab\.vncScreen/, 'UI must render noVNC inside the VNC session tab');
assert.match(app, /token: clientToken, host, port: String\(port\)/, 'UI must send only the direct VNC target to the bridge');
assert.match(app, /type: 'vnc-credential'/, 'saved VNC sessions must request remembered credentials through the authenticated local channel');
assert.doesNotMatch(app, /localStorage[^\n]*vncPassword|sessionStorage[^\n]*vncPassword/i, 'VNC password must not be persisted in browser storage');
assert.doesNotMatch(app, /let vncRfb\b|openVncPanel/, 'VNC must not remain a global singleton');

assert.match(server, /new WebSocketServer\(\{ noServer: true/, 'VNC bridge must share the authenticated HTTP upgrade path');
assert.match(server, /pathname === '\/vnc'/, 'Server must expose the VNC WebSocket endpoint');
assert.match(server, /net\.connect\(\{ host: remoteHost, port: remotePort \}\)/, 'VNC bridge must connect directly to the requested host and port');
assert.match(server, /validVncHost\(remoteHost\)/, 'VNC bridge must validate the direct target');
assert.match(server, /case 'vnc-credential'/, 'server must restore an encrypted remembered VNC password on demand');
assert.doesNotMatch(server, /conn\.openForward\(remoteHost, remotePort\)|VNC 需要活跃的 SSH 会话/, 'VNC bridge must not use an SSH-forwarded stream');
assert.doesNotMatch(ssh, /openForward\(remoteHost, remotePort\)/, 'SSH connection must not expose the removed VNC forwarding helper');

console.log('✅ standalone VNC session contract passed');
