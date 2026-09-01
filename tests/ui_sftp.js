// UI 测试: SFTP 面板点击目录 (复现 "No such file" 报错)
const puppeteer = require('./puppeteer_test');
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

  // 连接 SSH
  await page.click('#btn-new');
  await sleep(300);
  await page.type('#f-name', 'SFTP UI 测试');
  await page.type('#f-host', '192.168.1.216');
  await page.type('#f-user', 'logic');
  await page.type('#f-password', '1');
  await page.click('#btn-dlg-conn');
  await sleep(2500);

  // 打开文件面板
  console.log('[1] 打开文件面板...');
  await page.click('#btn-sftp');
  await sleep(1000);
  const pathVal = await page.$eval('#sftp-path', el => el.value);
  const itemCount = await page.$$eval('#sftp-list .sftp-item', els => els.length);
  const status = await page.$eval('#sftp-status', el => el.textContent);
  console.log('    路径:', JSON.stringify(pathVal), '| 条目:', itemCount, '| 状态:', JSON.stringify(status));

  // 点击目录两次 (模拟双击/连点, 曾导致路径重复拼接报 No such file)
  const dirName = await page.evaluate(() => {
    const d = document.querySelector('#sftp-list .sftp-item.dir .sftp-name');
    return d ? d.textContent : null;
  });
  console.log('[2] 连点目录两次 (模拟双击):', dirName);
  await page.click('#sftp-list .sftp-item.dir');
  await page.click('#sftp-list .sftp-item.dir');   // 第二次点击应在锁内被忽略
  await sleep(1200);

  const pathVal2 = await page.$eval('#sftp-path', el => el.value);
  const status2 = await page.$eval('#sftp-status', el => el.textContent);
  const itemCount2 = await page.$$eval('#sftp-list .sftp-item', els => els.length);
  const termHasErr = await page.evaluate(() => {
    const rows = document.querySelector('.term-host:not(.hidden) .xterm-rows');
    return rows ? rows.textContent.includes('No such file') : false;
  });
  console.log('[3] 进入后路径:', JSON.stringify(pathVal2), '| 条目:', itemCount2, '| 状态:', JSON.stringify(status2), '| 终端含报错:', termHasErr);

  // 返回上级
  console.log('[4] 返回上级...');
  await page.click('#sftp-up');
  await sleep(1000);
  const pathVal3 = await page.$eval('#sftp-path', el => el.value);
  const itemCount3 = await page.$$eval('#sftp-list .sftp-item', els => els.length);
  console.log('[5] 返回后路径:', JSON.stringify(pathVal3), '| 条目:', itemCount3);

  const ok1 = pathVal === '/home/logic' && itemCount > 0;
  const ok2 = itemCount2 > 0 && !termHasErr && pathVal2 === `${pathVal}/${dirName}`;   // 只进一层且无报错
  const ok3 = pathVal3 === pathVal && itemCount3 === itemCount;
  console.log('\n=== 汇总 ===');
  console.log(`面板加载: ${ok1 ? '✅' : '❌'}  进入目录: ${ok2 ? '✅' : '❌'}  返回上级: ${ok3 ? '✅' : '❌'} | JS错误: ${errors.length ? errors.join('|') : '(无)'}`);

  // 清理
  try {
    await page.evaluate(() => {
      document.getElementById('btn-sftp').click();  // 关面板(若开着)
      // 关闭标签(走确认)
      const close = document.querySelector('.tab .t-close');
      if (close) { close.click(); }
    });
    await sleep(300);
    await page.click('#btn-close-ok').catch(() => {});
    await sleep(300);
    // 删测试会话
    await page.evaluate(() => {
      document.getElementById('btn-batch').click();
      const boxes = [...document.querySelectorAll('#session-list .b-cb')]
        .filter(b => /^SFTP UI 测试/.test(b.closest('.s-row').querySelector('.s-name').textContent));
      boxes.forEach(b => b.click());
      if (boxes.length) document.getElementById('batch-del').click();
    });
    await sleep(300);
  } catch (e) { /* 清理失败忽略 */ }
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok1 && ok2 && ok3 ? 0 : 1);
})().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
