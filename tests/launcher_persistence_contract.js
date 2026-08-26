'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const launcher = fs.readFileSync(path.join(root, 'launch.ps1'), 'utf8');

assert.match(launcher, /Server already running with current source; opening browser\./,
  'launcher must reuse the running sshterm service');
assert.match(launcher, /-ArgumentList @\("`"\$serverScript`"", '--no-open'\)/,
  'launcher must start the hidden service without auto-exit');
assert.doesNotMatch(launcher, /['"]--auto-exit['"]/, 
  'launcher must not terminate the service when browser clients disconnect');
assert.doesNotMatch(launcher, /Stop-StaleServer \$runningInfo/,
  'a second launcher click must not replace a live server and its SSH sessions');

console.log('✅ launcher session-persistence contract passed');
