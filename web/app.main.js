// sshterm frontend main glue — edit web/js/* + this file; run node scripts/sync-web-app.js
// AUTO note: web/app.js is the concat artifact used by tests and (optionally) a single-bundle load.

// sshterm 前端: 多标签终端 + 会话管理
/* global Terminal, WebSocket */

// ---------- 工具 ----------
// $ is defined in web/js/dom.js (loaded first)
const hexOf = (u8) => Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join(' ').toUpperCase();
const Enc = () => window.SshtermEncoding || {
  encodeText: (s) => new TextEncoder().encode(s),
  decodeBuffer: (u8, enc) => new TextDecoder(enc || 'utf-8', { fatal: false }).decode(u8),
  StreamingDecoder: class { constructor(enc) { this.dec = new TextDecoder(enc || 'utf-8', { fatal: false }); } decode(c) { return this.dec.decode(c, { stream: true }); } },
};
const CAPTURE_MAX = 8 * 1024 * 1024;

// 原始抓包格式: HEX + 右侧 ASCII 对照 (可打印字符显示原文, 不可打印显示 .)
function hexdumpLine(data) {
  const bytes = new Uint8Array(data);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ').toUpperCase();
  const ascii = Array.from(bytes).map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('');
  return `${hex.padEnd(48, ' ')} │ ${ascii}`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// FitAddon/SearchAddon 兼容: UMD 可能是 { Xxx: class } 命名空间
const FitAddonCtor = (typeof FitAddon === 'function') ? FitAddon
  : (window.FitAddon && window.FitAddon.FitAddon);
const SearchAddonCtor = (typeof SearchAddon === 'function') ? SearchAddon
  : (window.SearchAddon && window.SearchAddon.SearchAddon);
const ImageAddonCtor = (typeof ImageAddon === 'function') ? ImageAddon
  : (window.ImageAddon && window.ImageAddon.ImageAddon);
if (typeof Terminal !== 'function' || !FitAddonCtor) {
  document.body.innerHTML = '<div style="padding:40px;font:14px sans-serif;color:#f87171">' +
    '❌ 终端核心加载失败(xterm.js / addon-fit), 请刷新或检查服务端资源。</div>';
  throw new Error('terminal core missing');
}

// Inline images for SSH terminals (Sixel + iTerm2 OSC 1337).  pixelLimit caps
// the *source* size before the addon scales the image down to the terminal, so
// a low value silently drops ordinary photos: keep one full-frame camera image
// (16 megapixels) acceptable while storage stays far below the addon default.
const IMAGE_ADDON_OPTIONS = Object.freeze({
  enableSizeReports: true,
  pixelLimit: 16 * 1024 * 1024,
  storageLimit: 64,
  showPlaceholder: true,
  sixelSupport: true,
  sixelScrolling: true,
  sixelPaletteLimit: 256,
  sixelSizeLimit: 16 * 1024 * 1024,
  iipSupport: true,
  iipSizeLimit: 16 * 1024 * 1024,
});
function attachImageAddon(term, connectionType) {
  if (connectionType !== 'ssh' || !ImageAddonCtor) return null;
  try {
    const addon = new ImageAddonCtor(IMAGE_ADDON_OPTIONS);
    term.loadAddon(addon);
    return addon;
  } catch (error) {
    console.error('[image-addon] SSH inline image support unavailable:', error);
    return null;
  }
}

// `display <远程图片>` 经 SFTP 拉取到本地后, 用 ImageAddon 直接在终端内联渲染,
// 无需远端有 X server / ImageMagick 图形界面。仅在 SSH 会话 (imageAddon 存在) 拦截。
function handleUserInput(tab, data) {
  const connId = tab.connId != null ? tab.connId : tab.id;
  let line = tab._inputLine || '';
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '\r' || ch === '\n') {
      const m = /^\s*display\b([\s\S]*)$/.exec(line);
      if (m && tab.imageAddon) {
        const paths = pickDisplayPaths(m[1]);
        tab._inputLine = '';
        if (paths.length) displaySequence(tab, connId, paths);
        return;
      }
      line = '';
    } else if (ch === '\x7f' || ch === '\b') {
      line = line.slice(0, -1);
    } else if (ch >= ' ' && ch !== '\x7f') {
      line += ch;
    }
  }
  tab._inputLine = line;
  safeSendInput(connId, data, tab.cfg?.encoding);
}

function pickDisplayPaths(rest) {
  // 返回所有图片路径参数 (跳过 -xxx 选项); display a.png b.png → ['a.png','b.png']
  return (rest || '').trim().split(/\s+/).filter(Boolean).filter(t => !t.startsWith('-'));
}

async function renderRemoteImage(tab, connId, remotePath) {
  return new Promise((resolve) => {
    tab.term.write(`\r\n\x1b[2m[display] 读取 ${remotePath} …\x1b[0m\r\n`);
    const fail = (msg) => { tab.term.write(`\x1b[31m[display] ${msg}\x1b[0m\r\n`); resolve(); };
    const url = apiUrl('/api/sftp/download', { conn: connId, path: remotePath });
    fetch(url, { cache: 'no-store' })
      .then(async (resp) => {
        if (!resp.ok) return fail(`取图失败 (${resp.status})，确认路径与连接`);
        const blob = await resp.blob();
        if (!blob.size) return fail('空文件');
        const objUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          try {
            const cellW = 8.4, cellH = 17; // 13px Consolas 单元格近似
            let cols = Math.max(8, Math.round(img.width / cellW));
            let rows = Math.max(4, Math.round(img.height / cellH));
            const maxCols = Math.max(8, tab.term.cols - 1);
            if (cols > maxCols) { const s = maxCols / cols; cols = maxCols; rows = Math.max(1, Math.round(rows * s)); }
            tab.imageAddon.addImageResource?.(objUrl, { cols, rows })
              || tab.imageAddon.addImage?.(objUrl, { cols, rows })
              || tab.term.write(`\x1b]1337;File=inline=1;width=${img.width};height=${img.height}:${objUrl}\x07`);
            tab.term.write(`\r\n\x1b[2m[display] ${img.width}×${img.height} 已显示\x1b[0m`);
          } catch (e) {
            tab.term.write(`\x1b[31m[display] 渲染失败: ${e.message}\x1b[0m\r\n`);
          } finally {
            URL.revokeObjectURL(objUrl);
            resolve();
          }
        };
        img.onerror = () => { tab.term.write('\x1b[31m[display] 无法解码(非图片格式?)\x1b[0m\r\n'); URL.revokeObjectURL(objUrl); resolve(); };
        img.src = objUrl;
      })
      .catch((e) => fail(`错误: ${e.message}`));
  });
}

// display a.png b.png: 依次拉取并逐个渲染, 避免多图异步完成时交错
async function displaySequence(tab, connId, paths) {
  for (const p of paths) {
    await renderRemoteImage(tab, connId, p);
  }
}

// Ctrl+I: 弹出远程图片路径输入框, 回车即经 SFTP 拉取并渲染 (快捷 display, 免手打命令)
function showDisplayPrompt() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || tab.cfg.type !== 'ssh' || !tab.imageAddon) return;
  if (document.getElementById('sshterm-display-prompt')) return;
  const overlay = document.createElement('div');
  overlay.id = 'sshterm-display-prompt';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999;font-family:Consolas,monospace';
  const box = document.createElement('div');
  box.style.cssText = 'background:#1a1b26;border:1px solid #3b4261;border-radius:8px;padding:16px 18px;min-width:440px;box-shadow:0 8px 30px rgba(0,0,0,.5)';
  const title = document.createElement('div');
  title.textContent = '显示远程图片 (SFTP)';
  title.style.cssText = 'color:#c0caf5;font-size:13px;margin-bottom:8px';
  const input = document.createElement('input');
  input.placeholder = '远程图片路径, 空格分隔多张, 如 /home/u/a.png';
  input.style.cssText = 'width:100%;box-sizing:border-box;background:#16161e;color:#c0caf5;border:1px solid #3b4261;border-radius:4px;padding:7px 9px;font-size:13px;outline:none';
  const hint = document.createElement('div');
  hint.textContent = '回车显示 · Esc 取消';
  hint.style.cssText = 'color:#565f89;font-size:11px;margin-top:7px';
  box.appendChild(title); box.appendChild(input); box.appendChild(hint);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  input.focus();
  const close = () => overlay.remove();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const val = input.value.trim();
      close();
      if (val) displaySequence(tab, tab.connId != null ? tab.connId : tab.id, pickDisplayPaths(val));
    }
  });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'i' || e.key === 'I')) {
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab && tab.cfg.type === 'ssh' && tab.imageAddon) {
      e.preventDefault(); e.stopPropagation();
      showDisplayPrompt();
    }
  }
}, true);

const TYPE_ICON = { ssh: '🖥️', telnet: '🔌', vnc: '🖼️', serial: '🔗' };
const STATE_TEXT = { connecting: '连接中…', connected: '● 已连接', closed: '✕ 已断开' };
const SENSITIVE_CONFIG_KEYS = new Set(['password', 'privateKey', 'passphrase', 'loginPass']);

// Workspace recovery must never turn browser storage into a credential vault.
// Saved sessions are rehydrated by the server from memory or DPAPI when the
// user explicitly opted in to remembering credentials.
function configForBrowserStorage(cfg) {
  const safe = Object.fromEntries(Object.entries(cfg || {}).filter(([key]) => !SENSITIVE_CONFIG_KEYS.has(key)));
  if (safe.proxy) {
    const { password, ...proxy } = safe.proxy;
    safe.proxy = proxy;
  }
  if (safe.jumpAuth) {
    const { password, privateKey, passphrase, ...jumpAuth } = safe.jumpAuth;
    safe.jumpAuth = jumpAuth;
  }
  return safe;
}

// ---------- 全局状态 ----------
let clientToken = window.__SSHTERM_TOKEN || '';
const WINDOW_ID_KEY = 'sshterm.window.id';
function persistentWindowId() {
  try {
    let id = sessionStorage.getItem(WINDOW_ID_KEY) || '';
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(id)) {
      id = crypto.randomUUID().replace(/[^A-Za-z0-9_-]/g, '') + crypto.randomUUID().replace(/[^A-Za-z0-9_-]/g, '');
      sessionStorage.setItem(WINDOW_ID_KEY, id);
    }
    return id;
  } catch {
    return crypto.randomUUID().replace(/[^A-Za-z0-9_-]/g, '') + crypto.randomUUID().replace(/[^A-Za-z0-9_-]/g, '');
  }
}
let windowId = persistentWindowId();
let ws = null;
let wsReconnectTimer = null;
let wsReconnectAttempt = 0;
const apiUrl = (pathname, params = {}) => {
  const q = new URLSearchParams({ ...params, token: clientToken, window: windowId });
  return `${pathname}?${q.toString()}`;
};
let tabs = [];            // {id, cfg, term, host, state, hex}
let tabSeq = 1;
let activeTabId = null;
let sessions = [];        // 已保存会话列表
let editingId = null;     // 对话框正在编辑的会话 id
let serialPorts = [];
const pendingSavedConnections = new Map();
let saveRequestSeq = 0;
const pendingVncCredentials = new Map();
let vncCredentialRequestSeq = 0;
const pendingMfaChallenges = new Map();

async function refreshBootstrapToken() {
  try {
    const resp = await fetch('/bootstrap.js', { cache: 'no-store' });
    if (!resp.ok) return false;
    const text = await resp.text();
    const match = text.match(/window\.__SSHTERM_TOKEN=(.+?);/);
    if (!match) return false;
    clientToken = JSON.parse(match[1]);
    return true;
  } catch {
    return false;
  }
}

function wsUrl() {
  return `ws://${location.host}/?token=${encodeURIComponent(clientToken)}&window=${encodeURIComponent(windowId)}`;
}

function scheduleWsReconnect() {
  if (wsReconnectTimer) return;
  wsReconnectAttempt += 1;
  const delays = [500, 1000, 2000, 5000, 10000, 20000];
  const delay = delays[Math.min(wsReconnectAttempt - 1, delays.length - 1)];
  $('conn-status-text').textContent = `服务器已断开，${Math.round(delay / 1000)} 秒后重连 (${wsReconnectAttempt})…`;
  wsReconnectTimer = setTimeout(async () => {
    wsReconnectTimer = null;
    await refreshBootstrapToken();
    connectWebSocket();
  }, delay);
}

