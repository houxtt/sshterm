'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const launcher = fs.readFileSync(path.join(root, 'launch.ps1'), 'utf8');
const stopper = fs.readFileSync(path.join(root, 'stop.vbs'), 'utf8');

assert.match(launcher, /Server already running with current source; opening browser\./,
  'launcher must reuse the running sshterm service');
assert.match(launcher, /-ArgumentList @\("`"\$serverScript`"", '--no-open'\)/,
  'launcher must start the hidden service without auto-exit');
assert.doesNotMatch(launcher, /['"]--auto-exit['"]/, 
  'launcher must not terminate the service when browser clients disconnect');
assert.doesNotMatch(launcher, /Stop-StaleServer \$runningInfo/,
  'a second launcher click must not replace a live server and its SSH sessions');

assert.match(stopper, /http:\/\/127\.0\.0\.1:8787\/launcher-info/,
  'stopper must identify the local sshterm service through launcher-info');
assert.match(stopper, /""app""\\s\*:\\s\*""sshterm""/,
  'stopper must verify that the endpoint identifies itself as sshterm');
assert.match(stopper, /Win32_Process WHERE ProcessId = /,
  'stopper must terminate only the exact PID returned by sshterm');
assert.doesNotMatch(stopper, /taskkill|\/IM\s+node\.exe|Name\s*=\s*['"]node\.exe/i,
  'stopper must never terminate every Node process by name');

console.log('✅ launcher session-persistence contract passed');
