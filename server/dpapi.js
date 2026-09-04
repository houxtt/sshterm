// Windows DPAPI credential storage. Plaintext is sent only through the child
// process stdin as base64; command-line arguments contain fixed code only.
// On non-Windows platforms, secrets are encrypted with AES-256-GCM using a
// randomly generated key stored alongside the encrypted file.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SECRETS_PATH = path.join(os.homedir(), '.sshterm', 'secrets.enc');
const SECRETS_BACKUP_PATH = `${SECRETS_PATH}.bak`;
const SECRET_KEY_PATH = path.join(os.homedir(), '.sshterm', 'secrets.key');

function isWindows() {
  return process.platform === 'win32';
}

// ---- Non-Windows: AES-256-GCM with a persisted random key ----

function getOrCreateKey() {
  try {
    if (fs.existsSync(SECRET_KEY_PATH)) {
      const hex = fs.readFileSync(SECRET_KEY_PATH, 'utf8').trim();
      if (hex.length === 64) return Buffer.from(hex, 'hex');
    }
  } catch {}
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(SECRET_KEY_PATH), { recursive: true });
  fs.writeFileSync(SECRET_KEY_PATH, key.toString('hex'), { mode: 0o600 });
  return key;
}

function aesGcmEncrypt(plaintext) {
  const key = getOrCreateKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext, all base64
  return iv.toString('base64') + ':' + tag.toString('base64') + ':' + encrypted.toString('base64');
}

function aesGcmDecrypt(blob) {
  const key = getOrCreateKey();
  const parts = String(blob).trim().split(':');
  if (parts.length !== 3) throw new Error('无效的加密格式');
  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const encrypted = Buffer.from(parts[2], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function runPowerShell(script, input) {
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodedCommand,
  ], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Windows DPAPI 操作失败（PowerShell 退出码 ${result.status}）`);
  return (result.stdout || '').trim();
}

function dpapiProtect(text) {
  if (!isWindows()) throw new Error('DPAPI 仅支持 Windows');
  const input = Buffer.from(String(text), 'utf8').toString('base64');
  return runPowerShell(`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$payload=[Console]::In.ReadToEnd().Trim()
$bytes=[Convert]::FromBase64String($payload)
$encrypted=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($encrypted))
`, input);
}

function dpapiUnprotect(blob) {
  if (!isWindows()) throw new Error('DPAPI 仅支持 Windows');
  const output = runPowerShell(`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$payload=[Console]::In.ReadToEnd().Trim()
$bytes=[Convert]::FromBase64String($payload)
$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($plain))
`, String(blob).trim());
  return Buffer.from(output, 'base64').toString('utf8');
}

function writeSecrets(map) {
  const blob = isWindows() ? dpapiProtect(JSON.stringify(map || {})) : aesGcmEncrypt(JSON.stringify(map || {}));
  const dir = path.dirname(SECRETS_PATH);
  const tempPath = `${SECRETS_PATH}.${process.pid}.tmp`;
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(tempPath, blob, { encoding: 'utf8', mode: 0o600 });
    if (fs.existsSync(SECRETS_PATH)) fs.copyFileSync(SECRETS_PATH, SECRETS_BACKUP_PATH);
    fs.renameSync(tempPath, SECRETS_PATH);
    try { fs.chmodSync(SECRETS_PATH, 0o600); } catch {}
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
}

function readSecretFile(file) {
  const blob = fs.readFileSync(file, 'utf8').trim();
  return JSON.parse(isWindows() ? dpapiUnprotect(blob) : aesGcmDecrypt(blob));
}

function readSecrets() {
  for (const file of [SECRETS_PATH, SECRETS_BACKUP_PATH]) {
    if (!fs.existsSync(file)) continue;
    try {
      return readSecretFile(file);
    } catch (error) {
      console.error(`[凭据] 无法读取 ${path.basename(file)}: ${error.message}`);
    }
  }
  return {};
}

module.exports = { writeSecrets, readSecrets, SECRETS_PATH, SECRETS_BACKUP_PATH };
