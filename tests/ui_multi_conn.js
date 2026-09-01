// UI 测试: 同 IP 开多个 SSH/Telnet 会话 (去重已移除)
const puppeteer = require('./puppeteer_test');
const EDGE = 'C:\\Users\\Administrator\\sshterm\\vendor\\chrome-headless-shell\\chrome-headless-shell.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8787/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => console.log('pageerror:', e.message));

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(1000);

  // 1. 开 2 个 SSH (同一 IP 192.168.1.216)
  console.log('[1] 开 2 个 SSH (同 IP)...');
  for (let i = 0; i < 2; i++) {
    await page.click('#btn-new');
    await sleep(300);
    await page.type('#f-name', `多会话SSH${i}`);
    await page.type('#f-host', '192.168.1.216');
    await page.type('#f-user', 'logic');
    await page.type('#f-password', '1');
    await page.click('#btn-dlg-conn');
    await sleep(2500);
  }
  let sshStates = await page.$$eval('.tab .t-state', els => els.map(e => e.textContent));
  console.log('    SSH 标签状态:', sshStates.join(','));

  // 2. 开 2 个 Telnet (同一 IP 192.168.1.123, 连不上但标签应独立存在)
  console.log('[2] 开 2 个 Telnet (同 IP)...');
  for (let i = 0; i < 2; i++) {
    await page.click('#btn-new');
    await sleep(300);
    await page.type('#f-name', `多会话Telnet${i}`);
    await page.select('#f-type', 'telnet');
    await page.type('#t-host', '192.168.1.123');
    await page.click('#btn-dlg-conn');
    await sleep(1500);
  }
  const tabCount = await page.$$eval('.tab', els => els.length);
  const telnetStates = await page.$$eval('.tab .t-state', els => els.map(e => e.textContent));
  console.log('    总标签数:', tabCount, '| 全部状态:', telnetStates.join(','));

  // 3. 验证无 "复用" 提示
  const termTexts = await page.evaluate(() => {
    const hosts = document.querySelectorAll('.term-host');
    return [...hosts].map(h => (h.querySelector('.xterm-rows')?.textContent || ''));
  });
  const hasReuse = termTexts.some(t => t.includes('复用'));
  console.log('    出现"复用"提示:', hasReuse);

  const ok1 = sshStates.filter(s => s === '🟢').length === 2;   // 2 个 SSH 都连接
  const ok2 = tabCount === 4 && !hasReuse;                        // 4 个标签独立, 无复用
  console.log('\n=== 汇总 ===');
  console.log(`2 个 SSH 同时连接: ${ok1 ? '✅' : '❌'}  4 标签独立无复用: ${ok2 ? '✅' : '❌'}`);

  // 清理: 全部断开
  await page.click('#btn-killall');
  await sleep(500);
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok1 && ok2 ? 0 : 1);
})().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
