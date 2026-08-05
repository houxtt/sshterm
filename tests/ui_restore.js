// UI 测试: 刷新页面后打开的会话自动恢复 (标签保留 + 自动重连)
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
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

  // 1. 打开 2 个 SSH 连接
  console.log('[1] 打开 2 个 SSH 连接...');
  for (let i = 0; i < 2; i++) {
    await page.click('#btn-new');
    await sleep(300);
    await page.type('#f-name', `恢复测试${i}`);
    await page.type('#f-host', '192.168.1.216');
    await page.type('#f-user', 'logic');
    await page.type('#f-password', '1');
    await page.click('#btn-dlg-conn');
    await sleep(2200);
  }
  const before = await page.$$eval('.tab', els => els.length);
  const lsBefore = await page.evaluate(() => localStorage.getItem('sshterm.tabs') || '');
  console.log('    标签数:', before, '| localStorage 已存:', lsBefore.length > 0);

  // 2. 刷新页面
  console.log('[2] 刷新页面 (重新加载此页面)...');
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(5000);

  // 3. 验证标签自动恢复 + 自动重连
  const after = await page.$$eval('.tab', els => els.length);
  const states = await page.$$eval('.tab .t-state', els => els.map(e => e.textContent));
  const welcomeHidden = await page.$eval('#welcome', el => el.classList.contains('hidden'));
  const statusText = await page.$eval('#sb-left', el => el.textContent);
  console.log('[3] 刷新后标签数:', after, '| 状态点:', states.join(','), '| 欢迎页隐藏:', welcomeHidden);
  console.log('    状态栏:', JSON.stringify(statusText));

  // 4. 验证恢复的连接可用 (逐个激活标签检查渲染)
  console.log('[4] 验证恢复的连接可用 (逐个激活)...');
  let shellReady = false;
  const tabN = await page.$$eval('.tab', els => els.length);
  for (let i = 0; i < tabN; i++) {
    await page.evaluate((idx) => {
      const tabs = document.querySelectorAll('.tab');
      if (tabs[idx]) tabs[idx].click();
    }, i);
    await sleep(1200);
    const text = await page.evaluate(() => {
      const h = document.querySelector('.term-host:not(.hidden)');
      return h ? (h.querySelector('.xterm-rows')?.textContent || '') : '';
    });
    console.log(`    标签${i}: ${text.length} 字符 | 含$: ${text.includes('$')}`);
    if (text.includes('$') || text.length > 50) shellReady = true;
  }
  console.log('    恢复后 shell 就绪:', shellReady);

  // 清理: 全部断开 (避免影响后续)
  await page.click('#btn-killall');
  await sleep(500);
  const cleaned = await page.$$eval('.tab', els => els.length);

  const ok1 = before === 2 && lsBefore.length > 0;
  const ok2 = after === 2 && welcomeHidden && !states.includes('🔴');
  const ok3 = shellReady && cleaned === 0 && errors.length === 0;
  console.log('\n=== 汇总 ===');
  console.log(`打开并保存: ${ok1 ? '✅' : '❌'}  刷新自动恢复: ${ok2 ? '✅' : '❌'}  连接可用+清理: ${ok3 ? '✅' : '❌'} | JS错误: ${errors.length ? errors.join('|') : '(无)'}`);
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok1 && ok2 && ok3 ? 0 : 1);
})().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
