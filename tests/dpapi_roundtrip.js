'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform !== 'win32') {
  console.log('✅ DPAPI roundtrip skipped (non-Windows)');
  process.exit(0);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sshterm-dpapi-'));
process.env.USERPROFILE = profile;
process.env.HOME = profile;
const dpapi = require('../server/dpapi');

const first = {
  'session-one': { password: 'fixture-密码-!@#', passphrase: 'phrase-一' },
};
const second = {
  ...first,
  'session-two': { password: 'second-fixture-password' },
};

try {
  dpapi.writeSecrets(first);
  assert.deepStrictEqual(dpapi.readSecrets(), first, 'DPAPI did not survive a write/read roundtrip');
  const encrypted = fs.readFileSync(dpapi.SECRETS_PATH, 'utf8');
  assert(!encrypted.includes('fixture-密码') && !encrypted.includes('second-fixture'),
    'credential file contains plaintext');

  dpapi.writeSecrets(second);
  assert.deepStrictEqual(dpapi.readSecrets(), second, 'DPAPI did not preserve a later save');
  assert(fs.existsSync(dpapi.SECRETS_BACKUP_PATH), 'encrypted credential backup was not created');

  fs.writeFileSync(dpapi.SECRETS_PATH, 'damaged-primary');
  assert.deepStrictEqual(dpapi.readSecrets(), first, 'DPAPI did not recover from the encrypted backup');
  console.log('✅ DPAPI credential roundtrip/recovery passed');
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}
