const assert = require('assert'); const fs = require('fs'); const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
const ssh = fs.readFileSync(path.join(__dirname, '..', 'server', 'connections', 'ssh.js'), 'utf8');
assert(html.includes('/vendor/zmodem.js/dist/zmodem.js'));
assert(app.includes('new Zmodem.Sentry') && app.includes('zmodemSentry.consume'));
assert(app.includes('sender: octets => sendInput'));
assert(!ssh.includes('this._zmodem.feed'));
console.log('✅ browser Zmodem protocol handoff contract passed');
