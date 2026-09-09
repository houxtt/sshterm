// Contract: terminal theme / font / scrollback settings helpers.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
require(path.join(root, 'scripts', 'sync-web-app')).syncWebApp();
const app = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
const themeMod = fs.readFileSync(path.join(root, 'web', 'js', 'theme-settings.js'), 'utf8');

assert(html.includes('id="btn-settings"'), 'settings toolbar button missing');
assert(html.includes('id="dlg-settings-mask"'), 'settings dialog missing');
assert(html.includes('id="set-theme"') && html.includes('id="set-font-size"'), 'settings form controls missing');
assert(html.includes('/js/theme-settings.js'), 'index.html must load theme-settings module');

assert(app.includes('BUILTIN_THEMES'), 'concat bundle must include BUILTIN_THEMES');
assert(app.includes('function loadTerminalSettings'), 'loadTerminalSettings helper missing');
assert(app.includes('function getTerminalOptions'), 'getTerminalOptions helper missing');
assert(app.includes('function applySettingsToAllTerminals'), 'applySettingsToAllTerminals helper missing');
assert(app.includes("themeId: 'tokyo-night'"), 'Tokyo Night must remain the default theme');
assert(themeMod.includes('solarized-dark') && themeMod.includes('one-dark') && themeMod.includes('light:'),
  'built-in themes must include Solarized Dark, One Dark, and Light');

const sandbox = {
  window: {},
  localStorage: {
    _data: {},
    getItem(k) { return this._data[k] || null; },
    setItem(k, v) { this._data[k] = String(v); },
  },
  document: {
    getElementById() { return null; },
  },
};
sandbox.window.Sshterm = {};
vm.runInNewContext(themeMod + '\nthis.Sshterm = window.Sshterm; this.loadTerminalSettings = loadTerminalSettings; this.getTerminalOptions = getTerminalOptions; this.BUILTIN_THEMES = BUILTIN_THEMES; this.saveTerminalSettings = saveTerminalSettings;', sandbox);

assert(sandbox.BUILTIN_THEMES['tokyo-night'], 'tokyo-night theme definition missing');
assert(sandbox.BUILTIN_THEMES['solarized-dark'], 'solarized-dark theme definition missing');
assert(sandbox.BUILTIN_THEMES['one-dark'], 'one-dark theme definition missing');
assert(sandbox.BUILTIN_THEMES.light, 'light theme definition missing');
const opts = sandbox.getTerminalOptions();
assert.strictEqual(opts.fontSize, 13);
assert.strictEqual(opts.scrollback, 5000);
assert.strictEqual(opts.theme.background, '#1a1b26');
sandbox.saveTerminalSettings({ themeId: 'one-dark', fontSize: 16, scrollback: 8000, cursorBlink: false, fontFamily: 'Cascadia Mono' });
const next = sandbox.getTerminalOptions();
assert.strictEqual(next.fontSize, 16);
assert.strictEqual(next.scrollback, 8000);
assert.strictEqual(next.cursorBlink, false);
assert.strictEqual(next.theme.background, '#282c34');

console.log('✅ theme settings contract passed');
