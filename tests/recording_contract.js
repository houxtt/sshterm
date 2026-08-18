const assert = require('assert');
const fs = require('fs');
const source = fs.readFileSync(require('path').join(__dirname, '..', 'web', 'app.js'), 'utf8');
assert(source.includes("capture: 'rx-only'"), 'recording must be output-only');
assert(source.includes('function validateRecording'), 'recording import validation missing');
assert(source.includes('events.length > 100000'), 'recording event limit missing');
assert(source.includes('size > 8 * 1024 * 1024'), 'recording size limit missing');
assert(source.includes('不记录键盘输入'), 'privacy notice missing');
console.log('✅ session recording privacy contract passed');
