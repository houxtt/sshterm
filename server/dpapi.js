// Windows DPAPI via PowerShell (no npm dependency).
// Caller must catch errors; functions never throw on non-Windows.
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SECRETS_PATH = path.join(require('os').homedir(), '.sshterm', 'secrets.enc');
let writeChain = Promise.resolve();

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
function dpapiProtectAsync(text) {
  if (!isWindows()) return Promise.reject(new Error('DPAPI 仅支持 Windows'));
  const safe = text.replace(/'/g, "''");
  const script = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$bytes=[System.Text.Encoding]::UTF8.GetBytes('${safe}');$enc=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Convert]::ToBase64String($enc)`;
  return new Promise((resolve, reject) => {
    // Do not pass the plaintext payload through a process command line: other
    // same-user processes can inspect it. PowerShell reads this short script
    // from stdin instead; the resulting DPAPI blob is the only value retained.
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) return reject(new Error(stderr.trim() || `PowerShell 退出码 ${code}`));
      resolve(stdout.trim());
    });
    child.stdin.end(script);
  });
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
  if (!isWindows()) return Promise.resolve();
  // Saving credentials must never stall terminal I/O.  The synchronous reader
  // is retained only for the one-time startup migration path.
  const snapshot = JSON.stringify(map || {});
  writeChain = writeChain.catch(() => {}).then(() => dpapiProtectAsync(snapshot)).then(blob => {
    fs.mkdirSync(path.dirname(SECRETS_PATH), { recursive: true });
    fs.writeFileSync(SECRETS_PATH, blob, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(SECRETS_PATH, 0o600); } catch {}
  }).catch(() => {});
  return writeChain;
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
