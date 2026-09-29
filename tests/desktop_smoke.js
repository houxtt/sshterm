'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const binary = process.argv[2] || require('electron');
const args = process.argv[2] ? [] : [root];
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sshterm-desktop-smoke-'));
const resultFile = path.join(profile, 'result.json');
const sftpFixture = path.join(profile, 'sftp');
fs.mkdirSync(sftpFixture);
const child = spawn(binary, args, {
  cwd: root,
  env: { ...process.env, USERPROFILE: profile, HOME: profile,
    SSHTERM_SMOKE_FILE: resultFile, SSHTERM_TEST_HTTP: '',
    SSHTERM_TEST_SFTP_ROOT: sftpFixture },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', data => { output += data.toString().slice(0, 500); });
child.stderr.on('data', data => { output += data.toString().slice(0, 500); });
const holdMs = Math.min(60000, Math.max(0, Number(process.env.SSHTERM_SMOKE_HOLD_MS || 5000)));
const timer = setTimeout(() => child.kill(), holdMs + 90000);
child.on('exit', (code) => {
  clearTimeout(timer);
  try {
    const traceFile = `${resultFile}.trace`;
    const trace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8') : '(no main trace)';
    assert.ok(fs.existsSync(resultFile), `no smoke result (exit ${code}): ${output.slice(-1000)}\n${trace}`);
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    assert.deepEqual(result, { connected: true, url: 'sshterm://app/', quickBar: true,
      quickButton: true, commandSent: true, desktopBridge: true, socketOpen: true,
      sftpUpload: true, responsiveAfterWait: true, serialBinding: true });
    assert.equal(fs.readFileSync(path.join(sftpFixture, 'desktop-smoke.txt'), 'utf8'), 'smoke');
    assert.equal(code, 0, output.slice(-1000));
    console.log(`desktop smoke passed: ${path.basename(binary)}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  }
});
