const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
require(path.join(root, 'scripts', 'sync-web-app')).syncWebApp();
const app = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');

assert(html.includes('id="session-filter"'), 'session filter input missing in index.html');
assert(html.includes('session-filter'), 'session filter markup missing');
assert(/placeholder="[^"]*"/.test(html.match(/id="session-filter"[^>]*>/)[0]), 'session filter placeholder missing');
assert(app.includes('function sessionMatchesFilter'), 'sessionMatchesFilter helper missing from bundle');
assert(app.includes('function getSessionFilterText'), 'getSessionFilterText helper missing from bundle');
assert(app.includes('session-filter'), 'session-filter binding missing');
assert(app.includes('getSessionFilterText()'), 'renderSessionList must consult filter text');

console.log('✅ session filter contract passed');
