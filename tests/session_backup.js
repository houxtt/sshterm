const assert = require('assert');
const { createBackup, readBackup, parseOpenSSHConfig } = require('../server/session-backup');

const sessions = [{
  id: 'old-id', name: 'production', type: 'ssh', host: 'prod.internal', port: 22,
  username: 'ops', password: 'backup-secret', rememberPassword: true,
}];
const encrypted = createBackup(sessions, 'correct horse battery staple');
assert(!encrypted.includes('backup-secret'), 'backup ciphertext leaked a secret');
assert.deepStrictEqual(readBackup(encrypted, 'correct horse battery staple'), sessions, 'backup round-trip failed');
assert.throws(() => readBackup(encrypted, 'wrong passphrase'), /口令错误|已损坏/, 'wrong password must fail');
assert.throws(() => createBackup([], 'short'), /至少需要 12/, 'short backup password must fail');

const imported = parseOpenSSHConfig(`
Host prod staging
  HostName gateway.internal
  Port 2222
  User deploy
  IdentityFile ~/.ssh/id_ed25519
  ProxyJump bastion.internal

Host *
  ServerAliveInterval 30
`);
assert.strictEqual(imported.length, 2, 'concrete OpenSSH aliases should import');
assert(imported.every(s => s.host === 'gateway.internal' && s.port === 2222 && s.auth === 'key'), 'OpenSSH fields parsed incorrectly');
console.log('✅ encrypted session backup and OpenSSH import passed');
