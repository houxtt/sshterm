'use strict';
const { app, BrowserWindow, Menu, dialog, protocol, ipcMain } = require('electron');
const { Readable, PassThrough } = require('stream');
const path = require('path');
const fs = require('fs');
const trace = (stage) => {
  if (process.env.SSHTERM_SMOKE_FILE) fs.appendFileSync(`${process.env.SSHTERM_SMOKE_FILE}.trace`, `${stage}\n`);
};
trace('module loaded');
if (process.env.SSHTERM_SMOKE_FILE) {
  const smokeData = path.join(path.dirname(process.env.SSHTERM_SMOKE_FILE), 'electron-data');
  fs.mkdirSync(smokeData, { recursive: true });
  app.setPath('userData', smokeData);
}

protocol.registerSchemesAsPrivileged([{ scheme: 'sshterm', privileges: {
  standard: true, secure: true, supportFetchAPI: true,
} }]);

process.env.SSHTERM_DESKTOP = '1';
delete process.env.SSHTERM_TEST_HTTP;
let backend;
const sockets = new Map();
let mainWindow;

function setChineseMenu() {
  const clickToolbar = id => {
    const contents = mainWindow?.webContents;
    if (!contents || contents.isDestroyed()) return;
    contents.executeJavaScript(`document.getElementById(${JSON.stringify(id)})?.click()`, true).catch(() => {});
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [
      { label: '新建连接', accelerator: 'CmdOrCtrl+N', click: () => clickToolbar('btn-new') },
      { type: 'separator' },
      { label: '退出', role: 'quit' },
    ] },
    { label: '编辑', submenu: [
      { label: '撤销', role: 'undo' }, { label: '重做', role: 'redo' },
      { type: 'separator' },
      { label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' },
      { label: '粘贴', role: 'paste' }, { label: '全选', role: 'selectAll' },
    ] },
    { label: '查看', submenu: [
      { label: '重新加载', role: 'reload' },
      { label: '全屏', role: 'togglefullscreen' },
    ] },
    { label: '窗口', submenu: [
      { label: '最小化', role: 'minimize' }, { label: '关闭窗口', role: 'close' },
    ] },
    { label: '帮助', submenu: [
      { label: '关于 sshterm', click: () => dialog.showMessageBox({
        title: '关于 sshterm', message: `sshterm v${app.getVersion()}`,
        detail: 'SSH / Telnet / VNC / 串口桌面连接工具', buttons: ['确定'],
      }) },
    ] },
  ]));
}

function trusted(event) {
  return event.sender === mainWindow?.webContents &&
    event.senderFrame?.url?.startsWith('sshterm://app/');
}

function closeSocketsFor(webContentsId) {
  trace(`close sockets start ${sockets.size}`);
  for (const [id, entry] of sockets) {
    if (entry.owner !== webContentsId) continue;
    trace(`close socket ${id}`);
    try { entry.socket.close(); }
    catch (error) {
      trace(`socket close failed: ${error.stack || error}`);
      console.error('[desktop] socket close failed:', error);
    }
    trace(`socket closed ${id}`);
    sockets.delete(id);
  }
  trace('close sockets done');
}

async function serve(request) {
  const address = new URL(request.url);
  if (address.host !== 'app') return new Response('Not found', { status: 404 });
  const output = new PassThrough();
  let status = 200;
  let responseHeaders = {};
  let resolveHeaders;
  const headersReady = new Promise(resolve => { resolveHeaders = resolve; });
  let headersWritten = false;
  output.writeHead = (code, headers = {}) => {
    if (headersWritten) return output;
    status = code;
    responseHeaders = headers;
    headersWritten = true;
    output.headersSent = true;
    resolveHeaders();
    return output;
  };
  const end = output.end.bind(output);
  output.end = (...args) => {
    if (!headersWritten) output.writeHead(200);
    return end(...args);
  };
  const body = request.body ? Readable.fromWeb(request.body) : Readable.from([]);
  body.method = request.method;
  body.url = address.pathname + address.search;
  body.headers = Object.fromEntries(request.headers);
  body.headers['x-sshterm-token'] = backend.clientToken;
  let requestTimer;
  body.setTimeout = (ms, callback) => {
    clearTimeout(requestTimer);
    if (ms > 0) requestTimer = setTimeout(callback, ms);
    return body;
  };
  body.once('end', () => clearTimeout(requestTimer));
  body.once('close', () => clearTimeout(requestTimer));
  request.signal?.addEventListener('abort', () => {
    body.aborted = true;
    body.emit('aborted');
    body.destroy();
    output.destroy();
  }, { once: true });
  backend.desktopRequest(body, output);
  await headersReady;
  if (request.method === 'HEAD' || status === 204 || status === 304) {
    output.resume();
    return new Response(null, { status, headers: responseHeaders });
  }
  return new Response(Readable.toWeb(output), { status, headers: responseHeaders });
}