function reattachLiveTabs() {
  for (const tab of tabs) {
    if (tab.intentionalClose || tab.manualDisconnect) continue;
    if (tab.state === 'connected' || tab.state === 'connecting' || tab.everConnected) {
      if (tab.cfg.type === 'vnc') connectVncTab(tab);
      else send({ type: 'connect', session: tab.cfg, id: tab.id });
    }
  }
}

function onWsOpen() {
  wsReconnectAttempt = 0;
  $('conn-status').className = 'status-dot ok';
  $('conn-status-text').textContent = '服务器已连接';
  send({ type: 'list' });
  send({ type: 'serialports' });
  if (tabs.length) reattachLiveTabs();
  else restoreTabs();
}

function onWsClose(ev) {
  $('conn-status').className = 'status-dot err';
  if (ev && ev.code === 4001) {
    $('conn-status-text').textContent = '页面已刷新，正在恢复…';
    return;
  }
  $('conn-status-text').textContent = '服务器已断开，重连中…';
  scheduleWsReconnect();
}

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  ws = new WebSocket(wsUrl());
  ws.binaryType = 'arraybuffer';
  ws.onopen = onWsOpen;
  ws.onclose = onWsClose;
  ws.onerror = () => {};
  ws.onmessage = onWsMessage;
}

// ---------- WS 连接 ----------
function onWsMessage(ev) {
  if (typeof ev.data === 'string') return handleMsg(JSON.parse(ev.data));
  const buf = new Uint8Array(ev.data);
  const id = buf[0] | (buf[1] << 8);
  let tab = tabs.find(t => t.id === id);
  let pane = null;
  if (!tab) {
    for (const t of tabs) {
      const p = (t.extraPanes || []).find(x => x.connId === id);
      if (p) { tab = t; pane = p; break; }
    }
  }
  if (!tab) return;
  const payload = buf.subarray(2);
  processTerminalOutput(tab, pane, payload);
}
connectWebSocket();

function processTerminalOutput(tab, pane, payload) {
  const term = pane ? pane.term : tab.term;
  const displayTarget = pane || tab;
  if (!displayTarget._streamDecoder) {
    displayTarget._streamDecoder = new (Enc().StreamingDecoder)(tab.cfg.encoding || 'utf-8');
  }
  const stamp = !pane && tab.cfg.type === 'serial' && tab.cfg.timestamp ? `[${new Date().toLocaleTimeString()}] ` : '';
  if ((pane ? pane.hex : tab.hex)) term.write(stamp + hexOf(payload) + ' ');
  else {
    const text = Enc().decodeBuffer(payload, tab.cfg.encoding || 'utf-8');
    if (stamp) term.write(stamp);
    term.write(text);
  }
  if (!pane && tab.cfg.type === 'serial' && tab.cfg.trigger) {
    try {
      const trigText = Enc().decodeBuffer(payload, tab.cfg.encoding || 'utf-8');
      if (trigText.includes(tab.cfg.trigger)) setStatus(`串口触发：${tab.cfg.trigger}`);
    } catch {}
  }
  if (tab.logging) {
    const dir = pane || tab;
    if (!dir.captureParts) dir.captureParts = [];
    if (!dir.captureSize) dir.captureSize = 0;
    const line = `${new Date().toISOString()} RX ${hexdumpLine(payload)}\n`;
    dir.captureParts.push(line);
    dir.captureSize += line.length;
    while (dir.captureSize > CAPTURE_MAX && dir.captureParts.length) {
      const dropped = dir.captureParts.shift();
      dir.captureSize -= dropped.length;
    }
  }
  try {
    const text = displayTarget._streamDecoder.decode(payload);
    if (!pane && tab.recording) {
      tab.recording.events.push({ at: Date.now() - tab.recording.startedAt, text });
      tab.recording.size += text.length;
      if (tab.recording.events.length > 100000 || tab.recording.size > 8 * 1024 * 1024) {
        tab.recording.stopped = '录制达到 8 MB / 100,000 条上限';
        stopSessionRecording(tab);
      }
    }
    const target = pane || tab;
    if (!target.recParts) target.recParts = [];
    target.recLen = (target.recLen || 0) + text.length;
    target.recParts.push(text);
    target._outputSeq = (target._outputSeq || 0) + 1;
    while (target.recLen > BUF_MAX && target.recParts.length) {
      target.recLen -= target.recParts.shift().length;
    }
    scheduleTabsSave();
  } catch (e) { /* 忽略 */ }
}

function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function log(msg) { send({ type: 'log', msg }); }
function sendInput(tabId, str, encoding) {
  let bytes;
  if (str instanceof Uint8Array || str instanceof ArrayBuffer) {
    bytes = new Uint8Array(str);
  } else {
    bytes = Enc().encodeText(String(str), encoding || 'utf-8');
  }
  const frame = new Uint8Array(2 + bytes.length);
  frame[0] = tabId & 0xff; frame[1] = (tabId >> 8) & 0xff;
  frame.set(bytes, 2);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(frame);
  const tab = tabs.find(t => t.id === tabId);
  if (tab && tab.logging) {
    if (!tab.captureParts) tab.captureParts = [];
    if (!tab.captureSize) tab.captureSize = 0;
    const line = `${new Date().toISOString()} TX ${hexdumpLine(bytes)}\n`;
    tab.captureParts.push(line);
    tab.captureSize += line.length;
  }
}

function showMfaDialog(tabId, info) {
  return new Promise((resolve) => {
    const mask = $('dlg-mfa-mask');
    const promptsEl = $('mfa-prompts');
    const instructionsEl = $('mfa-instructions');
    const inputs = [];
    instructionsEl.textContent = [info.name, info.instructions].filter(Boolean).join('\n') || '请输入验证码或多因素认证信息';
    promptsEl.innerHTML = (info.prompts || []).map((p, i) => {
      const label = esc(p.prompt || `提示 ${i + 1}`);
      const type = p.echo ? 'text' : 'password';
      return `<label class="mfa-field"><span>${label}</span><input data-idx="${i}" type="${type}" autocomplete="one-time-code"></label>`;
    }).join('');
    mask.classList.remove('hidden');
    promptsEl.querySelectorAll('input').forEach((input) => { inputs.push(input); });
    (inputs[0] || $('btn-mfa-submit')).focus();
    const cleanup = (result) => {
      mask.classList.add('hidden');
      $('btn-mfa-submit').onclick = null;
      $('btn-mfa-cancel').onclick = null;
      pendingMfaChallenges.delete(tabId);
      resolve(result);
    };
    $('btn-mfa-submit').onclick = () => cleanup({ cancel: false, responses: inputs.map(i => i.value) });
    $('btn-mfa-cancel').onclick = () => cleanup({ cancel: true, responses: [] });
    pendingMfaChallenges.set(tabId, cleanup);
  });
}

// ---------- 远端主机状态条 → web/js/host-cpu.js ----------
function handleMsg(m) {
  switch (m.type) {
    case 'window-id': { windowId = m.windowId || ''; break; }
    case 'ssh-hosts': {
      const list = m.list || [];
      const tbody = $('sshcfg-list').querySelector('tbody');
      tbody.innerHTML = list.map(h => `
        <tr style="cursor:pointer" data-name="${esc(h.name)}">
          <td>${esc(h.name)}</td><td>${esc(h.host)}</td><td>${esc(h.port)}</td><td>${esc(h.user)}</td><td>${h.key ? '✅' : ''}</td>
        </tr>`).join('');
      tbody.querySelectorAll('tr').forEach(tr => {
        tr.onclick = () => {
          const n = tr.dataset.name;
          const cfg = list.find(h => h.name === n);
          $('f-type').value = 'ssh';
          $('f-host').value = cfg.host;
          $('f-port').value = cfg.port;
          $('f-user').value = cfg.user;
          $('f-key').value = cfg.key;
          $('f-jump').value = cfg.proxyJump || '';
          $('f-name').value = n;
          $('dlg-mask').classList.add('hidden');
          $('sshcfg-dialog-mask').classList.add('hidden');
          $('f-type').focus();
        };
      });
      $('sshcfg-dialog-mask').classList.remove('hidden');
      break;
    }
    case 'sessions': {
      sessions = m.list || [];
      renderSessionList();
      break;
    }
    case 'session-saved': {
      const cfg = pendingSavedConnections.get(m.requestId);
      if (!cfg) break;
      pendingSavedConnections.delete(m.requestId);
      newTab({ ...cfg, id: m.id });
      break;
    }
    case 'vnc-credential': {
      const pending = pendingVncCredentials.get(m.requestId);
      if (!pending) break;
      pendingVncCredentials.delete(m.requestId);
      clearTimeout(pending.timer);
      pending.resolve(typeof m.password === 'string' ? m.password : '');
      break;
    }
    case 'session-export': {
      saveBlob(new Blob([m.data], { type: 'application/json;charset=utf-8' }), m.filename || 'sshterm-backup.json');
      setStatus('加密会话备份已导出');
      break;
    }
    case 'session-import': {
      setStatus(`已从 ${m.source === 'openssh' ? 'OpenSSH config' : '加密备份'} 导入 ${m.count} 个会话`);
      $('dlg-transfer-mask').classList.add('hidden');
      break;
    }
    case 'status': {
      let tab = tabs.find(t => t.id === m.id);
      let pane = null;
      if (!tab) for (const t of tabs) {
        const p = (t.extraPanes || []).find(x => x.connId === m.id);
        if (p) { tab = t; pane = p; break; }
      }
      if (tab) {
        const target = pane || tab;
        if (m.resumed && m.historyReplay) {
          // The server owns the authoritative rolling transcript for a live
          // connection. Clear any browser snapshot before replay to avoid
          // duplicate lines, then rebuild recParts from the binary frames.
          try { target.term?.reset(); } catch {}
          target.recParts = [];
          target.recLen = 0;
        }
        if (pane) {
          pane.state = m.state;
        } else {
          setTabState(m.id, m.state, m.msg);
        }
        if (!pane && m.state === 'closed' && tab.everConnected) scheduleReconnect(tab, m.msg);
        if (!pane && m.state === 'connected') {
          cancelReconnect(tab);
          resetReconnectState(tab);
        }
        if (m.state === 'connected') {
          // The first fit can happen before the SSH PTY exists.  Always send
          // the current dimensions again after connection establishment.
          syncTerminalSize(pane || tab, m.id);
          tab.cfg._serverCfg = m.cfg;
          if (!pane) {
            tab.everConnected = true;
            // 刷新重挂接的是同一条远端 shell，不能重复执行登录命令。
            if (!m.resumed) setTimeout(() => runAutoCmds(tab.cfg, tab.id), 300);
            // 启动远端主机状态轮询 (内存/负载/连接时长), 仅 SSH
            if (tab.cfg.type === 'ssh') startHostInfo(tab);
          }
        }
      }
      break;
    }
    case 'hostinfo': {
      const tab = tabs.find(t => t.id === m.id);
      if (tab && tab.hostinfoBar) renderHostInfo(tab, m);
      break;
    }
    case 'hostcpu': {
      const tab = tabs.find(t => t.id === m.id);
      if (!tab || m.cpuPct == null) break;
      pushCpuSample(tab, m.cpuPct);
      startCpuAnim(tab);
      break;
    }
    case 'host-key': {
      const message = `首次连接 ${m.host}\n\n服务器主机密钥指纹：\n${m.fingerprint}\n\n请仅在通过独立可信渠道核对指纹后选择“确定”。`;
      const accept = confirm(message);
      send({ type: 'host-key-decision', id: m.id, accept });
      break;
    }
    case 'interactive-auth': {
      showMfaDialog(m.id, m).then((result) => {
        send({ type: 'interactive-auth-response', id: m.id, cancel: result.cancel, responses: result.responses });
      });
      break;
    }
    case 'error': {
      sftpBusy = false;
      if (m.occupied) { showOccDlg(m); break; }
      let tab = tabs.find(t => t.id === m.id);
      let pane = null;
      if (!tab) for (const t of tabs) {
        const p = (t.extraPanes || []).find(x => x.connId === m.id);
        if (p) { tab = t; pane = p; break; }
      }
      const term = pane ? pane.term : (tab ? tab.term : null);
      if (term) {
        if (!pane && shouldQuietReconnectError(tab, m)) break;
        term.writeln(`\r\n\x1b[31m[错误] ${m.msg}\x1b[0m`);
        // Operational errors (SFTP/tunnel/scan/…) carry action — surface status, do NOT close the tab.
        if (m.action) setStatus(`错误: ${m.msg}`);
        else if (!pane && tab && tab.state !== 'connecting') setTabState(tab.id, 'closed', '出错');
      } else setStatus(`错误: ${m.msg}`);
      break;
    }
    case 'serial-free': {
      // 强制释放结果: 成功则自动重连
      stopOccRetry();
      if (m.ok) {
        setStatus(m.msg);
        const tab = _occTab;
        _occTab = null;
        if (tab && tabs.includes(tab)) {
          setTimeout(() => send({ type: 'connect', session: tab.cfg, id: tab.id }), 800);
        }
      } else {
        setStatus(m.msg);
        if (_occTab) showOccDlg({ id: _occTab.id, msg: m.msg });
      }
      break;
    }
    case 'reuse': {
      const tab = tabs.find(t => t.id === m.id);
      if (tab) { tab.term.writeln('\r\n\x1b[33m[提示] 相同配置的连接已存在, 复用中\x1b[0m'); }
      break;
    }
    case 'serialports': {
      serialPorts = m.list || [];
      fillSerialPorts();
      break;
    }
    case 'logs': {
      renderLogs(m.list || [], m.file);
      break;
    }
    case 'scan': {
      renderScan(m);
      break;
    }
    case 'scan-net': {
      renderScanNet(m);
      break;
    }
    case 'zmodem': {
      // Zmodem 文件接收完成: 终端提示 + 状态栏
      const tab = tabs.find(t => t.id === m.id);
      const fileName = m.filename || 'file';
      if (tab) {
        tab.term.writeln(`\r\n\x1b[32m[Zmodem] 已接收: ${fileName} (${fmtSize(m.size)})\x1b[0m`);
        tab.term.writeln(`\x1b[33m下载地址: ${apiUrl('/api/zmodem/download', { file: fileName })}\x1b[0m`);
      }
      setStatus(`Zmodem 收到文件: ${fileName} (${fmtSize(m.size)})`);
      break;
    }
    case 'sftp': {
      if (m.id !== sftpConnId) break;
      if (m.action === 'cwd') {
        // 定位到 shell 当前目录 (cwd 失败则回退 home)
        sftpBusy = false;
        if (m.path) sftpPath = m.path;
        sftpLoad();
      } else if (m.action === 'list') {
        sftpBusy = false;
        sftpPath = m.path;              // 服务端 realpath 后的绝对路径
        $('sftp-path').value = m.path;
        renderSftpList(m.entries);
      } else if (m.action === 'scan') {
        if (sftpPendingScan && sftpPendingScan.id === m.id) {
          const waiter = sftpPendingScan;
          sftpPendingScan = null;
          if (m.error) waiter.reject(new Error(m.error));
          else waiter.resolve(m);
        }
      }
      break;
    }
    case 'tunnel': {
      if (m.id !== (tunnelTab && tunnelTab.id)) break;
      if (m.action === 'list' || m.action === 'add' || m.action === 'remove') renderTunnelList(m);
      break;
    }
    case 'tunnel-alert': { if (m.id === activeTabId) setStatus(`⚠ ${m.msg}`); break; }
  }
}

