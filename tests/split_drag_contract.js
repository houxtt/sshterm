const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'web', 'style.css'), 'utf8');

for (const event of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
  assert(app.includes(`'${event}'`), `split drag must handle ${event}`);
}
assert(app.includes('dragRatio = ratio;'), 'split drag must retain the last measured ratio');
assert(app.includes('saveSplitPrefs(') && app.includes('saveTabs();'),
  'split drag must persist both layout preferences and tab state');
assert(/\.hostinfo-bar\s*\{[\s\S]*position:\s*absolute/.test(css),
  'host status bar must be removed from the pane flex flow');
assert(!/:has\(\.hostinfo-bar\)\s*\{[^}]*flex-direction:\s*column/.test(css),
  'host status bar must not force split panes into a column');

console.log('✅ split divider drag contract passed');
