// 静态契约: SSH 会话内联图片显示 (Sixel / iTerm2 OSC 1337)
// 这些断言守护"图片能显示"的前提条件, 任何一条被破坏都会让远程图片静默失效。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// 1) @xterm/addon-image 的 Sixel 解码器是内联 WebAssembly 模块。
//    CSP 只有 script-src 'self' 时 Chrome 拒绝 WebAssembly.instantiate(),
//    插件静默失败 → 终端里永远看不到图片。
assert(server.includes("script-src 'self' 'wasm-unsafe-eval'"),
  'CSP must allow wasm-unsafe-eval or the Sixel decoder cannot compile');
assert(/img-src 'self' data: blob:/.test(server),
  'CSP img-src must allow blob: for the addon Image fallback path');

// 2) 插件脚本必须随终端一起加载
assert(html.includes('/vendor/@xterm/addon-image/lib/addon-image.js'),
  'index.html must load @xterm/addon-image');
assert((pkg.dependencies || {})['@xterm/addon-image'],
  'package.json must depend on @xterm/addon-image');

// 3) SSH 终端必须挂上插件, 并开启两种主流协议
assert(/attachImageAddon\(term,\s*cfg\.type\)/.test(app),
  'the image addon must be attached when a session terminal is created');
assert(/attachImageAddon\(term,\s*tabOrPane\.cfg\?\.type\)/.test(app),
  'split panes must attach the image addon too');
assert(/connectionType !== 'ssh'/.test(app),
  'inline images stay opt-in for SSH sessions only');
for (const flag of ['sixelSupport: true', 'iipSupport: true', 'enableSizeReports: true', 'showPlaceholder: true']) {
  assert(app.includes(flag), `image addon option ${flag} must stay enabled`);
}

// 4) 刷新重放: 200KB 快照可能截断在图片中间, 未收尾的序列会让解析器吞掉后续输出
assert(app.includes('stripTruncatedSequence(opts.replay)'),
  'replay must drop a truncated inline image sequence');
assert(/function stripTruncatedSequence/.test(app) && /'\\x1bP'/.test(app),
  'the replay sanitizer must recognise Sixel/OSC/APC introducers');

// 5) 容量上限: 缩放到终端宽度之前先按原始像素判定, 上限过低会让普通照片静默消失
const pixelLimit = Number((app.match(/pixelLimit:\s*(\d+)\s*\*\s*1024\s*\*\s*1024/) || [])[1]);
assert(pixelLimit >= 8, `pixelLimit must accept full-size photos (got ${pixelLimit}MP)`);
const storageLimit = Number((app.match(/storageLimit:\s*(\d+)/) || [])[1]);
assert(storageLimit >= 32, `storageLimit must keep a scrollback of images (got ${storageLimit}MB)`);

console.log('✅ SSH 内联图片(Sixel / iTerm2)静态契约通过');
