const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
require(path.join(root, 'scripts', 'sync-web-app')).syncWebApp();
const app = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
const xfer = fs.readFileSync(path.join(root, 'web', 'js', 'sftp-xfer.js'), 'utf8');

assert(app.includes('function collectDataTransferFiles'), 'collectDataTransferFiles missing from bundle');
assert(app.includes('function collectFileEntriesFromEntry'), 'collectFileEntriesFromEntry missing from bundle');
assert(app.includes('webkitGetAsEntry'), 'webkitGetAsEntry usage missing');
assert(app.includes('uploadDroppedFiles'), 'uploadDroppedFiles helper missing');
assert(xfer.includes('entry.isDirectory'), 'directory entry handling missing');
assert(app.includes('draggingSessionId'), 'must still guard session-list drag reorder');

console.log('✅ sftp dir drop contract passed');
