// Windows DPAPI via PowerShell (no npm dependency).
// Caller must catch errors; functions never throw on non-Windows.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SECRETS_PATH = path.join(require('os').homedir(), '.sshterm', 'secrets.enc');

function isWindows() {
  return process.platform === 'win32';
}
function psScript(js) {
  // Escape single quotes for PowerShell -Command
  return `powershell -NoProfile -ExecutionPolicy Bypass -Command "& {${js}}"`;
}
function dpapiProtect(text) {
  if (!isWindows()) throw new Error('DPAPI 仅支持 Windows');
  const safe = text.replace(/'/g, "''");
  const script = `
$ErrorActionPreference='SilentlyContinue';
Add-Type -AssemblyName System.Security;
$bytes=[System.Text.Encoding]::UTF8.GetBytes('${safe}');
$enc=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);
[Convert]::ToBase64String($enc)`;
  return execSync(psScript(script), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
function dpapiUnprotect(b64) {
  if (!isWindows()) throw new Error('DPAPI 仅支持 Windows');
  const script = `
$ErrorActionPreference='SilentlyContinue';
Add-Type -AssemblyName System.Security;
$bytes=[Convert]::FromBase64String('${b64.replace(/'/g, "''")}');
[System.Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser))`;
  return execSync(psScript(script), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function writeSecrets(map) {
  if (!isWindows()) return;
  try {
    fs.mkdirSync(path.dirname(SECRETS_PATH), { recursive: true });
    const blob = dpapiProtect(JSON.stringify(map || {}));
    fs.writeFileSync(SECRETS_PATH, blob, 'utf8');
  } catch (e) { /* 加密失败不影响主流程 */ }
}
function readSecrets() {
  if (!isWindows()) return {};
  try {
    if (!fs.existsSync(SECRETS_PATH)) return {};
    const blob = fs.readFileSync(SECRETS_PATH, 'utf8').trim();
    const json = dpapiUnprotect(blob);
    try { return JSON.parse(json); } catch { return {}; }
  } catch (e) { return {}; }
}

module.exports = { writeSecrets, readSecrets, SECRETS_PATH };
