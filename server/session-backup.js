// Portable session backup format. Secrets are encrypted as a single envelope
// using an export passphrase; the on-disk session store remains DPAPI-backed.
const { randomBytes, scryptSync, createCipheriv, createDecipheriv } = require('crypto');
const os = require('os');

const FORMAT = 'sshterm-backup';
const VERSION = 1;
const MAX_BACKUP_BYTES = 4 * 1024 * 1024;
const KDF = { name: 'scrypt', N: 16384, r: 8, p: 1, keyLength: 32 };

function requirePassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12) {
    throw new Error('备份口令至少需要 12 个字符');
  }
}
function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, KDF.keyLength, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 });
}
function createBackup(sessionList, passphrase) {
  requirePassphrase(passphrase);
  const plain = Buffer.from(JSON.stringify({ format: FORMAT, version: VERSION, sessions: sessionList }), 'utf8');
  if (plain.length > MAX_BACKUP_BYTES) throw new Error('备份内容超过 4 MB 上限');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return JSON.stringify({
    format: FORMAT, version: VERSION, cipher: 'aes-256-gcm', kdf: KDF,
    salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  });
}
function readBackup(serialized, passphrase) {
  requirePassphrase(passphrase);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_BACKUP_BYTES * 2) throw new Error('备份文件无效或过大');
  let backup;
  try { backup = JSON.parse(serialized); } catch { throw new Error('备份文件不是有效 JSON'); }
  if (!backup || backup.format !== FORMAT || backup.version !== VERSION || backup.cipher !== 'aes-256-gcm' || backup.kdf?.name !== 'scrypt') {
    throw new Error('不支持的 sshterm 备份格式');
  }
  try {
    const salt = Buffer.from(backup.salt, 'base64');
    const iv = Buffer.from(backup.iv, 'base64');
    const tag = Buffer.from(backup.tag, 'base64');
    const data = Buffer.from(backup.data, 'base64');
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || !data.length || data.length > MAX_BACKUP_BYTES) throw new Error('bad envelope');
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    const parsed = JSON.parse(plain.toString('utf8'));
    if (!Array.isArray(parsed.sessions)) throw new Error('missing sessions');
    return parsed.sessions;
  } catch {
    throw new Error('备份口令错误或文件已损坏');
  }
}

// A deliberately conservative OpenSSH config importer. Wildcards, Match and
// Include are policy rules rather than concrete saved sessions, so they are
// ignored instead of being imported with surprising semantics.
function parseOpenSSHConfig(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('OpenSSH config 文件无效或过大');
  const entries = [];
  let aliases = [];
  let cfg = null;
  const finish = () => {
    if (!cfg) return;
    for (const alias of aliases) {
      if (/[*?!]/.test(alias)) continue;
      entries.push({
        name: alias, group: 'OpenSSH 导入', type: 'ssh', host: cfg.hostname || alias,
        port: cfg.port || 22, username: cfg.user || '', auth: cfg.identity ? 'key' : 'password',
        privateKey: cfg.identity || undefined, proxyJump: cfg.proxyJump || undefined, rememberPassword: false,
      });
    }
    cfg = null;
    aliases = [];
  };
  let inMatch = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    if (/^Match(\s|$)/i.test(line)) {
      finish();
      inMatch = true;
      continue;
    }
    if (inMatch) continue;
    const match = /^(Host|HostName|Port|User|IdentityFile|ProxyJump)\s+(.+)$/i.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    if (key === 'host') {
      finish();
      aliases = value.split(/\s+/).filter(Boolean);
      cfg = { hostname: '', port: 22, user: '', identity: '', proxyJump: '' };
    } else if (cfg) {
      if (key === 'hostname') cfg.hostname = value;
      else if (key === 'port' && /^\d+$/.test(value) && Number(value) <= 65535 && Number(value) > 0) cfg.port = Number(value);
      else if (key === 'user') cfg.user = value;
      else if (key === 'identityfile') cfg.identity = value.replace(/^~/, os.homedir());
      else if (key === 'proxyjump') cfg.proxyJump = value;
    }
  }
  finish();
  return entries;
}

module.exports = { createBackup, readBackup, parseOpenSSHConfig, FORMAT, VERSION };
