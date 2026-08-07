// UI 测试: 刷新页面后打开的会话自动恢复 (标签保留 + 自动重连)
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Users\\Administrator\\sshterm\\vendor\\chrome-headless-shell\\chrome-headless-shell.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8787/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(1000);

  // 1. 打开 1 个 SSH 连接并产生输出内容
  console.log('[1] 打开 SSH 连接并产生终端内容...');
  await page.click('#btn-new');
  await sleep(300);
  await page.type('#f-name', '恢复测试');
  await page.type('#f-host', '192.168.1.216');
  await page.type('#f-user', 'logic');
  await page.type('#f-password', '1');
  await page.click('#btn-dlg-conn');
  await sleep(2500);
  // 发命令产生输出 (内容标记)
  await page.keyboard.type('echo CONTENT_MARKER_123\n');
  await sleep(1500);
  const hasMarker = await page.evaluate(() => {
    const h = document.querySelector('.term-host:not(.hidden)');
    return h ? (h.querySelector('.xterm-rows')?.textContent || '').includes('CONTENT_MARKER_123') : false;
  });
  const lsBefore = await page.evaluate(() => (localStorage.getItem('sshterm.tabs') || '').length);
  console.log('    终端含输出标记:', hasMarker, '| localStorage 长度:', lsBefore);

  // 2. 刷新页面
  console.log('[2] 刷新页面 (重新加载此页面)...');
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(5000);

  // 3. 验证标签恢复 + 旧终端内容保留
  const after = await page.$$eval('.tab', els => els.length);
  const statusText = await page.$eval('#sb-left', el => el.textContent);
  console.log('[3] 刷新后标签数:', after, '| 状态栏:', JSON.stringify(statusText));
  const restored = await page.evaluate(() => {
    const hosts = document.querySelectorAll('.term-host');
    for (const h of hosts) {
      const text = h.querySelector('.xterm-rows')?.textContent || '';
      if (text.includes('CONTENT_MARKER_123')) return '内容已恢复';
      if (text.includes('连接已重新建立')) return '有重连标记但无旧内容';
    }
    return '无旧内容';
  });
  console.log('[4] 旧终端内容:', restored);

  // 清理: 全部断开 (避免影响后续)
  await page.click('#btn-killall');
  await sleep(500);
  const cleaned = await page.$$eval('.tab', els => els.length);

  const ok1 = hasMarker && lsBefore > 100;
  const ok2 = after === 1 && statusText.includes('已恢复');
  const ok3 = restored === '内容已恢复' && cleaned === 0;
  console.log('\n=== 汇总 ===');
  console.log(`产生内容: ${ok1 ? '✅' : '❌'}  刷新恢复标签: ${ok2 ? '✅' : '❌'}  旧内容保留: ${ok3 ? '✅' : '❌'}`);
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok1 && ok2 && ok3 ? 0 : 1);
})().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
