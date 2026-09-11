const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ssh = fs.readFileSync(path.join(__dirname, '..', 'server', 'connections', 'ssh.js'), 'utf8');
assert(
  /printf "DISK %s %s %d %d\\n", \$6, \$5, \$4\*1024, \$2\*1024/.test(ssh)
  || ssh.includes('$4*1024, $2*1024'),
  'df awk must use $2 for total blocks and $4 for avail'
);
assert(!ssh.includes('$4*1024, $3*1024'), 'df awk must not use $3 as total');
console.log('✅ df host-stats total=$2 contract passed');
