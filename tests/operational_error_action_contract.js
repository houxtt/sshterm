const assert = require('assert');
const fs = require('fs');
const path = require('path');
const wh = fs.readFileSync(path.join(__dirname, '..', 'server', 'ws-handlers.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
// Operational SFTP-style errors must include action so UI won't treat them as disconnects.
assert(wh.includes("action: 'sftp'"), 'sftp errors need action');
assert(wh.includes("action: 'tunnel'"), 'tunnel errors need action');
assert(wh.includes("action: 'save'"), 'save validation errors need action');
assert(wh.includes("action: 'scan'") || wh.includes("action: 'scan-net'"), 'scan errors need action');
assert(app.includes('m.action') && app.includes('setStatus'), 'UI must gate close on action / setStatus');
console.log('✅ operational error action contract passed');
