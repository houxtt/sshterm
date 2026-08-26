// Windows DPAPI credential storage. Plaintext is sent only through the child
// process stdin as base64; command-line arguments contain fixed code only.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SECRETS_PATH = path.join(os.homedir(), '.sshterm', 'secrets.enc');
const SECRETS_BACKUP_PATH = `${SECRETS_PATH}.bak`;

function isWindows() {
  return process.platform === 'win32';
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
  if (!isWindows()) return;
  const blob = dpapiProtect(JSON.stringify(map || {}));
  const dir = path.dirname(SECRETS_PATH);
  const tempPath = `${SECRETS_PATH}.${process.pid}.tmp`;
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(tempPath, blob, { encoding: 'utf8', mode: 0o600 });
    // Preserve the previous complete encrypted file before atomically replacing
    // it. A damaged primary can therefore recover from the last good save.
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
  return JSON.parse(dpapiUnprotect(blob));
}

function readSecrets() {
  if (!isWindows()) return {};
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