app.whenReady().then(() => {
  trace('app ready');
  setChineseMenu();
  backend = require('../server/index');
  trace('backend loaded');
  protocol.handle('sshterm', serve);
  ipcMain.handle('sshterm:open-socket', (event, id, url) => {
    if (!trusted(event) || typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid desktop socket');
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' || parsed.hostname !== 'app' || !['/', '/vnc'].includes(parsed.pathname)) throw new Error('Invalid socket path');
    if (sockets.has(id)) throw new Error('Duplicate socket');
    const owner = event.sender.id;
    const sender = event.sender;
    const socket = backend.openDesktopSocket(parsed.pathname + parsed.search, (kind, value) => {
      if (!sender.isDestroyed()) sender.send('sshterm:socket-event', { id, kind, value });
      if (kind === 'close') sockets.delete(id);
    });
    sockets.set(id, { owner, socket });
    return true;
  });
  ipcMain.on('sshterm:socket-send', (event, id, data) => {
    const entry = sockets.get(id);
    if (!trusted(event) || !entry || entry.owner !== event.sender.id) return;
    const binary = typeof data !== 'string';
    const payload = binary ? Buffer.from(data) : Buffer.from(data, 'utf8');
    if (payload.length <= 8 * 1024 * 1024) entry.socket.emit('message', payload, binary);
  });
  ipcMain.on('sshterm:socket-close', (event, id) => {
    const entry = sockets.get(id);
    if (trusted(event) && entry?.owner === event.sender.id) entry.socket.close();
  });

  const smokeFile = process.env.SSHTERM_SMOKE_FILE;
  mainWindow = new BrowserWindow({
    width: 1380, height: 860, minWidth: 850, minHeight: 560,
    show: !smokeFile,
    title: 'sshterm', icon: path.join(__dirname, '..', 'assets', 'sshterm.ico'),
    backgroundColor: '#1a1b26',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  trace('window created');
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== 'sshterm://app/') event.preventDefault();
  });
  mainWindow.webContents.on('did-start-navigation', () => closeSocketsFor(mainWindow.webContents.id));
  mainWindow.on('close', () => trace('window close'));
  mainWindow.on('closed', () => { trace('window closed'); mainWindow = null; });
  mainWindow.webContents.on('will-prevent-unload', () => trace('will prevent unload'));
  if (smokeFile) {
    const finish = (result) => {
      trace('smoke finished');
      try { fs.writeFileSync(smokeFile, JSON.stringify(result)); }
      finally { app.quit(); }
    };
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const result = await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
          const started = Date.now();
          const poll = () => {
            if (document.querySelector('#conn-status-text')?.textContent === '桌面通信已连接') {
              localStorage.setItem('sshterm.commands.127.0.0.1', JSON.stringify({ items: [{ name: 'Smoke', cmd: 'pwd' }] }));
              const tab = newTab({ type: 'ssh', host: '127.0.0.1', name: 'Smoke' }, { connect: false });
              setTabState(tab.id, 'connected', 'Smoke');
              renderCommandBar();
              const button = [...document.querySelectorAll('#quick-command-items button')].find(b => b.textContent === 'Smoke');
              button?.click();
              resolve({ connected: true, url: location.href,
                quickBar: !!document.querySelector('#quick-command-bar'),
                quickButton: !!button,
                commandSent: document.querySelector('#sb-left')?.textContent?.includes('已发送: pwd') || false,
                desktopBridge: !!window.sshtermDesktop,
                socketOpen: ws?.readyState === WebSocket.OPEN });
            } else if (Date.now() - started > 10000) reject(new Error('desktop transport did not connect'));
            else setTimeout(poll, 100);
          };
          poll();
        })`);
        result.sftpUpload = await mainWindow.webContents.executeJavaScript(`fetch('/api/sftp/upload?conn=9900&path=%2F&name=desktop-smoke.txt&token=' + encodeURIComponent(clientToken), {
          method: 'PUT', body: 'smoke'
        }).then(async response => response.ok && (await response.json()).ok)`);
        const holdMs = Math.min(60000, Math.max(0, Number(process.env.SSHTERM_SMOKE_HOLD_MS || 5000)));
        await new Promise(resolve => setTimeout(resolve, holdMs));
        result.responsiveAfterWait = await mainWindow.webContents.executeJavaScript('ws?.readyState === WebSocket.OPEN');
        const { SerialPort } = require('serialport');
        result.serialBinding = Array.isArray(await SerialPort.list());
        result.menuLabels = Menu.getApplicationMenu().items.map(item => item.label);
        if (process.env.SSHTERM_SMOKE_SCREENSHOT) {
          const shot = await mainWindow.webContents.capturePage();
          fs.writeFileSync(process.env.SSHTERM_SMOKE_SCREENSHOT, shot.toPNG());
        }
        finish(result);
      } catch (error) { finish({ error: String(error) }); }
    });
    mainWindow.webContents.once('did-fail-load', (_event, code, reason) => finish({ error: `load failed ${code}: ${reason}` }));
    mainWindow.webContents.once('render-process-gone', (_event, details) => finish({ error: `renderer gone: ${details.reason}` }));
  }
  mainWindow.loadURL('sshterm://app/');
  trace('load requested');
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  trace('before quit');
  if (mainWindow) closeSocketsFor(mainWindow.webContents.id);
  trace('sockets closed');
});
app.on('will-quit', () => trace('will quit'));
