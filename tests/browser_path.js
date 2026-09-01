const fs = require('fs');
const path = require('path');

module.exports = function resolveBrowserPath(root = path.join(__dirname, '..')) {
  const candidates = [
    process.env.SSHTERM_BROWSER_PATH,
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(root, 'vendor', 'chrome-headless-shell', 'chrome-headless-shell.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const browser = candidates.find(candidate => candidate && fs.existsSync(candidate));
  if (!browser) throw new Error('No supported Chrome/Edge executable found');
  return browser;
};
