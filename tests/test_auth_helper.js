'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

async function readBootstrapToken(base, headers = {}) {
  const script = await new Promise((resolve, reject) => {
    http.get(`${base}/bootstrap.js`, { headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`bootstrap HTTP ${res.statusCode}`))));
    }).on('error', reject);
  });
  const match = script.match(/__SSHTERM_TOKEN\s*=\s*"([^"]+)"/);
  if (!match) throw new Error('bootstrap token not found');
  return match[1];
}

async function readCliToken(profileDir) {
  const tokenFile = path.join(profileDir, '.sshterm', 'token');
  for (let i = 0; i < 50; i++) {
    try {
      return fs.readFileSync(tokenFile, 'utf8').trim();
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error('token file not found');
}

async function loadServiceToken(base, profileDir) {
  try {
    return await readCliToken(profileDir);
  } catch {
    return readBootstrapToken(base, { 'X-SSHTERM-Token': 'pending' });
  }
}

module.exports = { readBootstrapToken, readCliToken, loadServiceToken };
