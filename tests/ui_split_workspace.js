const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const PORT = 8896;
const BASE = `http://127.0.0.1:${PORT}/`;
const EDGE = require('./browser_path')(ROOT);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function waitForServer(deadline = Date.now() + 10000) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(BASE, res => {
        res.resume();
        res.statusCode === 200 ? resolve() : retry();
      });
      req.on('error', retry);
      req.setTimeout(500, () => { req.destroy(); retry(); });
    };
    const retry = () => Date.now() < deadline
      ? setTimeout(attempt, 100)
      : reject(new Error('server startup timed out'));
    attempt();
  });
}

(async () => {
  const server = spawn(process.execPath, ['server/index.js', '--port', String(PORT), '--no-open'], {
    cwd: ROOT, stdio: 'ignore',
  });
  let browser;
  try {
    await waitForServer();
    browser = await puppeteer.launch({
      executablePath: EDGE,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    await page.setViewport({ width: 1280, height: 800 });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof ws !== 'undefined' && ws.readyState === WebSocket.OPEN);

    // Build an offline tab so layout behavior is tested without external SSH
    // credentials or network availability.
    await page.evaluate(() => {
      localStorage.clear();
      window.__splitMessages = [];
      const originalSend = ws.send.bind(ws);
      ws.send = data => {
        try {
          const message = typeof data === 'string' ? JSON.parse(data) : null;
          if (message?.type === 'connect') window.__splitMessages.push(message);
        } catch {}
        return originalSend(data);
      };
      newTab({
        type: 'ssh', name: '布局测试', host: '127.0.0.1', port: 1,
        username: 'nobody', reconnect: false,
      }, { connect: false });
    });
    await page.click('#btn-split');
    await sleep(250);

    const split = await page.evaluate(() => {
      const container = document.querySelector('.split-container:not(.hidden)');
      const pane = container?.querySelector('.term-host.pane-split');
      const divider = container?.querySelector('.split-divider');
      return {
        panes: container?.querySelectorAll('.term-host.pane-split').length || 0,
        terminalReady: !!pane?.querySelector('.xterm'),
        direction: container?.style.flexDirection,
        dividerVisible: !!divider && getComputedStyle(divider).display !== 'none',
      };
    });
    assert.deepStrictEqual(split, {
      panes: 1, terminalReady: true, direction: 'row', dividerVisible: true,
    });
    const splitConnect = await page.evaluate(() => window.__splitMessages.find(message => message.id === 2));
    assert.strictEqual(splitConnect.sourceId, 1, 'split must identify its authenticated main connection');
    assert.deepStrictEqual(pageErrors, [], `split raised page errors: ${pageErrors.join('; ')}`);

    // The divider must resize terminal panes rather than resizing itself.
    const divider = await page.$('.split-divider');
    const dividerBox = await divider.boundingBox();
    const containerBox = await (await page.$('.split-container:not(.hidden)')).boundingBox();
    await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + 20);
    await page.mouse.down();
    await page.mouse.move(containerBox.x + containerBox.width * 0.35, dividerBox.y + 20);
    await page.mouse.up();
    const ratio = await page.$eval('.term-host.main-pane', element => parseFloat(element.style.flex));
    assert(ratio > 0.3 && ratio < 0.4, `unexpected split ratio ${ratio}`);

    // 2×2 grid: adding a third pane must reveal draggable grid dividers.
    await page.click('#btn-split');
    await sleep(350);
    const grid = await page.evaluate(() => {
      const container = document.querySelector('.split-container:not(.hidden)');
      const dividers = [...(container?.querySelectorAll('.split-divider') || [])];
      return {
        panes: container?.querySelectorAll('.term-host.pane-split').length || 0,
        display: container?.style.display,
        cols: container?.style.gridTemplateColumns,
        rows: container?.style.gridTemplateRows,
        gridDividers: dividers.filter(d => d.classList.contains('grid-divider')
          && getComputedStyle(d).display !== 'none').length,
      };
    });
    assert.strictEqual(grid.panes, 2, 'third split must add a second extra pane');
    assert.strictEqual(grid.display, 'grid');
    assert.strictEqual(grid.gridDividers, 2, '2×2 grid must show both grid dividers');
    assert(grid.cols.includes('fr') && grid.rows.includes('fr'));

    // Drag the vertical grid divider: column ratio must change and persist.
    const containerBox2 = await (await page.$('.split-container:not(.hidden)')).boundingBox();
    const vDivider = await page.$('.split-divider.grid-divider:not(.col)');
    const vBox = await vDivider.boundingBox();
    // Grab away from the center crossing, where the horizontal divider overlays.
    await page.mouse.move(vBox.x + vBox.width / 2, vBox.y + 30);
    await page.mouse.down();
    await page.mouse.move(containerBox2.x + containerBox2.width * 0.3, vBox.y + 30);
    await page.mouse.up();
    await sleep(100);
    const gridAfter = await page.evaluate(() => {
      const container = document.querySelector('.split-container:not(.hidden)');
      const tab = tabs.find(t => t.id === activeTabId);
      return {
        cols: container.style.gridTemplateColumns,
        saved: JSON.parse(localStorage.getItem('sshterm.split') || '{}')[tab.id]?.grid,
      };
    });
    const colRatio = parseFloat(gridAfter.cols);
    assert(colRatio > 0.24 && colRatio < 0.36, `unexpected grid col ratio ${colRatio}`);
    assert(gridAfter.saved && Math.abs(gridAfter.saved.col - colRatio) < 0.001,
      'grid col ratio must persist to sshterm.split prefs');

    // Drag the horizontal grid divider: row ratio must change and persist.
    const hDivider = await page.$('.split-divider.grid-divider.col');
    const hBox = await hDivider.boundingBox();
    // Same here: avoid the center crossing, where the vertical divider overlays.
    await page.mouse.move(hBox.x + 30, hBox.y + hBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(hBox.x + 30, containerBox2.y + containerBox2.height * 0.7);
    await page.mouse.up();
    await sleep(100);
    const gridAfter2 = await page.evaluate(() => {
      const container = document.querySelector('.split-container:not(.hidden)');
      const tab = tabs.find(t => t.id === activeTabId);
      return {
        rows: container.style.gridTemplateRows,
        saved: JSON.parse(localStorage.getItem('sshterm.split') || '{}')[tab.id]?.grid,
      };
    });
    const rowRatio = parseFloat(gridAfter2.rows);
    assert(rowRatio > 0.64 && rowRatio < 0.76, `unexpected grid row ratio ${rowRatio}`);
    assert(gridAfter2.saved && Math.abs(gridAfter2.saved.row - rowRatio) < 0.001,
      'grid row ratio must persist to sshterm.split prefs');
    assert.deepStrictEqual(pageErrors, [], `grid drag raised page errors: ${pageErrors.join('; ')}`);

    // Back to 2 panes: flex layout and its single divider must be restored.
    await page.click('.term-host.pane-split .pane-close');
    await sleep(250);
    const backToTwo = await page.evaluate(() => {
      const container = document.querySelector('.split-container:not(.hidden)');
      const dividers = [...(container?.querySelectorAll('.split-divider') || [])];
      return {
        panes: container?.querySelectorAll('.term-host.pane-split').length || 0,
        display: container?.style.display,
        flexDirection: container?.style.flexDirection,
        visibleDividers: dividers.filter(d => getComputedStyle(d).display !== 'none').length,
      };
    });
    assert.deepStrictEqual(backToTwo, { panes: 1, display: '', flexDirection: 'row', visibleDividers: 1 });
    assert.deepStrictEqual(pageErrors, [], `grid teardown raised page errors: ${pageErrors.join('; ')}`);

    await page.click('#btn-workspace');
    assert.strictEqual(await page.$eval('#dlg-workspace-mask', el => !el.classList.contains('hidden')), true);
    await page.click('#workspace-save');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('sshterm.workspace.default')));
    assert.strictEqual(saved.version, 1);
    assert.strictEqual(saved.tabs.length, 1);
    assert.strictEqual(saved.tabs[0].id, 1);
    assert.strictEqual(saved.tabs[0].panes, 1);
    // The first extra pane (id 2) was closed above; pane id 3 remains.
    assert.deepStrictEqual(saved.tabs[0].paneIds, [3]);
    assert(saved.tabs[0].split.ratio > 0.3 && saved.tabs[0].split.ratio < 0.4);

    // Change the live layout, then prove workspace restore recreates it.
    await page.click('#workspace-close');
    // Split now adds a pane; close the remaining extra pane to change the live layout.
    await page.click('.term-host.pane-split .pane-close');
    assert.strictEqual(await page.$$eval('.term-host.pane-split', elements => elements.length), 0);
    await page.click('#btn-workspace');
    await page.click('#workspace-restore');
    await sleep(350);
    const restored = await page.evaluate(() => ({
      tabs: document.querySelectorAll('#tabbar .tab').length,
      panes: document.querySelectorAll('.split-container:not(.hidden) .term-host.pane-split').length,
      workspaceClosed: document.querySelector('#dlg-workspace-mask').classList.contains('hidden'),
    }));
    assert.deepStrictEqual(restored, {
      tabs: 1, panes: 1, workspaceClosed: true,
    });
    assert.deepStrictEqual(pageErrors, [], `workspace raised page errors: ${pageErrors.join('; ')}`);
    console.log('✅ split pane and workspace browser regression passed');
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => {
  console.error('❌', error.stack || error.message);
  process.exit(1);
});
