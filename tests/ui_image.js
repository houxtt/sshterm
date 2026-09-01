// UI 回归: SSH 会话内联图片显示 (Sixel + iTerm2 OSC 1337)
// 直接在 SSH 标签的终端里写入图片序列, 断言图片进入插件存储并落到缓冲区单元格。
const puppeteer = require('./puppeteer_test');
const URL = process.argv[2] || 'http://127.0.0.1:8787/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) errors.push('console: ' + m.text());
  });

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(1200);

  console.log('[1] 建立 SSH 标签 (不发起真实连接)...');
  const created = await page.evaluate(() => {
    const tab = newTab({ type: 'ssh', name: '图片显示验证', host: '127.0.0.1', port: 1,
      user: 'sshterm', password: '', auth: 'password' }, { connect: false });
    return !!tab && !!tab.imageAddon;
  });
  console.log('    标签+图片插件:', created ? '✅' : '❌');
  await sleep(400);

  console.log('[2] Sixel 图片 (1 像素方阵)...');
  const sixel = await page.evaluate(async () => {
    const tab = tabs.find(t => t.cfg.name === '图片显示验证');
    const before = tab.imageAddon.storageUsage;
    tab.term.write('\x1bPq"1;1;1;1#0;2;0;0;0#1;2;100;0;0#1@\x1b\\');
    await new Promise(r => setTimeout(r, 700));
    return { before, after: tab.imageAddon.storageUsage, cell: !!tab.imageAddon.getImageAtBufferCell(0, 0) };
  });
  console.log(`    存储 ${sixel.before} → ${sixel.after} MB | 单元格有图: ${sixel.cell ? '✅' : '❌'}`);

  console.log('[3] iTerm2 内联图片 (OSC 1337, 64x64 PNG)...');
  const iip = await page.evaluate(async () => {
    const tab = tabs.find(t => t.cfg.name === '图片显示验证');
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#ff0000'; g.fillRect(0, 0, 64, 64);
    const b64 = c.toDataURL('image/png').split(',')[1];
    const before = tab.imageAddon.storageUsage;
    tab.term.write(`\x1b]1337;File=inline=1;size=${atob(b64).length}:${b64}\x1b\\`);
    await new Promise(r => setTimeout(r, 900));
    return { before, after: tab.imageAddon.storageUsage };
  });
  console.log(`    存储 ${iip.before} → ${iip.after} MB`);

  console.log('[4] 能力声明 (DA1 需带 sixel=62)...');
  const da1 = await page.evaluate(() => new Promise(resolve => {
    const tab = tabs.find(t => t.cfg.name === '图片显示验证');
    const chunks = [];
    const disp = tab.term.onData(d => chunks.push(d));
    tab.term.write('\x1b[c');
    setTimeout(() => { disp.dispose(); resolve(chunks.join('')); }, 700);
  }));
  console.log('    DA1:', JSON.stringify(da1));

  console.log('[5] 清理测试标签...');
  await page.evaluate(() => {
    const tab = tabs.find(t => t.cfg.name === '图片显示验证');
    if (tab) doCloseTab(tab.id);
  });
  await sleep(400);
  const cleaned = await page.evaluate(() => !tabs.some(t => t.name === '图片显示验证'));
  console.log('    标签已关闭:', cleaned ? '✅' : '❌');

  const noWasmError = !errors.some(e => /WebAssembly|unsafe-eval/i.test(e));
  const ok = created && sixel.after > sixel.before && sixel.cell
    && iip.after > iip.before && /62/.test(da1) && cleaned
    && errors.length === 0 && noWasmError;
  console.log('\n=== 汇总 ===');
  console.log(`Sixel: ${sixel.cell ? '✅' : '❌'}  iTerm2: ${iip.after > iip.before ? '✅' : '❌'}  `
    + `DA1 sixel: ${/62/.test(da1) ? '✅' : '❌'}  清理: ${cleaned ? '✅' : '❌'}  `
    + `JS 错误: ${errors.length ? '❌ ' + errors.join(' | ') : '(无) ✅'}`);
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
