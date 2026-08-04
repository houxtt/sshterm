// 定位: 为什么 puppeteer.click 不触发 onclick
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1000));

  // 1. 按钮几何信息
  const geo = await page.evaluate(() => {
    const el = document.getElementById('btn-new');
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      rect: { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom },
      hitTest: top ? `${top.tagName}#${top.id}.${top.className}` : 'null',
      isBtn: top === el,
      btnClass: el.className,
      disabled: el.disabled,
    };
  });
  console.log('=== 按钮几何 ===');
  console.log(geo);

  // 2. el.click() 直触发
  await page.evaluate(() => document.getElementById('btn-new').click());
  await new Promise(r => setTimeout(r, 300));
  const afterElClick = await page.$eval('#dlg-mask', el => el.className);
  console.log('\nel.click() 后 dlg-mask class:', JSON.stringify(afterElClick));

  // 关掉再试 puppeteer.click
  await page.evaluate(() => document.getElementById('dlg-mask').classList.add('hidden'));
  await page.click('#btn-new');
  await new Promise(r => setTimeout(r, 300));
  const afterPpClick = await page.$eval('#dlg-mask', el => el.className);
  console.log('puppeteer.click 后 dlg-mask class:', JSON.stringify(afterPpClick));

  // 3. 试有头模式对照? 先输出 viewport 内可见性
  console.log('\n=== 结论 ===');
  console.log(afterElClick.includes('hidden') === false
    ? 'el.click() 有效 → 事件绑定没问题'
    : 'el.click() 也无效 → 逻辑层问题');
  await browser.close();
})();
