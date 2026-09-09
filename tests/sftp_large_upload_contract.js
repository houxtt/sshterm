const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
require(path.join(root, 'scripts', 'sync-web-app')).syncWebApp();

const indexJs = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
const sftpHttp = fs.readFileSync(path.join(root, 'server', 'sftp-http.js'), 'utf8');
const xfer = fs.readFileSync(path.join(root, 'web', 'js', 'sftp-xfer.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');

// No product-level 2GiB upload cap
assert(
  !/MAX_SFTP_UPLOAD_BYTES\s*=\s*2\s*\*\s*1024\s*\*\s*1024\s*\*\s*1024/.test(indexJs),
  'server/index.js must not define a 2GiB MAX_SFTP_UPLOAD_BYTES product cap'
);
assert(
  !indexJs.includes('MAX_SFTP_UPLOAD_BYTES'),
  'server/index.js must not expose MAX_SFTP_UPLOAD_BYTES'
);
assert(
  !sftpHttp.includes('MAX_SFTP_UPLOAD_BYTES'),
  'server/sftp-http.js must not enforce MAX_SFTP_UPLOAD_BYTES'
);
assert(
  !/2147483648/.test(indexJs + sftpHttp),
  'server must not hard-code the 2GiB (2147483648) byte limit'
);

// Chunked upload strategy on client (+ bundled app.js)
assert(
  /UPLOAD_CHUNK_BYTES\s*=\s*64\s*\*\s*1024\s*\*\s*1024/.test(xfer),
  'UPLOAD_CHUNK_BYTES 64MiB missing from sftp-xfer.js'
);
assert(
  xfer.includes('X-Upload-Total-Size') && app.includes('X-Upload-Total-Size'),
  'X-Upload-Total-Size header must be set by client and present in app.js bundle'
);
assert(
  /file\.slice\(\s*offset\s*,\s*end\s*\)/.test(xfer),
  'chunked file.slice(offset, end) loop missing'
);
assert(
  xfer.includes('while (offset < file.size)') && app.includes('while (offset < file.size)'),
  'chunked upload loop missing from xfer and app bundle'
);

// Server only hashes whole-file bodies, not partial chunks
assert(
  sftpHttp.includes('x-upload-total-size') || sftpHttp.includes('totalSize'),
  'PUT handler must consult X-Upload-Total-Size for whole-file hashing'
);
assert(
  sftpHttp.includes('shouldHash'),
  'PUT handler must gate hashing with shouldHash (no partial-chunk hash as full file)'
);

// Downloads: no product size-cap rejection
assert(
  !/MAX_SFTP_DOWNLOAD/.test(sftpHttp + indexJs + xfer + app),
  'must not define MAX_SFTP_DOWNLOAD size cap'
);
assert(
  !/offset \+ contentLength > MAX_SFTP/.test(sftpHttp),
  'must not reject uploads via MAX_SFTP product cap comparison'
);

console.log('ok sftp large upload contract passed');