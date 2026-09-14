// JSON WebSocket message switch (sessions CRUD / connect / sftp / tunnel / scan).
'use strict';
const path = require('path');
const { randomUUID } = require('crypto');
const { createBackup, readBackup, parseOpenSSHConfig } = require('./session-backup');
const { connectionConfigForRequest, connectionTargetsMatch } = require('./connection-config');
const { sanitizeSession } = require('./session-schema');
const { isScanAllowed, expandTarget, parseIPv4 } = require('./net-scan');

function createWsMessageHandler(ctx) {
  async function handle(ws, m) {
    let sessions = ctx.getSessions();
    const saveSessions = (data) => { ctx.saveSessions(data); };
    const sessionsList = () => ctx.sessionsList();
    const nextSessionSortOrder = () => ctx.nextSessionSortOrder();
    const sessionSortOrder = ctx.sessionSortOrder;
    const importSessionEntries = (...args) => ctx.importSessionEntries(...args);
    const storedSessionForConfig = (...args) => ctx.storedSessionForConfig(...args);
    const mergeStoredCredentials = (...args) => ctx.mergeStoredCredentials(...args);
    const sshConfig = ctx.sshConfig;
    const doConnect = (...args) => ctx.doConnect(...args);
    const attachExistingConnection = (...args) => ctx.attachExistingConnection(...args);
    const sendConnectionData = (...args) => ctx.sendConnectionData(...args);
    const getConnection = (...args) => ctx.getConnection(...args);
    const connections = ctx.connections;
    const connectionKey = ctx.connectionKey;
    const send = (...args) => ctx.send(...args);
    const log = (...args) => ctx.log(...args);
    const logs = ctx.logs;
    const LOG_FILE = ctx.getLogFile();

  switch (m.type) {
    case 'test-connection-output': {
      if (!process.env.SSHTERM_TEST_SFTP_ROOT || !Number.isInteger(m.id)) return;
      const conn = getConnection(ws, m.id);
      if (conn) sendConnectionData(conn, m.id, Buffer.from(String(m.data || '')));
      break;
    }
    case 'test-sftp-claim': {
      if (!process.env.SSHTERM_TEST_SFTP_ROOT || !Number.isInteger(m.id)) return;
      const fixture = connections.get(9900);
      if (!fixture) return;
      connections.set(connectionKey(ws, m.id), {
        ...fixture, id: m.id, state: 'connected', config: { type: 'ssh', name: 'fixture' },
        ownerWs: ws, _replayBuffer: [], _replayBufferBytes: 0,
      });
      send(ws, { type: 'test-sftp-claimed', id: m.id });
      break;
    }
    case 'list': {
      send(ws, { type: 'sessions', list: sessionsList() });
      break;
    }
    // 前端每隔几秒请求一次远端主机状态 (内存/负载/主机名); 断开即停, 无需服务端定时器
    case 'hostinfo': {
      const conn = getConnection(ws, m.id);
      if (!conn || conn.state !== 'connected') break;
      if (typeof conn.getHostStats !== 'function') break; // 仅 SSH 支持
      conn.getHostStats().then(stats => {
        send(ws, { type: 'hostinfo', id: m.id, ...stats });
      }).catch(e => {
        // 采集失败不打断终端, 仅回空 (前端显示 —)
        send(ws, { type: 'hostinfo', id: m.id, error: String(e.message || e) });
      });
      break;
    }
    case 'hostcpu': {
      const conn = getConnection(ws, m.id);
      if (!conn || conn.state !== 'connected') break;
      if (typeof conn.getCpuPct !== 'function') break;
      conn.getCpuPct().then(stats => {
        send(ws, { type: 'hostcpu', id: m.id, ...stats });
      }).catch(() => {});
      break;
    }
    case 'vnc-credential': {
      const requestId = typeof m.requestId === 'string' ? m.requestId.slice(0, 120) : '';
      const stored = storedSessionForConfig({ ...(m.session || {}), type: 'vnc' });
      const password = stored?.type === 'vnc' && stored.rememberPassword && typeof stored.password === 'string' ? stored.password : '';
      send(ws, { type: 'vnc-credential', requestId, password });
      break;
    }
    case 'save': {
      const s = sanitizeSession(m.session);
      if (!s) return send(ws, { type: 'error', action: 'save', msg: '会话数据无效' });
      if (!s.name) return send(ws, { type: 'error', action: 'save', msg: '会话名不能为空' });
      if (s.id && sessions[s.id]) {
        // 编辑保存: 前端表单密码框留空 = 不修改, 保留存储中的敏感字段
        for (const k of ['password', 'privateKey', 'passphrase', 'loginPass']) {
          if (s[k] === undefined || s[k] === '') s[k] = sessions[s.id][k];
        }
        if (s.proxy && !s.proxy.password && sessions[s.id].proxy?.password) {
          s.proxy = { ...s.proxy, password: sessions[s.id].proxy.password };
        }
        if (s.jumpAuth && sessions[s.id].jumpAuth) {
          for (const k of ['password', 'privateKey', 'passphrase']) {
            if (!s.jumpAuth[k] && sessions[s.id].jumpAuth[k]) s.jumpAuth[k] = sessions[s.id].jumpAuth[k];
          }
        }
        // The dialog does not expose order, so an edit must retain the
        // position established by drag-and-drop.
        s.sortOrder = sessionSortOrder(sessions[s.id], nextSessionSortOrder());
        sessions[s.id] = s;
        log('info', `更新会话「${s.name}」`);
      } else {
        s.id = randomUUID();
        s.sortOrder = nextSessionSortOrder();
        sessions[s.id] = s;
        log('info', `新建会话「${s.name}」(${s.type})`);
      }
      saveSessions(sessions);
      send(ws, { type: 'sessions', list: sessionsList() });
      if (m.requestId) send(ws, { type: 'session-saved', requestId: m.requestId, id: s.id });
      break;
    }
    case 'reorder-sessions': {
      const order = Array.isArray(m.order) ? m.order : [];
      const ids = Object.keys(sessions);
      const expected = new Set(ids);
      if (order.length !== ids.length || new Set(order).size !== ids.length || order.some(id => !expected.has(id))) {
        return send(ws, { type: 'error', action: 'reorder-sessions', msg: '会话排序数据无效，请刷新后重试' });
      }
      const groups = m.groups && typeof m.groups === 'object' && !Array.isArray(m.groups) ? m.groups : null;
      const reordered = {};
      for (let index = 0; index < order.length; index++) {
        const id = order[index];
        const session = { ...sessions[id], sortOrder: index };
        if (groups && Object.prototype.hasOwnProperty.call(groups, id)) {
          const group = typeof groups[id] === 'string' ? groups[id].trim().slice(0, 120) : '';
          if (group) session.group = group;
          else delete session.group;
        }
        reordered[id] = session;
      }
      ctx.setSessions(reordered); sessions = ctx.getSessions();
      saveSessions(sessions);
      log('info', `调整会话排序（${order.length} 个）`);
      send(ws, { type: 'sessions', list: sessionsList() });
      break;
    }
    case 'delete': {
      const name = sessions[m.id]?.name || m.id;
      delete sessions[m.id];
      saveSessions(sessions);
      log('info', `删除会话「${name}」`);
      send(ws, { type: 'sessions', list: sessionsList() });
      break;
    }
    case 'deleteMany': {
      const ids = Array.isArray(m.ids) ? m.ids : [];
      if (ids.length) {
        for (const id of ids) delete sessions[id];
        saveSessions(sessions);
        log('info', `批量删除会话 ${ids.length} 个`);
      }
      send(ws, { type: 'sessions', list: sessionsList() });
      break;
    }
    case 'log': {
      if (typeof m.msg === 'string') log('info', `[ui] ${m.msg}`);
      break;
    }
    case 'logs': {
      send(ws, { type: 'logs', list: logs.slice(-300), file: LOG_FILE });
      break;
    }
    case 'export-sessions': {
      const data = createBackup(Object.values(sessions), m.passphrase);
      const stamp = new Date().toISOString().slice(0, 10);
      log('audit', `导出 ${Object.keys(sessions).length} 个会话（加密备份）`);
      send(ws, { type: 'session-export', filename: `sshterm-backup-${stamp}.json`, data });
      break;
    }
    case 'import-sessions-backup': {
      const count = importSessionEntries(readBackup(m.data, m.passphrase), 'backup');
      send(ws, { type: 'sessions', list: sessionsList() });
      send(ws, { type: 'session-import', source: 'backup', count });
      break;
    }
    case 'import-openssh-config': {
      const count = importSessionEntries(parseOpenSSHConfig(m.data), 'openssh');
      send(ws, { type: 'sessions', list: sessionsList() });
      send(ws, { type: 'session-import', source: 'openssh', count });
      break;
    }
    case 'serial-force-free': {
      // 强制释放被占串口: 提权重启设备 (弹 UAC, 用户确认后 Disable/Enable)
      const { path: comPort } = m;
      if (!/^COM\d+$/i.test(String(comPort || ''))) {
        return send(ws, { type: 'error', action: 'serial-force-free', msg: '串口号无效' });
      }
      log('audit', `请求提权释放串口 ${String(comPort).toUpperCase()}`);
      const ps1 = path.join(__dirname, 'free-serial.ps1');
      // Use an encoded, fixed PowerShell script and a validated COM value.
      // Never interpolate client-controlled text into a shell command line.
      const escPs = ps1.replace(/'/g, "''");
      const elevated = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${escPs}','-ComPort','${String(comPort).toUpperCase()}')`;
      const encoded = Buffer.from(elevated, 'utf16le').toString('base64');
      const cp = require('child_process');
      cp.execFile('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded],
        { timeout: 120000 }, (err, stdout, stderr) => {
          const ok = !err;
          send(ws, {
            type: 'serial-free', path: comPort, ok,
            msg: ok ? `设备 ${comPort} 已强制重启, 占用已释放` : `强制释放失败(需管理员确认 UAC): ${err ? err.message : ''}`,
          });
          if (!ok) console.log('[serial-force-free] 失败:', err && err.message, stderr);
        });
      break;
    }
    case 'scan-net': {
      // 网络扫描: 输入 IP/网段 → 发现存活主机 + 开放端口
      // 支持: 192.168.1.216 | 192.168.1.0/24 | 192.168.1.1-192.168.1.254 | 192.168.1.100-200
      const { target } = m;
      if (!target) return send(ws, { type: 'error', action: 'scan-net', msg: '缺少扫描目标' });
      const trimmed = String(target).trim();
      if (!isScanAllowed(trimmed)) {
        return send(ws, { type: 'error', action: 'scan-net', msg: '扫描目标必须是私网/网段地址' });
      }
      const ips = expandTarget(trimmed);
      if (ips.error) return send(ws, { type: 'error', action: 'scan-net', msg: ips.error });
      if (!ips.length) return send(ws, { type: 'error', action: 'scan-net', msg: '目标格式无法解析: ' + target });
      const probePorts = [22, 23, 21, 80, 443, 3389, 5555, 8080];
      const net = require('net');
      const hosts = [];
      const ipOpen = new Map();
      let idx = 0;
      const test = (ip, port) => new Promise((resolve) => {
        const s = net.connect({ host: ip, port, timeout: 450 });
        s.on('connect', () => {
          const list = ipOpen.get(ip) || (ipOpen.set(ip, []), ipOpen.get(ip));
          list.push(port);
          s.destroy();
          resolve(true);
        });
        s.on('error', () => resolve(false));
        s.on('timeout', () => { s.destroy(); resolve(false); });
      });
      const worker = async () => {
        while (idx < ips.length * probePorts.length) {
          const i = idx++;
          const ip = ips[Math.floor(i / probePorts.length)];
          const port = probePorts[i % probePorts.length];
          await test(ip, port);
        }
      };
      console.log(`[scan-net] 目标 ${target} → ${ips.length} 个 IP 探测中...`);
      await Promise.all(Array.from({ length: 60 }, worker));   // 60 并发
      for (const ip of ips) {
        const open = (ipOpen.get(ip) || []).sort((a, b) => a - b);
        if (open.length) hosts.push({ ip, open });
      }
      console.log(`[scan-net] 完成: 发现 ${hosts.length} 台设备`);
      send(ws, { type: 'scan-net', target, hosts });
      break;
    }
    case 'scan': {
      // 端口扫描: TCP 探测 (并发 20, 单端口 800ms 超时)
      const { host, ports } = m;
      if (!host || !Array.isArray(ports) || !ports.length) {
        return send(ws, { type: 'error', action: 'scan', msg: '扫描参数错误' });
      }
      // 仅允许扫描私网/环回地址
      const targetHost = String(host).trim();
      const targetIp = parseIPv4(targetHost);
      if (targetIp !== null && !isPrivateIPv4(targetHost)) {
        return send(ws, { type: 'error', action: 'scan', msg: '扫描目标必须是私网/环回地址' });
      }
      // 端口去重 + 范围校验 + 数量上限
      const uniquePorts = [...new Set(ports.map(Number))].filter(p => Number.isInteger(p) && p >= 1 && p <= 65535);
      if (uniquePorts.length > 1024) {
        return send(ws, { type: 'error', action: 'scan', msg: '端口数量超过上限(1024)' });
      }
      const net = require('net');
      const open = [];
      let idx = 0;
      const test = (port) => new Promise((resolve) => {
        const s = net.connect({ host: targetHost, port, timeout: 800 });
        s.on('connect', () => { open.push(port); s.destroy(); resolve(); });
        s.on('error', () => resolve());
        s.on('timeout', () => { s.destroy(); resolve(); });
      });
      const workers = Array.from({ length: 20 }, async () => {
        while (idx < uniquePorts.length) { const p = uniquePorts[idx++]; await test(p); }
      });
      await Promise.all(workers);
      send(ws, { type: 'scan', host: targetHost, open: open.sort((a, b) => a - b) });
      break;
    }
    case 'cleanup': {
      // Legacy clients sent this on every page load. It is intentionally a
      // no-op now because refresh reattaches the existing connections.
      break;
    }
    case 'ssh-hosts': {
      // 返回本机 SSH config 中的 Host 列表供前端解析
      const hosts = sshConfig || {};
      const list = Object.entries(hosts).map(([name, cfg]) => ({
        name,
        host: cfg.hostname || '',
        port: cfg.port || 22,
        user: cfg.user || 'root',
        key: cfg.identity || '',
        proxyJump: cfg.proxyJump || ''
      }));
      send(ws, { type: 'ssh-hosts', list });
      break;
    }
    case 'connect': {
      const source = Number.isInteger(m.sourceId) ? getConnection(ws, m.sourceId) : null;
      // Split panes are independent shells/connections, but their browser-side
      // config is intentionally redacted. Clone the full in-memory config from
      // the already-authenticated main connection without exposing credentials
      // back to the browser.
      const sess = connectionConfigForRequest(source, m.session);
      // Browser/workspace copies are deliberately redacted. Prefer the stable
      // saved-session id, but recover legacy workspace tabs by a unique endpoint
      // match so they also receive the Windows-encrypted credentials.
      mergeStoredCredentials(sess, storedSessionForConfig(sess));
      const existing = getConnection(ws, m.id);
      if (existing && existing.state !== 'closed' && existing.state !== 'closing') {
        if (connectionTargetsMatch(existing.config, sess)) {
          attachExistingConnection(ws, existing, m.id);
          break;
        }
        try { existing.close(); } catch {}
      }
      await doConnect(ws, sess, m.id);
      break;
    }
    case 'host-key-decision': {
      const conn = getConnection(ws, m.id);
      if (!conn || conn.config.type !== 'ssh' || !conn.resolveHostKey) {
        return send(ws, { type: 'error', id: m.id, action: 'host-key-decision', msg: '没有等待确认的 SSH 主机密钥' });
      }
      if (!conn.resolveHostKey(m.accept === true)) {
        return send(ws, { type: 'error', id: m.id, action: 'host-key-decision', msg: '主机密钥确认已过期' });
      }
      log('audit', `SSH 主机密钥 ${m.accept === true ? '已信任' : '已拒绝'} (会话 ${m.id})`);
      break;
    }
    case 'interactive-auth-response': {
      const conn = getConnection(ws, m.id);
      if (!conn || conn.config.type !== 'ssh' || !conn.submitInteractiveAuth) {
        return send(ws, { type: 'error', id: m.id, action: 'interactive-auth-response', msg: '没有等待中的 MFA 挑战' });
      }
      if (m.cancel === true) {
        if (!conn.cancelInteractiveAuth()) {
          return send(ws, { type: 'error', id: m.id, action: 'interactive-auth-response', msg: 'MFA 挑战已过期' });
        }
        return send(ws, { type: 'interactive-auth-cancelled', id: m.id });
      }
      if (!conn.submitInteractiveAuth(m.responses)) {
        return send(ws, { type: 'error', id: m.id, action: 'interactive-auth-response', msg: 'MFA 挑战已过期' });
      }
      break;
    }
    case 'serialports': {
      const { SerialPort } = require('serialport');
      const list = await SerialPort.list();
      send(ws, { type: 'serialports', list: list.map(p => ({ path: p.path, manufacturer: p.manufacturer })) });
      break;
    }
    case 'disconnect': {
      const conn = getConnection(ws, m.id);
      if (conn) { conn.close(); }
      break;
    }
    case 'resize': {
      const conn = getConnection(ws, m.id);
      if (conn && conn.resize) conn.resize(m.cols, m.rows);
      break;
    }
    case 'serial-control': {
      const conn = getConnection(ws, m.id);
      if (!conn || conn.config.type !== 'serial') {
        return send(ws, { type: 'error', id: m.id, action: 'serial-control', msg: '不是串口连接' });
      }
      try {
        if (m.action === 'signals') {
          await conn.setSignals({ dtr: !!m.dtr, rts: !!m.rts });
        } else if (m.action === 'break') {
          await conn.sendBreak(Math.min(Math.max(Number(m.duration) || 250, 20), 2000));
        } else {
          throw new Error('未知串口控制操作');
        }
        send(ws, { type: 'serial-control', id: m.id, ok: true, action: m.action });
      } catch (e) {
        send(ws, { type: 'error', id: m.id, action: 'serial-control', msg: `串口控制失败: ${e.message}` });
      }
      break;
    }
    case 'sftp': {
      const conn = getConnection(ws, m.id);
      if (!conn || conn.config.type !== 'ssh') {
        return send(ws, { type: 'error', id: m.id, action: 'sftp', msg: 'SFTP 需要活跃的 SSH 连接' });
      }
      if (m.action === 'list') {
        try {
          const r = await conn.sftpList(m.path || '.');
          send(ws, { type: 'sftp', id: m.id, action: 'list', path: r.path, entries: r.entries });
        } catch (e) {
          send(ws, { type: 'error', id: m.id, action: 'sftp', msg: `SFTP: ${e.message}` });
        }
      } else if (m.action === 'cwd') {
        // 获取 shell 当前目录 (定位文件面板; fresh 走交互式 shell pwd)
        const cwd = await conn.getShellCwd({ fresh: !!m.fresh });
        send(ws, { type: 'sftp', id: m.id, action: 'cwd', path: cwd });
      } else if (m.action === 'scan') {
        try {
          const listed = await conn.sftpList(m.path || '.');
          const collected = await conn.sftpCollectFiles(listed.path);
          const symlinks = (collected.files || []).filter((f) => f.isSymlink).length;
          const skippedDirs = Array.isArray(collected.skipped) ? collected.skipped.length : 0;
          send(ws, {
            type: 'sftp', id: m.id, action: 'scan', path: listed.path,
            files: (collected.files || []).filter((f) => !f.isSymlink).map((f) => ({
              path: f.path, name: f.name, size: f.size,
            })),
            skipped: symlinks + skippedDirs,
          });
        } catch (e) {
          send(ws, { type: 'error', id: m.id, action: 'sftp', msg: `SFTP: ${e.message}` });
        }
      }
      break;
    }
    case 'tunnel': {
      const conn = getConnection(ws, m.id);
      if (!conn || conn.config.type !== 'ssh') {
        return send(ws, { type: 'error', id: m.id, action: 'tunnel', msg: '隧道需要活跃的 SSH 连接' });
      }
      try {
        if (m.action === 'list') {
          const list = conn.listTunnels ? conn.listTunnels() : [];
          send(ws, { type: 'tunnel', id: m.id, action: 'list', tunnels: list });
        } else if (m.action === 'add') {
          const item = await conn.addTunnel({
            type: m.tunnelType,
            localPort: m.localPort,
            remoteHost: m.remoteHost,
            remotePort: m.remotePort,
          });
          if (conn.config.id && sessions[conn.config.id]) {
            const saved = sessions[conn.config.id];
            saved.tunnels = [...(saved.tunnels || []), { type: item.type, localPort: item.localPort, remoteHost: item.remoteHost, remotePort: item.remotePort }];
            saveSessions(sessions);
          }
          send(ws, { type: 'tunnel', id: m.id, action: 'add', tunnel: item, tunnels: conn.listTunnels() });
          log('audit', `创建 ${item.type} 隧道: ${item.localPort} → ${item.remoteHost}:${item.remotePort}`);
        } else if (m.action === 'remove') {
          const ok = conn.removeTunnel ? conn.removeTunnel(m.tunnelId) : false;
          send(ws, { type: 'tunnel', id: m.id, action: 'remove', ok, tunnelId: m.tunnelId, tunnels: conn.listTunnels() });
          if (ok) log('audit', `删除 SSH 隧道 ${m.tunnelId}`);
          if (ok && conn.config.id && sessions[conn.config.id]) { sessions[conn.config.id].tunnels = conn.listTunnels().map(t => ({ type: t.type, localPort: t.localPort, remoteHost: t.remoteHost, remotePort: t.remotePort })); saveSessions(sessions); }
        }
      } catch (e) {
        send(ws, { type: 'error', id: m.id, action: 'tunnel', msg: `隧道操作失败: ${e.message}` });
      }
      break;
    }
  }
  }

  return handle;
}

module.exports = { createWsMessageHandler };
