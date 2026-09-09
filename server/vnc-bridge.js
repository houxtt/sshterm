// Direct VNC WebSocket bridge (loopback upgrade path).
'use strict';
const net = require('net');
const dns = require('dns');
const { WS_HIGH_WATER } = require('./ws-backpressure');
const { isPrivateIPv4, isPrivateIPv6 } = require('./net-scan');

function validVncHost(value) {
  return value.length > 0 && value.length <= 253 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function resumePausedConnections(ws, connections) {
  for (const [key, conn] of connections) {
    if (!key.startsWith(`${ws.windowId}:`) || conn.ownerWs !== ws || !conn._outputPaused) continue;
    conn._outputPaused = false;
    try { conn.stream?.resume(); } catch {}
  }
}

function vncTargetForRequest(req) {
  const query = new URL(req.url, 'http://127.0.0.1').searchParams;
  const remoteHost = String(query.get('host') || '127.0.0.1').trim().toLowerCase();
  const remotePort = Number(query.get('port') || 5901);
  if (!validVncHost(remoteHost)) throw new Error('VNC 主机地址无效');
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw new Error('VNC 端口无效');
  return { remoteHost, remotePort };
}

async function resolveVncConnectTarget(remoteHost) {
  if (net.isIP(remoteHost) === 4) {
    if (!isPrivateIPv4(remoteHost)) throw new Error('VNC 目标必须是私网/环回地址');
    return remoteHost;
  }
  if (net.isIP(remoteHost) === 6) {
    if (!isPrivateIPv6(remoteHost)) throw new Error('VNC 目标必须是私网/环回地址');
    return remoteHost;
  }
  const results = await dns.promises.lookup(remoteHost, { all: true, verbatim: true });
  if (!results.length) throw new Error('VNC 主机解析失败');
  for (const entry of results) {
    if (entry.family === 4 && !isPrivateIPv4(entry.address)) {
      throw new Error(`VNC 目标解析到非公网允许地址: ${entry.address}`);
    }
    if (entry.family === 6 && !isPrivateIPv6(entry.address)) {
      throw new Error(`VNC 目标解析到非公网允许地址: ${entry.address}`);
    }
  }
  const prefer = results.find(r => r.family === 4) || results[0];
  return prefer.address;
}

function openDirectVnc(remoteHost, remotePort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: remoteHost, port: remotePort });
    const timer = setTimeout(() => socket.destroy(new Error('VNC 连接超时')), 15000);
    timer.unref();
    const onError = error => { clearTimeout(timer); reject(error); };
    socket.once('error', onError);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.off('error', onError);
      resolve(socket);
    });
  });
}

function attachVncBridge(vncWss, { log }) {
vncWss.on('connection', async (ws, req) => {
  let stream = null;
  let cancelled = false;
  const pending = [];
  let pendingBytes = 0;
  const closeStream = () => {
    cancelled = true;
    if (!stream) return;
    try { stream.destroy(); } catch { try { stream.end(); } catch {} }
    stream = null;
  };
  const flushVncOutbound = () => {
    if (!stream || cancelled || ws.readyState !== 1) return;
    while (pending.length && ws.readyState === 1 && ws.bufferedAmount <= WS_HIGH_WATER) {
      const chunk = pending.shift();
      pendingBytes -= chunk.length;
      ws.send(chunk, { binary: true });
    }
  };
  ws.on('close', closeStream);
  ws.on('error', closeStream);
  ws.on('message', (data) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (stream) {
      if (!stream.write(chunk) && !stream._vncPaused) {
        stream._vncPaused = true;
        stream.once('drain', () => { stream._vncPaused = false; });
      }
      return;
    }
    pendingBytes += chunk.length;
    if (pendingBytes > 256 * 1024) return ws.close(1009, 'VNC 握手缓存过大');
    pending.push(chunk);
  });
  try {
    const { remoteHost, remotePort } = vncTargetForRequest(req);
    const connectHost = await resolveVncConnectTarget(remoteHost);
    if (cancelled || ws.readyState !== 1) return;
    stream = await openDirectVnc(connectHost, remotePort);
    if (cancelled || ws.readyState !== 1) {
      closeStream();
      return;
    }
    for (const chunk of pending) {
      if (!stream.write(chunk) && !stream._vncPaused) {
        stream._vncPaused = true;
        stream.once('drain', () => { stream._vncPaused = false; });
      }
    }
    pending.length = 0;
    pendingBytes = 0;
    stream.on('data', chunk => {
      if (cancelled || ws.readyState !== 1) return;
      pending.push(Buffer.from(chunk));
      pendingBytes += chunk.length;
      flushVncOutbound();
    });
    stream.once('error', error => {
      log('error', `[VNC ${remoteHost}:${remotePort}] 连接失败: ${error.message}`);
      if (ws.readyState < 2) ws.close(1011, 'VNC 连接失败');
    });
    stream.once('close', () => { if (ws.readyState < 2) ws.close(1000, 'VNC 已关闭'); });
    log('audit', `VNC 直接连接 ${remoteHost}:${remotePort} → ${connectHost}:${remotePort}`);
  } catch (error) {
    log('error', `VNC 连接失败: ${error.message}`);
    if (ws.readyState < 2) ws.close(1008, error.message.slice(0, 120));
  }
});
}

module.exports = {
  validVncHost,
  vncTargetForRequest,
  resolveVncConnectTarget,
  openDirectVnc,
  resumePausedConnections,
  attachVncBridge,
};