// ---------- 国际化 → web/js/i18n.js ----------

// ---------- 标签持久化 (刷新页面自动恢复打开的会话 + 终端内容) ----------
const LS_TABS_PREFIX = 'sshterm.tabs.';
function tabsStorageKey() { return LS_TABS_PREFIX + windowId; }
const LS_TABS = tabsStorageKey();
const LS_WORKSPACE = 'sshterm.workspace.default';
const BUF_MAX = 200 * 1024;   // 每标签保留最近 200KB 输出, 刷新后重放
let tabsSaveTimer = null;
function scheduleTabsSave() {
  clearTimeout(tabsSaveTimer);
  tabsSaveTimer = setTimeout(() => {
    tabsSaveTimer = null;
    saveTabs();
  }, 250);
}
// The 200 KB replay snapshot can end in the middle of an inline image.  Writing
// a truncated Sixel/OSC/APC payload leaves the xterm parser inside the sequence,
// which silently swallows every byte that follows and looks like a hung
// terminal.  Drop an unterminated trailing image sequence before replaying.
function stripTruncatedSequence(text) {
  if (typeof text !== 'string' || !text) return text;
  const start = Math.max(text.lastIndexOf('\x1bP'), text.lastIndexOf('\x1b]'), text.lastIndexOf('\x1b_'));
  if (start < 0) return text;
  const tail = text.slice(start);
  if (tail.includes('\x1b\\') || tail.includes('\x07') || tail.includes('\x9c')) return text;
  return text.slice(0, start);
}
function saveTabs() {
  try {
    localStorage.setItem(tabsStorageKey(), JSON.stringify(tabs.map(t => ({
      id: t.id,
      cfg: configForBrowserStorage(t.cfg),
      hex: !!t.hex,
      buf: (t.recParts || []).join(''),
      panes: (t.extraPanes || []).length,
      paneIds: (t.extraPanes || []).map(p => p.connId),
      paneBufs: (t.extraPanes || []).map(p => (p.recParts || []).join('')),
      split: { dir: splitDirection(t), ratio: splitRatio(t) },
      readonly: !!t.readonly,
    }))));
  } catch (e) { /* 存储失败忽略 */ }
}
function restoreTabs() {
  try {
    const raw = localStorage.getItem(tabsStorageKey());
    if (!raw) return;
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return;
    restoreTabItems(list);
    setStatus(`已恢复 ${list.length} 个会话`);
  } catch (e) { /* 解析失败忽略 */ }
}
// 刷新/关闭页面前保存最新终端内容
window.addEventListener('beforeunload', () => saveTabs());
window.addEventListener('pagehide', () => saveTabs());

function restoreTabItems(list) {
  for (const item of list) {
    if (!item || !item.cfg || !item.cfg.type) continue;
    if (item.readonly || item.cfg.type === 'replay') {
      openReplayTab(item.cfg, item.buf || '');
      continue;
    }
    const tab = newTab(item.cfg, { connect: item.cfg.connect !== false, hex: item.hex, replay: item.buf, id: item.id });
    const split = item.split || { dir: 'row', ratio: 0.5 };
    for (let n = 0; tab.cfg.type !== 'vnc' && n < Math.min(Number(item.panes) || 0, SPLIT_MAX - 1); n++) {
      addPane(tab, split.dir, split.ratio, {
        id: item.paneIds?.[n],
        replay: item.paneBufs?.[n] || '',
      });
    }
  }
  saveTabs();
}

function readWorkspaceSnapshot() {
  try {
    const value = JSON.parse(localStorage.getItem(LS_WORKSPACE) || 'null');
    // Backward compatible with the old array-only save format.
    if (Array.isArray(value)) return { version: 0, savedAt: null, tabs: value };
    if (value && Array.isArray(value.tabs)) return value;
  } catch {}
  return null;
}

function renderWorkspaceSummary() {
  const summary = $('workspace-snapshot-summary');
  const restore = $('workspace-restore');
  const snapshot = readWorkspaceSnapshot();
  restore.disabled = !snapshot;
  if (!snapshot) {
    summary.textContent = '尚未保存工作区';
    return;
  }
  const panes = snapshot.tabs.reduce((sum, item) => sum + (Number(item.panes) || 0), 0);
  const when = snapshot.savedAt ? new Date(snapshot.savedAt).toLocaleString() : '旧版本工作区';
  summary.textContent = `已保存：${snapshot.tabs.length} 个标签，${panes} 个附加分屏 · ${when}`;
}

function openWorkspacePanel() {
  renderWorkspaceSummary();
  $('dlg-workspace-mask').classList.remove('hidden');
}

function saveWorkspace() {
  saveTabs();
  try {
    const items = JSON.parse(localStorage.getItem(tabsStorageKey()) || '[]');
    localStorage.setItem(LS_WORKSPACE, JSON.stringify({ version: 1, savedAt: Date.now(), tabs: items }));
    renderWorkspaceSummary();
    setStatus(`工作区已保存：${tabs.length} 个标签`);
  }
  catch { setStatus('工作区保存失败'); }
}

function restoreWorkspace() {
  const snapshot = readWorkspaceSnapshot();
  if (!snapshot) return setStatus('没有已保存的工作区');
  if (tabs.length && !confirm(`恢复工作区将关闭当前 ${tabs.length} 个会话并重新连接，是否继续？`)) return;
  for (const tab of [...tabs]) doCloseTab(tab.id);
  restoreTabItems(snapshot.tabs);
  saveTabs();
  $('dlg-workspace-mask').classList.add('hidden');
  setStatus(`工作区已恢复：${snapshot.tabs.length} 个标签`);
}

// ---------- 标签管理 ----------
function newTab(cfg, opts = {}) {
  const restoredId = Number(opts.id);
  const id = Number.isInteger(restoredId) && restoredId > 0 && restoredId <= 0xffff
    ? restoredId : tabSeq++;
  tabSeq = Math.max(tabSeq, id + 1);
  const container = document.createElement('div');
  container.className = 'split-container hidden';
  const host = document.createElement('div');
  host.className = 'term-host main-pane';
  container.appendChild(host);
  $('terms').appendChild(container);

  if (cfg.type === 'vnc') {
    container.classList.add('vnc-session-container');
    host.className = 'vnc-session';
    const tab = {
      id, cfg, term: null, host: container, vncHost: host, state: 'idle',
      hex: false, fitAddon: null, searchAddon: null, recParts: [], recLen: 0, extraPanes: [],
      vncPassword: cfg.password || '',
    };
    tabs.push(tab);
    initVncSession(tab);
    renderTabbar();
    activateTab(id);
    saveTabs();
    if (opts.connect !== false) connectVncTab(tab);
    return tab;
  }

  const term = new Terminal(getTerminalOptions());
  const fitAddon = new (FitAddonCtor)();
  term.loadAddon(fitAddon);
  const imageAddon = attachImageAddon(term, cfg.type);
  let searchAddon = null;
  if (SearchAddonCtor) {
    searchAddon = new SearchAddonCtor();
    term.loadAddon(searchAddon);
    searchAddon.onDidChangeResults((r) => {
      if ($('search-count') && !$('search-bar').classList.contains('hidden')) {
        $('search-count').textContent = r.resultCount ? `${r.resultIndex + 1}/${r.resultCount}` : '0';
      }
    });
  }
  term.open(host);
  setTimeout(() => fitAddon.fit(), 0);

  // 主机信息条 (仅 SSH): 终端下方显示远端内存/负载/主机名/连接时长
  let hostinfoBar = null;
  if (cfg.type === 'ssh') {
    host.insertAdjacentHTML('afterend', `<div class="hostinfo-bar" id="hostinfo-${id}"><span class="hi-item hi-muted">连接中…</span></div>`);
    hostinfoBar = document.getElementById(`hostinfo-${id}`);
  }

  const tab = { id, cfg, term, host: container, state: 'idle', hex: !!(opts.hex ?? cfg.hexMode), fitAddon, searchAddon, imageAddon, recParts: [], recLen: 0, extraPanes: [], hostinfoBar, hostinfoTimer: null, connectedAt: 0 };
  tabs.push(tab);
  renderTabbar();
  activateTab(id);
  bindClipboard(tab);
  installSplitDragger(tab);

  // 刷新恢复: 先重放之前的终端内容, 再建立连接
  if (opts.replay) {
    const replay = stripTruncatedSequence(opts.replay);
    tab.recParts = [replay];
    tab.recLen = replay.length;
    try {
      term.write(replay);
      term.write('\r\n\x1b[33m[--- 连接已重新建立 ---]\x1b[0m\r\n');
    } catch (e) {}
  }
  saveTabs();

  term.onData((d) => handleUserInput(tab, d));
  term.onResize(({ cols, rows }) => send({ type: 'resize', id, cols, rows }));

  // 窗口尺寸变化 → 重新适配（2×2 网格分隔条按比例跟随）
  const ro = new ResizeObserver(() => {
    if (activeTabId === id) {
      fitTerm(tab);
      if (countPanes(tab) >= 3) positionGridDividers(tab);
    }
  });
  ro.observe(container);
  tab._resizeObserver = ro;

  if (opts.connect !== false && cfg.type !== 'replay' && !cfg.readonly) {
    setTabState(id, 'connecting', '连接中…');
    send({ type: 'connect', session: cfg, id });
  }
  return tab;
}

