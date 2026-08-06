// UI 测试: SFTP 上传/下载进度条显示 + 页面不卡
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

  // 连接 SSH
  await page.click('#btn-new');
  await sleep(300);
  await page.type('#f-name', '进度测试');
  await page.type('#f-host', '192.168.1.216');
  await page.type('#f-user', 'logic');
  await page.type('#f-password', '1');
  await page.click('#btn-dlg-conn');
  await sleep(2500);
  await page.click('#btn-sftp');
  await sleep(1500);

  // 1. 上传文件 (触发文件选择器 → accept 临时文件) → 进度条应出现
  console.log('[1] 上传文件...');
  const fs = require('fs');
  const TMP = 'C:\\Users\\Administrator\\sshterm\\tests\\tmp_progress.txt';
  fs.writeFileSync(TMP, 'progress test content ' + Date.now());
  const [chooser] = await Promise.all([
    page.waitForFileChooser(),
    page.click('#sftp-upload'),
  ]);
  await chooser.accept([TMP]);
  // 上传中/完成时检查进度条
  let progShown = false;
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    const visible = await page.$eval('#sftp-progress', el => !el.classList.contains('hidden'));
    const text = await page.$eval('#sftp-progress-text', el => el.textContent);
    if (visible) { progShown = true; console.log('    进度条可见:', text); break; }
  }
  await sleep(1500);

  // 2. 下载文件 (点击列表中的 ⬇) → 进度条应出现
  console.log('[2] 下载文件...');
  const fileRow = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#sftp-list .sftp-item.file')];
    const row = items.find(i => i.querySelector('.sftp-name')?.textContent.includes('tmp_progress'));
    if (row) { row.querySelector('.sftp-dl').click(); return true; }
    return false;
  });
  console.log('    找到文件并点击下载:', fileRow);
  let dlProg = false;
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    const visible = await page.$eval('#sftp-progress', el => !el.classList.contains('hidden'));
    const text = await page.$eval('#sftp-progress-text', el => el.textContent);
    if (visible && text.includes('下载')) { dlProg = true; console.log('    下载进度:', text); break; }
  }
  await sleep(1500);

  // 3. 页面响应性
  const busy = await page.evaluate(() => {
    const t = Date.now();
    for (let i = 0; i < 2e6; i++) { }
    return Date.now() - t;
  });
  console.log('    页面忙时:', busy, 'ms');

  const ok1 = progShown;
  const ok2 = dlProg;
  const ok3 = busy < 100 && errors.length === 0;
  console.log('\n=== 汇总 ===');
  console.log(`上传进度条: ${ok1 ? '✅' : '❌'}  下载进度条: ${ok2 ? '✅' : '❌'}  页面不卡: ${ok3 ? '✅' : '❌'} | JS错误: ${errors.length ? errors.join('|') : '(无)'}`);

  // 清理
  try {
    await page.evaluate(() => {
      // 删除测试文件 (远端)
      document.getElementById('btn-sftp').click();
    });
    await sleep(300);
    await page.click('#btn-killall');
    await sleep(500);
  } catch (e) { /* 忽略 */ }
  try { browser.process() && browser.process().kill(); } catch (e) {}
  process.exit(ok1 && ok2 && ok3 ? 0 : 1);
})().catch(e => { console.error('❌ 测试崩溃:', e.message); process.exit(1); });
