const fs = require('fs');
const path = require('path');

// Canonical load order for web/js modules (must match index.html).
const WEB_JS_ORDER = [
  'theme-settings.js',
  'i18n.js',
  'host-cpu.js',
  'clipboard.js',
  'reconnect.js',
  'tunnel-ui.js',
  'sftp-panel.js',
  'sftp-xfer.js',
  'vnc-ui.js',
  'hotkeys.js',
  'split-panes.js',
];

function syncWebApp() {
  const root = path.join(__dirname, '..');
  const jsDir = path.join(root, 'web', 'js');
  const mainPath = path.join(root, 'web', 'app.main.js');
  const outPath = path.join(root, 'web', 'app.js');

  const parts = [];
  parts.push('// AUTO-GENERATED — edit web/js/* and web/app.main.js, then run: node scripts/sync-web-app.js');
  parts.push('// Concat order: ' + WEB_JS_ORDER.join(' + ') + ' + app.main.js');
  parts.push('');

  for (const name of WEB_JS_ORDER) {
    const file = path.join(jsDir, name);
    if (!fs.existsSync(file)) throw new Error('missing web module: ' + name);
    parts.push(`// ========== web/js/${name} ==========`);
    parts.push(fs.readFileSync(file, 'utf8').replace(/\s+$/, ''));
    parts.push('');
  }

  if (!fs.existsSync(mainPath)) throw new Error('missing web/app.main.js');
  parts.push('// ========== web/app.main.js ==========');
  parts.push(fs.readFileSync(mainPath, 'utf8').replace(/\s+$/, ''));
  parts.push('');

  fs.writeFileSync(outPath, parts.join('\n'), 'utf8');
  return { outPath, bytes: fs.statSync(outPath).size, modules: WEB_JS_ORDER.length };
}

if (require.main === module) {
  const result = syncWebApp();
  console.log(`synced ${result.outPath} (${result.bytes} bytes, ${result.modules} modules + main)`);
}

module.exports = { syncWebApp, WEB_JS_ORDER };
