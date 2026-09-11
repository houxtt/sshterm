const assert = require('assert'); const fs = require('fs'); const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
const ssh = fs.readFileSync(path.join(__dirname, '..', 'server', 'connections', 'ssh.js'), 'utf8');
// Product decision 2026-09-11: Zmodem unsupported — no browser Sentry / consume bypass.
assert(!html.includes('/vendor/zmodem.js/dist/zmodem.js'), 'index.html must not load vendor zmodem.js');
assert(!app.includes('new Zmodem.Sentry'), 'app.js must not create Zmodem.Sentry');
assert(!app.includes('zmodemSentry.consume'), 'app.js must not short-circuit output via zmodemSentry.consume');
assert(!ssh.includes('this._zmodem.feed'));
console.log('✅ browser Zmodem unsupported / no-Sentry contract passed');
