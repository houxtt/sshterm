// Parse ~/.ssh/config Host entries for the UI picker.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const SSH_CONFIG_PATH = path.join(os.homedir(), '.ssh', 'config');

function loadSSHConfig() {
  try {
    const raw = fs.readFileSync(SSH_CONFIG_PATH, 'utf8');
    const hosts = {};
    let current = null;
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*(Host|Hostname|Port|User|IdentityFile|ProxyJump)\s+(.+)$/i);
      if (!m) continue;
      const [, key, val] = m;
      const k = key.toLowerCase();
      if (k === 'host') {
        current = val.replace(/['"]/g, '').trim();
        hosts[current] = { hostname: '', port: 22, user: 'root', identity: '', proxyJump: '' };
      } else if (current) {
        if (k === 'hostname') hosts[current].hostname = val.replace(/['"]/g, '').trim();
        else if (k === 'port') hosts[current].port = parseInt(val, 10);
        else if (k === 'user') hosts[current].user = val.replace(/['"]/g, '').trim();
        else if (k === 'identityfile') hosts[current].identity = val.replace(/['"]/g, '').trim();
        else if (k === 'proxyjump') hosts[current].proxyJump = val.replace(/['"]/g, '').trim();
      }
    }
    return hosts;
    console.log('[ssh-config] 加载', Object.keys(hosts).length, '个 Host 条目');
  } catch (e) {
    if (e.code !== 'ENOENT') console.log('[ssh-config] 加载失败:', e.message);
    return {};
  }
}

module.exports = { loadSSHConfig, SSH_CONFIG_PATH };
