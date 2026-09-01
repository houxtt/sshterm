// UI 测试: 快捷命令 (保存/记忆/执行) + 连接后自动执行脚本
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

  // 连接 SSH
  await page.click('#btn-new');
  await sleep(300);
  await page.type('#f-name', '命令测试');
  await page.type('#f-host', '192.168.1.216');
  await page.type('#f-user', 'logic');
  await page.type('#f-password', '1');
  // 连接后自动执行脚本
  await page.type('#f-autocmds', 'echo AUTO_CMD_1\necho AUTO_CMD_2');
  await page.click('#btn-dlg-conn');
  await sleep(3000);

  // 1. 连接后自动执行
  const autoOk = await page.evaluate(() => {
    const h = document.querySelector('.term-host:not(.pane1)');
    const text = h?.querySelector('.xterm-rows')?.textContent || '';
    return text.includes('AUTO_CMD_1') && text.includes('AUTO_CMD_2');
  });
  console.log('[1] 连接后自动执行脚本:', autoOk);

  // 2. 打开命令面板, 保存命令并勾选自动执行 (IP: 192.168.1.216)
  console.log('[2] 打开⚡命令面板保存命令(IP: 192.168.1.216)...');
  await page.click('#btn-cmds');
  await sleep(300);
  const cur1 = await page.$eval('#cmd-cur', el => el.textContent);
  console.log('    面板:', JSON.stringify(cur1));
  await page.type('#cmd-name', '查看主机名');
  await page.type('#cmd-content', 'hostname');
  await page.click('#cmd-auto');       // 连接后自动执行
  await page.click('#btn-cmd-add');
  await sleep(300);
  const listCount = await page.$$eval('#cmd-list .cmd-item', els => els.length);
  console.log('    IP 216 命令数:', listCount);
  await page.click('#cmds-close');

  // 3. 同 IP 另一会话 → 命令集共享
  console.log('[3] 同 IP(192.168.1.216)另一会话 → 命令集共享...');
  await page.click('#btn-new');
  await sleep(300);
  await page.type('#f-name', '同IP会话');
  await page.type('#f-host', '192.168.1.216');
  await page.type('#f-user', 'logic');
  await page.type('#f-password', '1');
  await page.click('#btn-dlg-conn');
  await sleep(2500);
  await page.click('#btn-cmds');
  await sleep(300);
  const sharedCount = await page.$$eval('#cmd-list .cmd-item', els => els.length);
  const curSame = await page.$eval('#cmd-cur', el => el.textContent);
  console.log('    同 IP 命令数(应共享=1):', sharedCount, '|', JSON.stringify(curSame));
  await page.click('#cmds-close');

  // 4. 不同 IP → 命令集独立 (空)
  console.log('[4] 不同 IP(192.168.1.123)会话 → 命令集独立...');
  await page.click('#btn-new');
  await sleep(300);
  await page.type('#f-name', '不同IP');
  await page.select('#f-type', 'telnet');
  await page.type('#t-host', '192.168.1.123');
  await page.click('#btn-dlg-conn');
  await sleep(1500);
  await page.click('#btn-cmds');
  await sleep(300);
  const otherCount = await page.$$eval('#cmd-list .cmd-item', els => els.length);
  const curOther = await page.$eval('#cmd-cur', el => el.textContent);
  console.log('    不同 IP 命令数(应独立=0):', otherCount, '|', JSON.stringify(curOther));
  await page.click('#cmds-close');

  // 5. auto 自动执行: 重连 216 会话 (auto 命令集应自动执行)
  console.log('[5] 重连 216, 验证命令集 auto 自动执行...');
  await page.click('#btn-killall');
  await sleep(600);
  await page.click('#btn-new');
  await sleep(300);
  await page.type('#f-name', 'auto验证');
  await page.type('#f-host', '192.168.1.216');
  await page.type('#f-user', 'logic');
  await page.type('#f-password', '1');
  await page.click('#btn-dlg-conn');
  await sleep(3500);
  const autoCmdOk = await page.evaluate(() => {
    const h = document.querySelector('.term-host:not(.pane1)');
    const text = h?.querySelector('.xterm-rows')?.textContent || '';
    return text.includes('hostname');
  });
  console.log('    auto 命令集自动执行:', autoCmdOk);

  const ok = listCount === 1 && sharedCount === 1 && otherCount === 0 && autoCmdOk;
  console.log(`\n=== 汇总: ${ok ? '✅ IP级命令集/自动执行/共享独立 正常' : '❌'} ===`);

  // 清理 (删除测试命令集)
  await page.evaluate(() => {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('sshterm.commands.')) localStorage.removeItem(k);
    }
  });
  try {
    await page.click('#btn-killall');
    await sleep(500);
  } catch (e) { /* 忽略 */ }
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