function fitTerm(tab) {
  if (!tab?.fitAddon) return;
  try { tab.fitAddon.fit(); } catch (e) { /* 忽略 */ }
}

function syncTerminalSize(target, id) {
  fitTerm(target);
  const cols = Number(target?.term?.cols);
  const rows = Number(target?.term?.rows);
  if (Number.isInteger(cols) && cols > 1 && Number.isInteger(rows) && rows > 0) {
    send({ type: 'resize', id, cols, rows });
  }
}

// ---------- 复制粘贴 → web/js/clipboard.js ----------

// ---------- 关闭会话 (活跃连接需确认) ----------
let pendingCloseId = null;

function requestCloseTab(id) {
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  // 空闲/已断开的直接关, 活跃连接必须确认
  if (tab.state !== 'connected' && tab.state !== 'connecting') {
    doCloseTab(id);
    return;
  }
  pendingCloseId = id;
  const typeName = TYPE_ICON[tab.cfg.type] || '';
  const target = tab.cfg.host || tab.cfg.port || '';
  $('close-info').innerHTML =
    `${typeName} 将断开连接 <b>${esc(tab.cfg.name || '未命名')}</b>${target ? ` (${esc(target)})` : ''}，<br>该操作会立即关闭会话。`;
  $('dlg-close-mask').classList.remove('hidden');
}

function doCloseTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  const tab = tabs[idx];
  tab.intentionalClose = true;
  cancelReconnect(tab);
  if (tab.cfg.type === 'vnc') disconnectVncTab(tab, 'VNC 已断开', true);
  for (const p of tab.extraPanes) {
    send({ type: 'disconnect', id: p.connId });
    try { p.term.dispose(); } catch (e) {}
    p.host.remove();
  }
  if (tab.cfg.type !== 'vnc') send({ type: 'disconnect', id });
  tabs.splice(idx, 1);
  if (tab._splitCleanup) tab._splitCleanup();
  if (tab.hostinfoTimer) { clearInterval(tab.hostinfoTimer); tab.hostinfoTimer = null; }
  if (tab.cpuTimer) { clearInterval(tab.cpuTimer); tab.cpuTimer = null; }
  stopCpuAnim(tab);
  if (tab._resizeObserver) { try { tab._resizeObserver.disconnect(); } catch {} tab._resizeObserver = null; }
  try { tab.term?.dispose(); } catch (e) {}
  tab.host.remove();
  if (activeTabId === id) activeTabId = null;
  const next = tabs[idx] || tabs[idx - 1];
  if (next) activateTab(next.id);
  renderTabbar();
  updateWelcome();
  updateSftpBtn();
  saveTabs();
  log(`关闭会话「${tab.cfg.name || id}」`);
}

function activateTab(id) {
  activeTabId = id;
  for (const t of tabs) {
    t.host.classList.toggle('hidden', t.id !== id);
    if (t.id === id) setTimeout(() => {
      if (t.cfg.type === 'vnc') { try { t.rfb?.focus(); } catch {} }
      else { fitTerm(t); t.term?.focus(); }
    }, 0);
  }
  renderTabbar();
  updateWelcome();
  updateSftpBtn();
  closeSearch();
  if (sftpOpen) {
    const tab = tabs.find(t => t.id === id);
    if (isSftpEligibleTab(tab)) {
      sftpConnId = tab.id;
      sftpPath = '.';
      sftpBusy = true;
      $('sftp-path').value = '';
      $('sftp-list').innerHTML = '';
      $('sftp-status').textContent = '定位当前目录…';
      send({ type: 'sftp', id: tab.id, action: 'cwd', fresh: true });
    }
  }
}

function setTabState(id, state, msg) {
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  tab.state = state;
  tab.stateMsg = msg;
  renderTabbar();
  updateSftpBtn();
  if (state === 'closed' && msg) setStatus(msg);
}

// 统一断线重连策略: 仅对非用户主动关闭的主标签生效。
// 退避 1/2/5/10/20 秒, 最多 5 次; 用尽后 Ctrl+R 主动重连。reconnect=false 可关闭自动重连。
const AUTO_RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 20000];
const AUTO_RECONNECT_MAX = AUTO_RECONNECT_DELAYS.length;
const MANUAL_RECONNECT_HINT = '自动重连已停止，按 Ctrl+R 重连';

function owningSessionTab(tabOrPane) {
  if (!tabOrPane) return null;
  if (tabs.includes(tabOrPane)) return tabOrPane;
  return tabs.find(t => (t.extraPanes || []).some(p => p === tabOrPane)) || null;
}

// ---------- 重连策略 → web/js/reconnect.js ----------

function moveOpenTab(dragId, targetId, after = false) {
  if (!dragId || dragId === targetId) return;
  const dragged = tabs.find(t => t.id === dragId);
  if (!dragged) return;
  const next = tabs.filter(t => t.id !== dragId);
  const targetIndex = next.findIndex(t => t.id === targetId);
  if (targetIndex < 0) return;
  next.splice(targetIndex + (after ? 1 : 0), 0, dragged);
  tabs = next;
  renderTabbar();
  // saveTabs already stores the tabs array in display order, so a refresh
  // restores the order the user chose as well.
  saveTabs();
}

function clearTabDropTargets() {
  document.querySelectorAll('.tab.dragging, .tab.drop-before, .tab.drop-after')
    .forEach(el => el.classList.remove('dragging', 'drop-before', 'drop-after'));
}

function renderTabbar() {
  const bar = $('tabbar');
  bar.innerHTML = '';
  for (const t of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === activeTabId ? ' active' : '');
    el.draggable = true;
    const dot = t.state === 'connected' ? '🟢' : t.state === 'connecting' ? '🟡' : '🔴';
    el.innerHTML = `
      <span class="t-state" title="${esc(t.stateMsg || '')}">${dot}</span>
      <span class="t-name">${esc(t.cfg.name || (TYPE_ICON[t.cfg.type] + ' ' + (t.cfg.host || t.cfg.port)))}</span>
      <span class="t-close">✕</span>`;
    el.querySelector('.t-close').onclick = (e) => { e.stopPropagation(); requestCloseTab(t.id); };
    el.onclick = () => activateTab(t.id);
    el.onauxclick = (e) => { if (e.button === 1) requestCloseTab(t.id); };
    el.addEventListener('dragstart', (e) => {
      if (e.target.closest('.t-close')) {
        e.preventDefault();
        return;
      }
      draggingTabId = t.id;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(t.id));
    });
    el.addEventListener('dragover', (e) => {
      if (!draggingTabId || draggingTabId === t.id) return;
      e.preventDefault();
      const after = e.clientX > el.getBoundingClientRect().left + el.offsetWidth / 2;
      el.classList.toggle('drop-before', !after);
      el.classList.toggle('drop-after', after);
      e.dataTransfer.dropEffect = 'move';
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
    el.addEventListener('drop', (e) => {
      if (!draggingTabId || draggingTabId === t.id) return;
      e.preventDefault();
      e.stopPropagation();
      const after = e.clientX > el.getBoundingClientRect().left + el.offsetWidth / 2;
      moveOpenTab(draggingTabId, t.id, after);
    });
    el.addEventListener('dragend', () => {
      draggingTabId = null;
      clearTabDropTargets();
    });
    bar.appendChild(el);
  }
  if (!tabs.length) $('tabbar').innerHTML = '<span class="muted" style="padding:8px 12px">无连接 — 双击左侧会话或新建</span>';
}

function updateWelcome() { $('welcome').classList.toggle('hidden', tabs.length > 0); }

// ---------- 会话列表 ----------
let batchMode = false;
const batchSel = new Set();
let draggingSessionId = null;

function persistSessionOrder() {
  send({
    type: 'reorder-sessions',
    order: sessions.map(s => s.id),
    groups: Object.fromEntries(sessions.map(s => [s.id, s.group || ''])),
  });
}

function moveSession(dragId, beforeId = null, destinationGroup = '') {
  if (!dragId || dragId === beforeId) return;
  const dragged = sessions.find(s => s.id === dragId);
  if (!dragged) return;
  const next = sessions.filter(s => s.id !== dragId);
  const targetIndex = beforeId ? next.findIndex(s => s.id === beforeId) : next.length;
  next.splice(targetIndex < 0 ? next.length : targetIndex, 0, {
    ...dragged,
    group: destinationGroup === '默认' ? undefined : (destinationGroup || undefined),
  });
  sessions = next;
  renderSessionList();
  persistSessionOrder();
}

function clearSessionDropTargets() {
  document.querySelectorAll('.s-row.drop-before, .group-head.drop-target, .group-body.drop-target')
    .forEach(el => el.classList.remove('drop-before', 'drop-target'));
}


function getSessionFilterText() {
  const el = $('session-filter');
  return ((el && el.value) || '').trim().toLowerCase();
}

