const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');

function objectBetween(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from + start.length);
  assert(from >= 0 && to > from, `missing i18n block ${start}`);
  const literal = app.slice(from + start.length, to).trim().replace(/;$/, '');
  return vm.runInNewContext(`(${literal})`, Object.create(null));
}

const textMap = objectBetween('const DOM_TEXT_EN = ', 'const DOM_ATTR_EN = ');
const attrMap = objectBetween('const DOM_ATTR_EN = ', 'const i18nTextKeys = ');
const cjk = /[\u4e00-\u9fff]/u;
const decode = value => value
  .replace(/&#10;/g, '\n')
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .trim();

const staticTexts = [...html.matchAll(/>([^<>]*[\u4e00-\u9fff][^<>]*)</gu)]
  .map(match => decode(match[1]))
  .filter(Boolean);
const staticAttrs = [...html.matchAll(/(?:title|placeholder)="([^"]*[\u4e00-\u9fff][^"]*)"/gu)]
  .map(match => decode(match[1]))
  .filter(Boolean);

const missingText = [...new Set(staticTexts.filter(value => !textMap[value]))];
const missingAttrs = [...new Set(staticAttrs.filter(value => !attrMap[value]))];
assert.deepStrictEqual(missingText, [], `untranslated HTML text: ${missingText.join(' | ')}`);
assert.deepStrictEqual(missingAttrs, [], `untranslated HTML attributes: ${missingAttrs.join(' | ')}`);
assert(app.includes('new MutationObserver('), 'dynamic controls must be translated after rendering');
assert(html.includes('<html lang="zh-CN" translate="no" class="notranslate">'),
  'browser translation must be disabled so it cannot overwrite the app language');
assert(html.includes('<meta name="google" content="notranslate">'),
  'Google/Chrome translation opt-out marker is required');
assert(app.includes("'btn-split': 'btn_split'"), 'split button needs a direct language binding');
assert(app.includes("'side-title': 'side_title'"), 'saved-session title needs a direct language binding');
assert(html.includes('<option value="serial">Serial</option>'),
  'the protocol selector must use the language-neutral Serial name');
assert(cjk.test('中文') && !cjk.test('English'));

console.log('✅ English UI static/dynamic translation contract passed');
