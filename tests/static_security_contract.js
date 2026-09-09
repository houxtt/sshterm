// Keep web/app.js concat artifact in sync for substring contracts.
require('../scripts/sync-web-app').syncWebApp();

// Fast, fixture-free checks for security properties that must not regress.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');

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
const dpapi = fs.readFileSync(path.join(root, 'server', 'dpapi.js'), 'utf8');

assert(app.includes('function configForBrowserStorage'), 'workspace config sanitizer is missing');
assert(app.includes("SENSITIVE_CONFIG_KEYS = new Set(['password', 'privateKey', 'passphrase', 'loginPass'])"),
  'all credential fields must be excluded from browser storage');
assert(app.includes('cfg: configForBrowserStorage(t.cfg)'), 'saveTabs must use the workspace sanitizer');
assert(app.includes('const { password, ...proxy } = safe.proxy'), 'proxy password must be excluded from browser storage');
assert(app.includes('const { password, privateKey, passphrase, ...jumpAuth } = safe.jumpAuth'), 'jump credentials must be excluded from browser storage');
assert(html.includes('id="f-remember"'), 'remember-password UI control is missing');
assert(app.includes('rememberPassword: type !== \'serial\' && $(\'f-remember\').checked'),
  'remember-password UI must feed the saved session');
assert(app.includes("$('f-remember').checked = existing ? !!existing.rememberPassword : true"),
  'new saved sessions must default to Windows-encrypted credential persistence');
assert(!app.includes('Promise.all(pool)'), 'browser-side parallel SFTP chunks must not bypass upload limits');
assert(server.includes('const activeUploadKeys = new Set()'), 'server-side per-file upload lock is missing');
assert(server.includes('uploadState.n >= MAX_CONCURRENT_UPLOADS') || server.includes('activeUploads >= MAX_CONCURRENT_UPLOADS'), 'server-side upload concurrency limit is missing');
assert(server.includes("'Accept-Ranges': 'bytes'"), 'SFTP download range support is missing');
assert(app.includes('function resumableDownload'), 'resumable browser download is missing');
assert(app.includes('const LARGE_DOWNLOAD_STREAM_THRESHOLD = 256 * 1024 * 1024'),
  'large download direct-to-disk threshold is missing');
assert(app.includes('function streamDownloadToFile') && app.includes('await handle.createWritable()'),
  'large downloads must stream to disk instead of accumulating a full Blob');
assert(app.includes("Range: `bytes=${received}-`"), 'direct-to-disk downloads must retain Range retry');
assert(html.includes('id="log-export"'), 'audit log export control is missing');
assert(html.includes('id="backup-export"') && html.includes('id="openssh-import"'), 'session migration UI is missing');
assert(server.includes("case 'export-sessions':") && server.includes("case 'import-sessions-backup':"), 'encrypted session migration handlers are missing');
assert(server.includes('cleanupLogDirectory(SESSION_LOG_DIR'), 'session transcript cleanup is missing');
assert(!fs.existsSync(path.join(root, 'server', 'connections', 'tunnel.js')), 'unused unsafe tunnel implementation remains');
assert(dpapi.includes("'-EncodedCommand', encodedCommand") && dpapi.includes('input,'),
  'DPAPI protection must pass credential data through stdin, not command-line arguments');
assert(dpapi.includes("Buffer.from(String(text), 'utf8').toString('base64')"),
  'DPAPI stdin payload must preserve arbitrary UTF-8 credentials');
assert(dpapi.includes('fs.renameSync(tempPath, SECRETS_PATH)') && dpapi.includes('SECRETS_BACKUP_PATH'),
  'DPAPI credential writes must be atomic and retain a recovery copy');

console.log('✅ static security contract passed');