function sessionMatchesFilter(s, q) {
  if (!q) return true;
  const group = (s.group || '默认').toLowerCase();
  const hay = [s.name, s.host, s.port, s.type, s.group, group, s.username, s.port && String(s.port)]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

function renderSessionList() {
  const ul = $('session-list');
  ul.innerHTML = '';
  if (!sessions.length) {
    ul.innerHTML = '<li class="muted" style="cursor:default">(还没有保存的会话)</li>';
    return;
  }
  const filterQ = getSessionFilterText();
  // 按分组归类; 未分组归入 "默认"
  const groups = new Map();
  for (const s of sessions) {
    if (!sessionMatchesFilter(s, filterQ)) continue;
    const g = s.group || '默认';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  if (filterQ && groups.size === 0) {
    ul.innerHTML = '<li class="muted" style="cursor:default">(无匹配会话)</li>';
    return;
  }
  // Map preserves the user-established order instead of alphabetically
  // pinning groups in place.
  for (const g of groups.keys()) {
    const items = groups.get(g);
    const li = document.createElement('li');
    li.className = 'group-head';
    li.innerHTML = `<span class="group-caret">▼</span> ${esc(g)} <span class="muted">(${items.length})</span>`;
    li.onclick = () => {
      const body = li.nextElementSibling;
      if (body) {
        const hidden = body.classList.toggle('hidden');
        li.querySelector('.group-caret').textContent = hidden ? '▶' : '▼';
      }
    };
    li.addEventListener('dragover', (e) => {
      if (!draggingSessionId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      li.classList.add('drop-target');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      moveSession(draggingSessionId, null, g);
      clearSessionDropTargets();
    });
    ul.appendChild(li);
    const body = document.createElement('div');
    body.className = 'group-body';
    body.addEventListener('dragover', (e) => {
      if (!draggingSessionId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      body.classList.add('drop-target');
    });
    body.addEventListener('dragleave', (e) => {
      if (!body.contains(e.relatedTarget)) body.classList.remove('drop-target');
    });
    body.addEventListener('drop', (e) => {
      if (e.target.closest('.s-row')) return;
      e.preventDefault();
      moveSession(draggingSessionId, null, g);
      clearSessionDropTargets();
    });
    for (const s of items) {
      const row = document.createElement('div');
      row.className = 's-row';
      row.draggable = !batchMode;
      const sub = s.type === 'serial' ? `${s.port} @ ${s.baudRate}` : `${s.host}:${s.port}`;
      const checked = batchSel.has(s.id) ? 'checked' : '';
      row.innerHTML = `
        ${batchMode ? `<input type="checkbox" class="b-cb" data-id="${esc(s.id)}" ${checked}>` : ''}
        ${batchMode ? '' : '<span class="session-drag-handle" title="拖动排序" aria-hidden="true">⠿</span>'}
        <span class="type-icon">${TYPE_ICON[s.type] || '❔'}</span>
        <span class="s-name">${esc(s.name)}</span>
        <span class="s-sub">${esc(sub)}</span>
        <span class="s-ops">
          <button title="编辑" data-act="edit">✏️</button>
          <button title="删除" data-act="del" class="danger">🗑</button>
        </span>`;
      row.ondblclick = () => { if (!batchMode) connectTo(s); };
      row.addEventListener('dragstart', (e) => {
        if (batchMode || !e.target.closest('.session-drag-handle')) {
          e.preventDefault();
          return;
        }
        draggingSessionId = s.id;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', s.id);
      });
      row.addEventListener('dragend', () => {
        draggingSessionId = null;
        row.classList.remove('dragging');
        clearSessionDropTargets();
      });
      row.addEventListener('dragover', (e) => {
        if (!draggingSessionId || draggingSessionId === s.id) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drop-before');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-before'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        moveSession(draggingSessionId, s.id, g);
        clearSessionDropTargets();
      });
      row.querySelector('.b-cb')?.addEventListener('change', (e) => {
        if (e.target.checked) batchSel.add(s.id); else batchSel.delete(s.id);
        updateBatchBar();
      });
      row.querySelector('[data-act=edit]').onclick = (e) => {
        e.stopPropagation();
        if (batchMode) return;
        openDlg(s);
      };
      row.querySelector('[data-act=del]').onclick = (e) => {
        e.stopPropagation();
        if (batchMode) return;
        if (confirm(`删除会话「${s.name}」?`)) send({ type: 'delete', id: s.id });
      };
      body.appendChild(row);
    }
    ul.appendChild(body);
  }
}

function updateBatchBar() {
  $('batch-n').textContent = batchSel.size;
  $('batch-del').disabled = batchSel.size === 0;
}
function setBatchMode(on) {
  batchMode = on;
  batchSel.clear();
  $('batch-bar').classList.toggle('hidden', !on);
  $('btn-batch').textContent = on ? '✕ 退出' : '☑ 批量';
  updateBatchBar();
  renderSessionList();
}

// 连接防抖: 连续点击/双击只触发一次, 防止疯狂开新连接卡死页面
let _lastConnAt = 0;
function connectTo(s) {
  const now = Date.now();
  if (now - _lastConnAt < 600) return;
  _lastConnAt = now;
  newTab({ ...s });
}

// ---------- 新建/编辑对话框 ----------
function openDlg(existing = null) {
  editingId = existing ? existing.id : null;
  $('dlg-title').textContent = t(existing ? 'dl_title_edit' : 'dl_title_new');
  $('f-name').value = existing?.name || '';
  $('f-group').value = existing?.group || '';
  $('f-type').value = existing?.type || 'ssh';
  $('f-host').value = existing?.host || '';
  $('f-port').value = existing?.port || (existing?.type === 'telnet' ? 23 : 22);
  $('f-user').value = existing?.username || '';
  $('f-auth').value = existing?.auth || 'password';
  $('f-password').value = '';
  $('f-key').value = existing?.privateKey || '';
  $('f-passphrase').value = '';
  // Saved terminal sessions are expected to reconnect after launcher/server
  // restarts. New sessions therefore opt in to Windows-encrypted credential
  // storage by default; existing sessions retain the user's explicit choice.
  $('f-remember').checked = existing ? !!existing.rememberPassword : true;
  $('f-session-log').checked = existing ? !!existing.sessionLog : false;
  $('f-proxy-type').value = existing?.proxy?.type || '';
  $('f-proxy-host').value = existing?.proxy?.host || '';
  $('f-proxy-port').value = existing?.proxy?.port || '';
  $('f-proxy-user').value = existing?.proxy?.username || '';
  $('f-proxy-password').value = '';
  $('f-jump').value = existing?.proxyJump || '';
  $('f-jump-user').value = existing?.jumpAuth?.username || '';
  $('f-jump-auth').value = existing?.jumpAuth?.auth || 'password';
  $('f-jump-password').value = '';
  $('f-jump-key').value = '';
  $('f-jump-passphrase').value = '';
  $('t-host').value = existing?.host || '';
  $('t-port').value = existing?.port || 23;
  $('t-autologin').checked = !!existing?.autoLogin;
  $('t-user').value = existing?.loginUser || '';
  $('t-pass').value = '';
  $('v-host').value = existing?.type === 'vnc' ? (existing.host || '') : '';
  $('v-port').value = existing?.type === 'vnc' ? (existing.port || 5901) : 5901;
  $('v-password').value = '';
  $('v-view-only').checked = !!existing?.viewOnly;
  $('v-reconnect').checked = existing?.reconnect !== false;
  $('f-autocmds').value = (existing?.autoCmds || []).join('\n');
  $('s-port').value = existing?.port2 || existing?.port || '';
  $('s-baud').value = String(existing?.baudRate || 115200);
  $('s-data').value = String(existing?.dataBits || 8);
  $('s-stop').value = String(existing?.stopBits || 1);
  $('s-parity').value = existing?.parity || 'none';
  $('s-encoding').value = existing?.encoding || 'utf-8';
  $('s-rtscts').checked = !!existing?.rtscts;
  $('s-reconnect').checked = existing?.reconnect !== false;
  $('s-hex').checked = !!existing?.hexMode;
  $('s-timestamp').checked = !!existing?.timestamp;
  $('s-trigger').value = existing?.trigger || '';
  updateDlgFields();
  $('dlg-mask').classList.remove('hidden');
  $('f-name').focus();
}

function updateDlgFields() {
  const type = $('f-type').value;
  $('grp-ssh').classList.toggle('hidden', type !== 'ssh');
  $('grp-telnet').classList.toggle('hidden', type !== 'telnet');
  $('grp-vnc').classList.toggle('hidden', type !== 'vnc');
  $('grp-serial').classList.toggle('hidden', type !== 'serial');
  $('f-remember-wrap').classList.toggle('hidden', type === 'serial');
  $('grp-autocmds').classList.toggle('hidden', type === 'vnc' || type === 'serial');
  const auth = $('f-auth').value;
  $('f-pwd-wrap').classList.toggle('hidden', auth !== 'password' && auth !== 'keyboard-interactive');
  $('f-key-wrap').classList.toggle('hidden', auth !== 'key');
  $('f-pass-wrap').classList.toggle('hidden', auth !== 'key');
  const proxy = $('f-proxy-type').value;
  $('f-proxy-wrap').classList.toggle('hidden', !proxy);
  $('f-proxy-auth-wrap').classList.toggle('hidden', !proxy);
  const hasJump = !!$('f-jump').value.trim();
  $('f-jump-auth-wrap').classList.toggle('hidden', !hasJump);
  const jumpAuth = $('f-jump-auth').value;
  $('f-jump-pwd-wrap').classList.toggle('hidden', jumpAuth !== 'password');
  $('f-jump-key-wrap').classList.toggle('hidden', jumpAuth !== 'key');
  $('f-jump-pass-wrap').classList.toggle('hidden', jumpAuth !== 'key');
  const auto = $('t-autologin').checked;
  $('t-user-wrap').classList.toggle('hidden', !auto);
  $('t-pass-wrap2').classList.toggle('hidden', !auto);
}

function collectDlg() {
  const type = $('f-type').value;
  const base = {
    id: editingId || undefined,
    name: $('f-name').value.trim(),
    group: $('f-group').value.trim() || undefined,
    type,
    rememberPassword: type !== 'serial' && $('f-remember').checked,
    sessionLog: type !== 'serial' && $('f-session-log').checked,
  };
  if (type === 'ssh') {
    const ptype = $('f-proxy-type').value;
    Object.assign(base, {
      host: $('f-host').value.trim(), port: parseInt($('f-port').value, 10) || 22,
      username: $('f-user').value.trim(), auth: $('f-auth').value,
      password: $('f-password').value || undefined,
      privateKey: $('f-key').value.trim() || undefined,
      passphrase: $('f-passphrase').value || undefined,
      proxy: ptype ? {
        type: ptype,
        host: $('f-proxy-host').value.trim(),
        port: parseInt($('f-proxy-port').value, 10) || 1080,
        username: $('f-proxy-user').value.trim() || undefined,
        password: $('f-proxy-password').value || undefined,
      } : undefined,
      proxyJump: $('f-jump').value.trim() || undefined,
      jumpAuth: $('f-jump').value.trim() ? {
        username: $('f-jump-user').value.trim() || undefined,
        auth: $('f-jump-auth').value,
        password: $('f-jump-password').value || undefined,
        privateKey: $('f-jump-key').value.trim() || undefined,
        passphrase: $('f-jump-passphrase').value || undefined,
      } : undefined,
    });
  } else if (type === 'telnet') {
    Object.assign(base, {
      host: $('t-host').value.trim(), port: parseInt($('t-port').value, 10) || 23,
      autoLogin: $('t-autologin').checked,
      loginUser: $('t-user').value.trim() || undefined,
      loginPass: $('t-pass').value || undefined,
    });
  } else if (type === 'vnc') {
    Object.assign(base, {
      host: $('v-host').value.trim(),
      port: parseInt($('v-port').value, 10) || 5901,
      password: $('v-password').value || undefined,
      viewOnly: $('v-view-only').checked,
      reconnect: $('v-reconnect').checked,
    });
  } else {
    Object.assign(base, {
      port2: $('s-port').value, port: $('s-port').value,
      baudRate: parseInt($('s-baud').value, 10) || 115200,
      dataBits: parseInt($('s-data').value, 10) || 8,
      stopBits: parseInt($('s-stop').value, 10) || 1,
      parity: $('s-parity').value,
      encoding: $('s-encoding').value || 'utf-8',
      rtscts: $('s-rtscts').checked,
      reconnect: $('s-reconnect').checked,
      hexMode: $('s-hex').checked,
      timestamp: $('s-timestamp').checked,
      trigger: $('s-trigger').value.trim() || undefined,
    });
  }
  // 自动命令仅适用于终端协议，VNC 是图形桌面会话。
  if (type !== 'vnc' && type !== 'serial') {
    const autoCmds = $('f-autocmds').value.split('\n').map(s => s.trim()).filter(Boolean);
    if (autoCmds.length) base.autoCmds = autoCmds;
  }
  return base;
}

function fillSerialPorts() {
  const sel = $('s-port');
  const cur = sel.value;
  sel.innerHTML = '';
  if (!serialPorts.length) {
    sel.innerHTML = '<option value="">(未发现串口)</option>';
  } else {
    for (const p of serialPorts) {
      const o = document.createElement('option');
      o.value = p.path;
      o.textContent = p.path + (p.manufacturer ? ` (${p.manufacturer})` : '');
      sel.appendChild(o);
    }
    if (serialPorts.some(p => p.path === cur)) sel.value = cur;
  }
}

// ---------- SFTP 文件面板 → web/js/sftp-panel.js ----------
// ---------- 终端搜索 (Ctrl+F, SearchAddon 高亮) ----------
let _searchActive = false;
function openSearch() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || !tab.searchAddon) return setStatus(tab?.cfg.type === 'vnc' ? 'VNC 会话不支持终端搜索' : '没有激活的会话');
  _searchActive = true;
  $('search-bar').classList.remove('hidden');
  $('search-input').focus();
  $('search-input').select();
  doSearch();
}
function closeSearch() {
  _searchActive = false;
  $('search-bar').classList.add('hidden');
  $('search-input').value = '';
  $('search-count').textContent = '';
}
function doSearch(dir = 1) {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || !tab.searchAddon) return;
  const q = $('search-input').value;
  if (!q) { $('search-count').textContent = ''; return; }
  try {
    if (dir > 0) tab.searchAddon.findNext(q, { decorations: { matchBackground: '#2d3a5f' } });
    else tab.searchAddon.findPrevious(q, { decorations: { matchBackground: '#2d3a5f' } });
  } catch (e) { /* 忽略 */ }
}
// 事件
$('search-input').addEventListener('input', () => doSearch(1));
$('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); doSearch(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') closeSearch();
});
$('search-next').onclick = () => doSearch(1);
$('search-prev').onclick = () => doSearch(-1);
$('search-close').onclick = closeSearch;

// ---------- SFTP 面板宽度调节 → web/js/sftp-panel.js ----------
// ---------- 可调节侧栏与 SFTP 双栏 ----------
const SIDEBAR_WIDTH_STORAGE = 'sshterm.sidebarWidth';
const SIDEBAR_MIN_WIDTH = 180;

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function fitActiveTerminal() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (tab) setTimeout(() => fitTerm(tab), 0);
}

function initSidebarDragger() {
  const sidebar = $('sidebar');
  const divider = $('sidebar-divider');
  const main = $('main');
  if (!sidebar || !divider || !main) return;
  const savedWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE));
  if (Number.isFinite(savedWidth)) {
    const maxWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(520, main.clientWidth - 320));
    sidebar.style.width = `${clamp(savedWidth, SIDEBAR_MIN_WIDTH, maxWidth)}px`;
  }

  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    divider.classList.add('dragging');
    const onMouseMove = (ev) => {
      const bounds = main.getBoundingClientRect();
      const maxWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(520, bounds.width - 320));
      sidebar.style.width = `${clamp(ev.clientX - bounds.left, SIDEBAR_MIN_WIDTH, maxWidth)}px`;
      fitActiveTerminal();
    };
    const onMouseUp = () => {
      divider.classList.remove('dragging');
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE, String(Math.round(sidebar.getBoundingClientRect().width)));
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}



// 初始化拖拽 (页面加载后)
setTimeout(() => {
  initSftpDragger();
  initSidebarDragger();
  initSftpColumnsDragger();
}, 100);
let _timerHandle = null;
let _timerTargetId = null;
$('btn-tm-cancel').onclick = () => $('dlg-timer-mask').classList.add('hidden');
$('btn-tm-start').onclick = () => {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return;
  const content = $('tm-content').value;
  const interval = Math.max(100, parseInt($('tm-interval').value, 10) || 1000);
  if (!content) return setStatus('请输入发送内容');
  stopTimer();
  _timerTargetId = tab.id;
  _timerHandle = setInterval(() => {
    const t = tabs.find(x => x.id === _timerTargetId);
    if (!t || t.state !== 'connected') { stopTimer(); return; }
    if ($('tm-hex').checked) {
      const byteArr = content.split(/[\s,]+/).filter(Boolean).map(h => parseInt(h, 16));
      if (!byteArr.length || byteArr.some(b => Number.isNaN(b) || b < 0 || b > 255)) {
        stopTimer();
        return setStatus('HEX 字节无效 (00-FF)');
      }
      sendInput(t.id, new Uint8Array(byteArr), t.cfg.encoding);
    } else {
      sendInput(t.id, content, t.cfg.encoding);
    }
  }, interval);
  $('dlg-timer-mask').classList.add('hidden');
  setStatus(`定时发送已开始 → ${tab.cfg.name || tab.id} (${interval}ms)`);
  log(`定时发送开始: tab=${tab.id} ${interval}ms "${content}"`);
};
$('btn-tm-stop').onclick = () => { stopTimer(); $('dlg-timer-mask').classList.add('hidden'); setStatus('定时发送已停止'); };
function stopTimer() { if (_timerHandle) { clearInterval(_timerHandle); _timerHandle = null; _timerTargetId = null; } }

// ---------- 快捷命令 (Xshell 命令集: 按 IP 独立, 可连接时自动执行) ----------
// 存储: localStorage['sshterm.commands.<ip>'] = { auto: bool, items: [{name, cmd}] }
function sessionCmdKey(cfg) {
  // 命令集按 IP (host) 隔离: 同一 IP 的所有会话共享
  return (cfg && cfg.host) || 'default';
}
let cmdKey = 'default';
let cmdSet = { auto: false, items: [] };
function loadCommands() {
  try {
    const raw = localStorage.getItem('sshterm.commands.' + cmdKey);
    const d = JSON.parse(raw || '[]');
    if (Array.isArray(d)) cmdSet = { auto: false, items: d };   // 兼容旧格式
    else cmdSet = { auto: !!d.auto, items: Array.isArray(d.items) ? d.items : [] };
  } catch (e) { cmdSet = { auto: false, items: [] }; }
}
function saveCommands() {
  try { localStorage.setItem('sshterm.commands.' + cmdKey, JSON.stringify(cmdSet)); } catch (e) {}
}
function renderCommands() {
  const el = $('cmd-list');
  el.innerHTML = '';
  const tab = tabs.find(t => t.id === activeTabId);
  const curIp = cmdKey === 'default' ? '未连接' : cmdKey;
  $('cmd-cur').textContent = `命令集 (IP: ${curIp}) — ${cmdSet.items.length} 条命令`;
  $('cmd-auto').checked = cmdSet.auto;
  if (!cmdSet.items.length) {
    el.innerHTML = '<div class="muted" style="padding:10px">(该 IP 还没有命令, 上面添加)</div>';
    return;
  }
  for (let i = 0; i < cmdSet.items.length; i++) {
    const c = cmdSet.items[i];
    const row = document.createElement('div');
    row.className = 'cmd-item';
    row.innerHTML = `
      <span class="cmd-ico">⚡</span>
      <span class="cmd-name" title="${esc(c.name)}">${esc(c.name)}</span>
      <span class="cmd-cmd" title="${esc(c.cmd)}">${esc(c.cmd)}</span>
      <button class="cmd-del mini" title="删除">🗑</button>`;
    row.onclick = () => runCommand(c.cmd);
    row.querySelector('.cmd-del').onclick = (e) => {
      e.stopPropagation();
      cmdSet.items.splice(i, 1);
      saveCommands();
      renderCommands();
    };
    el.appendChild(row);
  }
}
// 执行命令: 发送到激活会话
function runCommand(cmd) {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return setStatus('没有激活的会话');
  if (tab.cfg.type === 'vnc') return setStatus('VNC 会话不支持终端命令');
  if (tab.state !== 'connected') return setStatus('会话未连接');
  sendInput(tab.id, expandCommand(cmd, tab.cfg) + '\n');
  setStatus(`已发送: ${expandCommand(cmd, tab.cfg)}`);
}
function expandCommand(cmd, cfg) {
  const vars = { IP: cfg.host || '', HOST: cfg.host || '', PORT: cfg.port || '', NAME: cfg.name || '', SERIAL: cfg.port2 || cfg.port || '' };
  return String(cmd).replace(/\{(IP|HOST|PORT|NAME|SERIAL)\}/g, (_, k) => vars[k]);
}
let _scriptRuns = new Map();
function stopCommandScript(tab) {
  const run = tab && _scriptRuns.get(tab.id);
  if (run) run.cancelled = true;
  if (tab) _scriptRuns.delete(tab.id);
}
async function runCommandScript(tab, commands, options = {}) {
  stopCommandScript(tab);
  const run = { cancelled: false, startSeq: tab._outputSeq || 0 };
  _scriptRuns.set(tab.id, run);
  const delay = options.delay ?? 800;
  const timeout = options.timeout ?? 10000;
  for (const entry of commands) {
    if (run.cancelled || !tabs.includes(tab) || tab.state !== 'connected') break;
    const item = typeof entry === 'string' ? { cmd: entry } : entry;
    const cmd = expandCommand(item.cmd || '', tab.cfg);
    if (!cmd) continue;
    let attempts = 0;
    let done = false;
    while (!done && attempts++ <= (item.retries || 0)) {
      if (run.cancelled) break;
      const beforeSeq = tab._outputSeq || 0;
      sendInput(tab.id, cmd + (item.newline || '\n'), tab.cfg.encoding);
      if (!item.waitFor) { await new Promise(r => setTimeout(r, item.delay ?? delay)); done = true; continue; }
      const re = new RegExp(item.waitFor, item.flags || '');
      const start = Date.now();
      while (!run.cancelled && Date.now() - start < (item.timeout || timeout)) {
        const parts = (tab.recParts || []).slice(Math.max(0, (tab.recParts.length - 20)));
        const text = parts.join('');
        if ((tab._outputSeq || 0) > beforeSeq && re.test(text)) { done = true; break; }
        await new Promise(r => setTimeout(r, 100));
      }
      if (!done && attempts <= (item.retries || 0)) setStatus(`等待响应超时, 重试 ${attempts}/${item.retries}`);
    }
    if (!done && item.stopOnTimeout !== false) {
      setStatus(`自动脚本停止: 未等到 ${item.waitFor || '响应'}`);
      break;
    }
  }
  if (_scriptRuns.get(tab.id) === run) _scriptRuns.delete(tab.id);
}
function runAutoCmds(cfg, tabId) {
  const tab = tabId ? tabs.find(t => t.id === tabId) : tabs.find(t => t.cfg === cfg);
  if (!tab) return;
  // 1. IP 命令集 (auto 开启)
  const ipCmds = [];
  try {
    const d = JSON.parse(localStorage.getItem('sshterm.commands.' + (cfg.host || '')) || '[]');
    const set = Array.isArray(d) ? { auto: false, items: d } : d;
    if (set.auto && Array.isArray(set.items)) ipCmds.push(...set.items.map(i => i.cmd));
  } catch (e) {}
  // 2. 会话配置 autoCmds
  const cfgCmds = (cfg.autoCmds || []);
  const all = [...ipCmds, ...cfgCmds];
  if (!all.length) return;
  setStatus(`自动执行 ${all.length} 条命令...`);
  runCommandScript(tab, all);
}

$('btn-cmds').onclick = () => {
  const tab = tabs.find(t => t.id === activeTabId);
  cmdKey = sessionCmdKey(tab ? tab.cfg : null);
  loadCommands();
  $('dlg-cmds-mask').classList.remove('hidden');
  renderCommands();
};
$('cmds-close').onclick = () => $('dlg-cmds-mask').classList.add('hidden');
$('cmd-auto').onchange = () => { cmdSet.auto = $('cmd-auto').checked; saveCommands(); };
$('btn-cmd-add').onclick = () => {
  const name = $('cmd-name').value.trim();
  const cmd = $('cmd-content').value.trim();
  if (!name || !cmd) return setStatus('命令名称和内容不能为空');
  cmdSet.items.push({ name, cmd });
  saveCommands();
  $('cmd-name').value = '';
  $('cmd-content').value = '';
  renderCommands();
  setStatus(`命令已保存: ${name}`);
};
$('btn-cmd-runall').onclick = () => {
  if (!cmdSet.items.length) return setStatus('该 IP 没有命令可执行');
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || tab.state !== 'connected') return setStatus('会话未连接');
  runCommandScript(tab, cmdSet.items, { delay: 600 });
  setStatus(`执行 ${cmdSet.items.length} 条命令...`);
};

// ---------- 串口占用处理 (等待重试/强制释放) ----------
let _occTab = null;        // 占用弹窗关联的标签
let _occRetryTimer = null;
function showOccDlg(m) {
  const tab = tabs.find(t => t.id === m.id);
  if (!tab) return;
  _occTab = tab;
  $('occ-msg').textContent = m.msg || `串口被占用`;
  $('dlg-occ-mask').classList.remove('hidden');
}
function startOccRetry() {
  if (_occRetryTimer) return;
  setStatus('等待端口释放, 每 1.5 秒自动重试…');
  $('dlg-occ-mask').classList.add('hidden');
  _occRetryTimer = setInterval(() => {
    if (!_occTab || !tabs.includes(_occTab)) { stopOccRetry(); return; }
    send({ type: 'connect', session: _occTab.cfg, id: _occTab.id });
  }, 1500);
}
function stopOccRetry() {
  if (_occRetryTimer) { clearInterval(_occRetryTimer); _occRetryTimer = null; }
}
$('btn-occ-wait').onclick = startOccRetry;
$('btn-occ-force').onclick = () => {
  if (!_occTab) return;
  $('dlg-occ-mask').classList.add('hidden');
  setStatus('强制释放中… 请在 UAC 弹窗确认');
  send({ type: 'serial-force-free', path: _occTab.cfg.port || _occTab.cfg.port2 });
};
$('btn-occ-cancel').onclick = () => { stopOccRetry(); $('dlg-occ-mask').classList.add('hidden'); _occTab = null; };

// ---------- 端口扫描 (设备发现, 只需输入 IP, 入口在下拉菜单 ☰) ----------
const SCAN_PORTS = [21, 22, 23, 80, 443, 2000, 3389, 5555, 5900, 6379, 8080, 3306, 5432, 27017, 11211];
const PORT_NAMES = { 22: 'SSH', 23: 'Telnet', 21: 'FTP', 80: 'HTTP', 443: 'HTTPS',
  8080: 'HTTP-Proxy', 3389: 'RDP', 5900: 'VNC', 6379: 'Redis', 3306: 'MySQL',
  5432: 'PostgreSQL', 27017: 'MongoDB', 5555: 'ADB', 11211: 'Memcache', 2000: 'telnetd' };
$('btn-scan-close').onclick = () => $('dlg-scan-mask').classList.add('hidden');
$('btn-scan-start').onclick = () => {
  const target = $('scan-host').value.trim();
  if (!target) return setStatus('请输入目标 IP 或网段');
  $('scan-result').innerHTML = '<div class="muted">扫描中…</div>';
  // 含 / 或 - 视为网段 → 网络扫描 (设备发现); 单 IP → 全端口扫描
  if (target.includes('/') || target.includes('-')) {
    setStatus(`网络扫描: ${target}`);
    send({ type: 'scan-net', target });
  } else {
    send({ type: 'scan', host: target, ports: SCAN_PORTS });
  }
};
function renderScanNet(m) {
  const el = $('scan-result');
  if (!m.hosts.length) {
    el.innerHTML = `<div class="muted">未发现存活设备 (目标: ${esc(m.target)})</div>`;
    return;
  }
  const rows = m.hosts.map(h => {
    const ports = h.open.map(p => `<span class="scan-open" data-ip="${h.ip}" data-port="${p}">● ${p}${PORT_NAMES[p] ? ' (' + PORT_NAMES[p] + ')' : ''}</span>`).join(' ');
    return `<div class="scan-host"><span class="scan-ip">${h.ip}</span> ${ports}</div>`;
  }).join('');
  el.innerHTML = `<div class="muted">发现 ${m.hosts.length} 台设备 (目标: ${esc(m.target)}):</div>${rows}`;
  // 点击开放端口 → 自动填连接对话框
  el.querySelectorAll('.scan-open').forEach(span => {
    span.onclick = () => {
      const ip = span.dataset.ip, port = parseInt(span.dataset.port, 10);
      const type = port === 22 ? 'ssh' : port === 23 ? 'telnet' : 'ssh';
      openDlg({ type, name: `${ip}:${port}`, host: ip, port: port === 22 ? 22 : port });
      setStatus(`已填充连接: ${ip}:${port}`);
    };
  });
}
function renderScan(m) {
  if (!m.open.length) {
    $('scan-result').innerHTML = `<div class="muted">${esc(m.host)}: 未发现开放端口</div>`;
    return;
  }
  $('scan-result').innerHTML = `<div class="muted">${esc(m.host)} 开放端口:</div>` +
    m.open.map(p => `<div class="scan-open">● ${p} ${PORT_NAMES[p] ? ' (' + PORT_NAMES[p] + ')' : ''}</div>`).join('');
}

// ---------- Split Pane Manager → web/js/split-panes.js ----------
// ---------- 操作日志面板 (日志文件持久化: 每次启动新文件) ----------
function openLogPanel() {
  $('dlg-log-mask').classList.remove('hidden');
  send({ type: 'logs' });
}
let lastLogs = [], lastLogFile = '';
function renderLogs(list, file) {
  lastLogs = list; lastLogFile = file || lastLogFile;
  if (file) $('log-file').textContent = `日志文件: ${file}`;
  const el = $('log-list');
  const saved = new Set(JSON.parse(localStorage.getItem('sshterm.log.bookmarks') || '[]'));
  const onlyBookmarks = $('log-bookmarks')?.dataset.only === '1';
  const onlyAudit = $('log-audit')?.dataset.only === '1';
  const visible = list.filter(l => (!onlyBookmarks || saved.has(`${l.t}|${l.msg}`)) && (!onlyAudit || l.level === 'audit'));
  el.innerHTML = list.length
    ? visible.map(l => { const key = `${l.t}|${l.msg}`; return `<div class="log-line ${l.level === 'error' ? 'log-err' : ''}">
        <span class="log-t">${esc(l.t)}</span>
        <span class="log-lv">[${esc(l.level)}]</span>
        <span class="log-msg">${esc(l.msg)}</span><button class="mini log-star" data-key="${esc(key)}">${saved.has(key) ? '★' : '☆'}</button></div>`; }).join('')
    : '<div class="muted">(暂无日志)</div>';
  el.querySelectorAll('.log-star').forEach(btn => btn.onclick = () => {
    const key = btn.dataset.key; const next = new Set(JSON.parse(localStorage.getItem('sshterm.log.bookmarks') || '[]'));
    if (next.has(key)) next.delete(key); else next.add(key);
    localStorage.setItem('sshterm.log.bookmarks', JSON.stringify([...next].slice(-200)));
    renderLogs(list, file);
  });
  el.scrollTop = el.scrollHeight;
}
function exportVisibleLogs() {
  const saved = new Set(JSON.parse(localStorage.getItem('sshterm.log.bookmarks') || '[]'));
  const onlyBookmarks = $('log-bookmarks')?.dataset.only === '1';
  const onlyAudit = $('log-audit')?.dataset.only === '1';
  const csv = (v) => {
    let value = String(v ?? '');
    // Prevent exported log text from becoming an Excel formula when opened.
    if (/^[=+\-@]/.test(value)) value = `'${value}`;
    return `"${value.replace(/"/g, '""')}"`;
  };
  const rows = lastLogs
    .filter(l => (!onlyBookmarks || saved.has(`${l.t}|${l.msg}`)) && (!onlyAudit || l.level === 'audit'))
    .map(l => [l.t, l.level, l.msg].map(csv).join(','));
  saveBlob(new Blob([[['time', 'level', 'message'].map(csv).join(','), ...rows].join('\r\n')],
    { type: 'text/csv;charset=utf-8' }), `sshterm-audit-${Date.now()}.csv`);
}

// ---------- SSH 隧道 UI → web/js/tunnel-ui.js ----------
// ---------- VNC 独立会话标签 → web/js/vnc-ui.js ----------
// ---------- 事件绑定 ----------
$('btn-new').onclick = () => openDlg();
$('btn-welcome-new').onclick = () => openDlg();
// ---------- 更多工具下拉 (日志/语言/定时/扫描) ----------
$('btn-more').onclick = (e) => {
  e.stopPropagation();
  $('menu-more').classList.toggle('hidden');
};
document.addEventListener('click', () => $('menu-more').classList.add('hidden'));
$('mi-log').onclick = () => { $('menu-more').classList.add('hidden'); openLogPanel(); };
$('mi-lang').onclick = () => { $('menu-more').classList.add('hidden'); toggleLang(); };
$('mi-timer').onclick = () => {
  $('menu-more').classList.add('hidden');
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return setStatus('没有激活的会话');
  if (tab.cfg.type === 'vnc') return setStatus('VNC 会话不支持定时发送终端数据');
  $('dlg-timer-mask').classList.remove('hidden');
};
$('mi-scan').onclick = () => { $('menu-more').classList.add('hidden'); $('dlg-scan-mask').classList.remove('hidden'); };
$('mi-transfer').onclick = () => { $('menu-more').classList.add('hidden'); $('dlg-transfer-mask').classList.remove('hidden'); };
$('btn-sshcfg').onclick = () => {
  send({ type: 'ssh-hosts' });
  $('sshcfg-list').querySelector('tbody').innerHTML = '';
};
$('sshcfg-close').onclick = () => { $('sshcfg-dialog-mask').classList.add('hidden'); };
$('mi-capture').onclick = () => {
  $('menu-more').classList.add('hidden');
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return setStatus('没有激活的会话');
  if (tab.cfg.type === 'vnc') return setStatus('VNC 会话不支持终端原始抓包');
  tab.logging = !tab.logging;
  if (tab.logging) {
    tab.captureParts = [];
    $('mi-capture').textContent = '⏹ 停止并保存抓包';
    setStatus('原始抓包已开始 (RX/TX HEX)');
  } else {
    const blob = new Blob((tab.captureParts || []).join(''), { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `sshterm-${tab.cfg.name || tab.id}-capture-${Date.now()}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
    $('mi-capture').textContent = '⏺ 开始原始抓包';
    setStatus('原始抓包已保存 (RX/TX HEX)');
  }
};
$('log-close').onclick = () => $('dlg-log-mask').classList.add('hidden');
$('log-bookmarks').onclick = () => {
  const b = $('log-bookmarks'); b.dataset.only = b.dataset.only === '1' ? '0' : '1';
  b.textContent = b.dataset.only === '1' ? '★ 显示全部' : '★ 仅看书签'; renderLogs(lastLogs, lastLogFile);
};
function recordingFileName(tab) {
  const safe = String(tab.cfg.name || tab.cfg.host || 'session').replace(/[<>:"/\\|?*]+/g, '_');
  return `sshterm-recording-${safe}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
}
function stopSessionRecording(tab) {
  if (!tab?.recording) return;
  const recording = tab.recording;
  tab.recording = null;
  $('mi-record').textContent = '⏺ 开始会话录制';
  const exportData = {
    format: 'sshterm-recording', version: 1,
    createdAt: new Date(recording.startedAt).toISOString(),
    // Deliberately omit username and every credential field from the file.
    session: { name: tab.cfg.name || '', type: tab.cfg.type || '', host: tab.cfg.host || '', port: tab.cfg.port || '' },
    capture: 'rx-only', events: recording.events,
  };
  saveBlob(new Blob([JSON.stringify(exportData)], { type: 'application/json;charset=utf-8' }), recordingFileName(tab));
  setStatus(recording.stopped || `会话录制已保存（${recording.events.length} 条输出；不含键盘输入）`);
}
$('mi-record').onclick = () => {
  $('menu-more').classList.add('hidden');
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return setStatus('没有激活的会话');
  if (tab.cfg.type === 'vnc') return setStatus('VNC 会话不支持终端录制');
  if (tab.recording) return stopSessionRecording(tab);
  tab.recording = { startedAt: Date.now(), events: [], size: 0 };
  $('mi-record').textContent = '⏹ 停止并导出录制';
  setStatus('会话录制已开始：仅记录终端输出，不记录键盘输入');
};
function validateRecording(value) {
  if (!value || value.format !== 'sshterm-recording' || value.version !== 1 || !Array.isArray(value.events) || value.events.length > 100000) {
    throw new Error('不是有效的 sshterm 录制文件');
  }
  let previous = 0; let size = 0;
  for (const event of value.events) {
    if (!event || !Number.isSafeInteger(event.at) || event.at < previous || event.at > 24 * 3600 * 1000 || typeof event.text !== 'string') throw new Error('录制时间轴无效');
    previous = event.at; size += event.text.length;
    if (size > 8 * 1024 * 1024) throw new Error('录制文件内容超过 8 MB 上限');
  }
  return value;
}
async function replayRecording(file) {
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) throw new Error('录制文件超过 10 MB 上限');
  const recording = validateRecording(JSON.parse(await file.text()));
  const speed = Math.max(0.25, Math.min(16, Number(window.prompt('回放速度（0.25 - 16 倍）', '1')) || 1));
  openReplayTab({ type: 'replay', name: `回放：${recording.session?.name || '未命名会话'}`, host: recording.session?.host || '' }, '', recording.events, speed);
}

function openReplayTab(cfg, replayText = '', events = null, speed = 1) {
  const tab = newTab({ ...cfg, type: 'replay', connect: false }, { connect: false });
  tab.readonly = true;
  tab.cfg = { type: 'replay', name: cfg.name || '只读回放', connect: false };
  setTabState(tab.id, 'closed', events ? `只读回放（${speed}x）` : '只读回放');
  if (replayText) {
    const replay = stripTruncatedSequence(replayText);
    tab.recParts = [replay];
    tab.recLen = replay.length;
    tab.term.write(replay);
  }
  tab.term.writeln('\r\n\x1b[33m[只读回放：不会建立远端连接]\x1b[0m\r\n');
  if (events) {
    (async () => {
      let previous = 0;
      for (const event of events) {
        await new Promise(resolve => setTimeout(resolve, Math.min(30000, Math.max(0, event.at - previous) / speed)));
        if (!tabs.includes(tab)) return;
        tab.term.write(event.text);
        previous = event.at;
      }
      setStatus('会话回放完成');
    })();
  }
  saveTabs();
  return tab;
}
$('mi-replay').onclick = () => { $('menu-more').classList.add('hidden'); $('recording-import-file').click(); };
$('recording-import-file').onchange = async (event) => {
  try { await replayRecording(event.target.files?.[0]); } catch (e) { setStatus(e.message || '录制文件导入失败'); }
  event.target.value = '';
};
$('log-audit').onclick = () => {
  const b = $('log-audit'); b.dataset.only = b.dataset.only === '1' ? '0' : '1';
  b.textContent = b.dataset.only === '1' ? '🔐 显示全部' : '🔐 仅看审计'; renderLogs(lastLogs, lastLogFile);
};
$('log-export').onclick = exportVisibleLogs;
$('transfer-close').onclick = () => $('dlg-transfer-mask').classList.add('hidden');
function readImportFile(id) {
  const file = $(id).files?.[0];
  if (!file) throw new Error('请选择文件');
  if (file.size > 4 * 1024 * 1024) throw new Error('导入文件超过 4 MB 上限');
  return file.text();
}
$('backup-export').onclick = () => {
  const passphrase = $('backup-passphrase').value;
  if (passphrase.length < 12) return setStatus('备份口令至少需要 12 个字符');
  if (passphrase !== $('backup-passphrase-confirm').value) return setStatus('两次输入的备份口令不一致');
  send({ type: 'export-sessions', passphrase });
  $('backup-passphrase').value = '';
  $('backup-passphrase-confirm').value = '';
};
$('backup-import').onclick = async () => {
  try {
    const passphrase = $('backup-import-passphrase').value;
    if (passphrase.length < 12) throw new Error('备份口令至少需要 12 个字符');
    send({ type: 'import-sessions-backup', data: await readImportFile('backup-import-file'), passphrase });
    $('backup-import-passphrase').value = '';
  } catch (e) { setStatus(e.message); }
};
$('openssh-import').onclick = async () => {
  try { send({ type: 'import-openssh-config', data: await readImportFile('openssh-import-file') }); }
  catch (e) { setStatus(e.message); }
};
$('btn-sftp').onclick = toggleSftpPanel;
$('sftp-pick-download-dir').onclick = () => { pickSftpDownloadDir(); };
$('sftp-download-current-dir').onclick = () => { downloadSftpCurrentDir(); };
$('sftp-toggle-select').onclick = () => { toggleSftpSelectMode(); };
$('sftp-select-all').onclick = () => { selectAllSftpEntries(); };
$('sftp-download-selected').onclick = () => { downloadSftpSelected(); };
renderSftpDownloadDirLabel();
updateSftpSelectUi();

// ---------- 终端外观设置 ----------
(function bindTerminalSettingsUi() {
  const btn = $('btn-settings');
  if (btn) btn.onclick = () => openSettingsDialog();
  const closeBtn = $('settings-close');
  if (closeBtn) closeBtn.onclick = () => closeSettingsDialog();
  const applyBtn = $('btn-settings-apply');
  if (applyBtn) applyBtn.onclick = () => applySettingsFromDialog();
  const resetBtn = $('btn-settings-reset');
  if (resetBtn) resetBtn.onclick = () => {
    fillSettingsForm(saveTerminalSettings({ ...DEFAULT_TERMINAL_SETTINGS }));
  };
})();

$('btn-tunnel').onclick = () => {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || tab.cfg.type !== 'ssh') return setStatus('隧道仅适用于 SSH 会话');
  openTunnelPanel(tab);
};
$('tunnel-close').onclick = () => { $('dlg-tunnel-mask').classList.add('hidden'); clearInterval(tunnelRefreshTimer); tunnelRefreshTimer = null; };
$('btn-tunnel-refresh').onclick = () => {
  const tab = tunnelTab;
  if (tab) send({ type: 'tunnel', id: tab.id, action: 'list' });
};
$('btn-tunnel-add').onclick = () => {
  const tab = tunnelTab; if (!tab) return;
  const type = $('tn-type').value;
  const localPort = Number($('tn-local').value);
  const remoteHost = $('tn-remote').value.trim();
  if (!localPort || (type !== 'dynamic' && !remoteHost)) return setStatus(type === 'dynamic' ? '请填写本地 SOCKS 端口' : '请填写端口和远端目标');
  const splitAt = remoteHost.lastIndexOf(':');
  const host = splitAt > 0 ? remoteHost.slice(0, splitAt) : remoteHost;
  const remotePort = splitAt > 0 ? Number(remoteHost.slice(splitAt + 1)) : 80;
  send({ type: 'tunnel', id: tab.id, action: 'add', tunnelType: type, localPort,
    remoteHost: type === 'dynamic' ? 'SOCKS5' : host, remotePort: type === 'dynamic' ? 0 : remotePort });
};
$('btn-workspace').onclick = openWorkspacePanel;
$('workspace-close').onclick = () => $('dlg-workspace-mask').classList.add('hidden');
$('workspace-save').onclick = saveWorkspace;
$('workspace-restore').onclick = restoreWorkspace;
$('btn-killall').onclick = () => {
  if (!tabs.length) return setStatus('没有打开的会话');
  if (!confirm(`关闭全部 ${tabs.length} 个会话? (将断开所有连接)`)) return;
  const n = tabs.length;
  for (const t of [...tabs]) doCloseTab(t.id);
  setStatus(`已关闭 ${n} 个会话`);
};
$('sftp-close').onclick = () => { closeSftpPanel(); };
$('sftp-up').onclick = () => {
  if (sftpPath === '/' || sftpPath === '.') return;
  const idx = sftpPath.lastIndexOf('/');
  sftpPath = idx <= 0 ? '/' : sftpPath.slice(0, idx);
  sftpLoad();
};
$('sftp-refresh').onclick = sftpLoad;
// ---------- SFTP 传输 / 拖拽上传 → web/js/sftp-xfer.js ----------
$('f-type').onchange = updateDlgFields;
$('f-auth').onchange = updateDlgFields;
$('f-proxy-type').onchange = updateDlgFields;
$('f-jump').oninput = updateDlgFields;
$('f-jump-auth').onchange = updateDlgFields;
$('t-autologin').onchange = updateDlgFields;
$('btn-dlg-cancel').onclick = () => $('dlg-mask').classList.add('hidden');

// 关闭确认
$('btn-close-ok').onclick = () => {
  if (pendingCloseId != null) doCloseTab(pendingCloseId);
  pendingCloseId = null;
  $('dlg-close-mask').classList.add('hidden');
};
$('btn-close-cancel').onclick = () => {
  pendingCloseId = null;
  $('dlg-close-mask').classList.add('hidden');
};
$('dlg-close-mask').addEventListener('click', (e) => {
  if (e.target === $('dlg-close-mask')) {   // 点遮罩 = 取消
    pendingCloseId = null;
    $('dlg-close-mask').classList.add('hidden');
  }
});

// 批量模式
$('btn-batch').onclick = () => setBatchMode(!batchMode);
$('batch-cancel').onclick = () => setBatchMode(false);
$('batch-all').onchange = (e) => {
  batchSel.clear();
  if (e.target.checked) for (const s of sessions) batchSel.add(s.id);
  updateBatchBar();
  renderSessionList();
};
$('batch-del').onclick = () => {
  if (!batchSel.size) return;
  const names = sessions.filter(s => batchSel.has(s.id)).map(s => `「${s.name}」`).join(' ');
  if (confirm(`删除 ${batchSel.size} 个会话? ${names}`)) {
    send({ type: 'deleteMany', ids: [...batchSel] });
    setBatchMode(false);
    log(`批量删除 ${batchSel.size} 个会话`);
  }
};

function doConnect(save) {
  const cfg = collectDlg();
  if (!cfg.name) { alert('请填写会话名称'); return; }
  if (cfg.type === 'vnc') {
    if (!cfg.host || cfg.host.length > 253 || !/^[A-Za-z0-9._:-]+$/.test(cfg.host)) {
      alert('请填写有效的 VNC 主机地址');
      return;
    }
    if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
      alert('请填写有效的 VNC 端口');
      return;
    }
  }
  $('dlg-mask').classList.add('hidden');
  if (save) {
    const requestId = `${Date.now()}-${++saveRequestSeq}`;
    pendingSavedConnections.set(requestId, cfg);
    send({ type: 'save', requestId, session: cfg });
  } else {
    newTab(cfg);
  }
}
$('btn-dlg-conn').onclick = () => doConnect(false);
$('btn-dlg-save').onclick = () => doConnect(true);


function setStatus(msg) {
  $('sb-left').textContent = msg;
  $('statusbar').style.color = msg.startsWith('错误') ? '#ef4444' : '';
}
$('srv-addr').textContent = `localhost${location.port ? ':' + location.port : ''}`;

// 初始欢迎
updateWelcome();
updateSftpBtn();
applyI18n();
if ($('session-filter')) {
  $('session-filter').addEventListener('input', () => renderSessionList());
}


// ---------- 全局快捷键 (可配置映射 → web/js/hotkeys.js) ----------
document.addEventListener('keydown', (e) => {
  const map = typeof loadHotkeys === 'function' ? loadHotkeys() : null;
  const action = map && typeof getHotkeyAction === 'function' ? getHotkeyAction(e, map) : null;
  const typing = typeof isTypingTarget === 'function' ? isTypingTarget(e.target) : false;

  if (action === 'newConnection') { e.preventDefault(); openDlg(); return; }
  if (action === 'openSettings' && !typing) {
    e.preventDefault();
    if (typeof openSettingsDialog === 'function') openSettingsDialog();
    else if ($('dlg-settings-mask')) $('dlg-settings-mask').classList.remove('hidden');
    if (typeof fillHotkeyEditor === 'function') fillHotkeyEditor();
    return;
  }
  if (action === 'terminalSearch' && !typing) {
    e.preventDefault();
    if (typeof openSearch === 'function') openSearch();
    return;
  }
  if (action === 'manualReconnect' && !typing) {
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab && handleReconnectHotkey(tab)) { e.preventDefault(); return; }
  }
  if (action === 'nextTab' && tabs.length) {
    e.preventDefault();
    const idx = tabs.findIndex(t => t.id === activeTabId);
    activateTab(tabs[(idx + 1) % tabs.length].id);
    return;
  }
  if (action === 'prevTab' && tabs.length) {
    e.preventDefault();
    const idx = tabs.findIndex(t => t.id === activeTabId);
    activateTab(tabs[(idx - 1 + tabs.length) % tabs.length].id);
    return;
  }
  if (action === 'fontIncrease') {
    e.preventDefault();
    const sz = Math.min(24, (parseInt(document.body.style.fontSize || '13', 10)) + 1);
    document.body.style.fontSize = sz + 'px';
    tabs.forEach(t => { try { if (t.term) { t.term.options.fontSize = sz; t.fitAddon.fit(); } } catch (err) {} });
    return;
  }
  if (action === 'fontDecrease') {
    e.preventDefault();
    const sz = Math.max(8, (parseInt(document.body.style.fontSize || '13', 10)) - 1);
    document.body.style.fontSize = sz + 'px';
    tabs.forEach(t => { try { if (t.term) { t.term.options.fontSize = sz; t.fitAddon.fit(); } } catch (err) {} });
    return;
  }

  // Alt+1..9 切标签 (固定, 不入可编辑表)
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (e.altKey && !mod && /^[1-9]$/.test(k) && tabs.length) {
    e.preventDefault();
    const tab = tabs[parseInt(k, 10) - 1];
    if (tab) activateTab(tab.id);
  }
});

