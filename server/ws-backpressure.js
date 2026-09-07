'use strict';

const WS_HIGH_WATER = 512 * 1024;
const WS_LOW_WATER = 128 * 1024;
const WS_MAX_QUEUE_ITEMS = 4096;

function attachWsBackpressure(ws, onLowWater) {
  if (!ws || ws._backpressureAttached) return;
  ws._backpressureAttached = true;
  ws._outboundQueue = [];
  ws._onLowWater = typeof onLowWater === 'function' ? onLowWater : null;
  ws._outboundTimer = setInterval(() => {
    if (ws.readyState !== 1 || !ws._outboundQueue.length) return;
    drainWsQueue(ws);
  }, 15);
  ws._outboundTimer.unref?.();
}

function sendBinary(ws, id, data) {
  if (!ws || ws.readyState !== 1) return false;
  attachWsBackpressure(ws);
  if (ws._outboundQueue.length >= WS_MAX_QUEUE_ITEMS) return false;
  const chunk = Buffer.from(data);
  ws._outboundQueue.push({ id, data: chunk });
  drainWsQueue(ws);
  return true;
}

function drainWsQueue(ws) {
  if (!ws || ws.readyState !== 1 || ws._drainingQueue) return;
  ws._drainingQueue = true;
  while (ws._outboundQueue.length && ws.readyState === 1) {
    if (ws.bufferedAmount > WS_HIGH_WATER) break;
    const item = ws._outboundQueue.shift();
    const frame = Buffer.allocUnsafe(2 + item.data.length);
    frame.writeUInt16LE(item.id, 0);
    item.data.copy(frame, 2);
    ws.send(frame, { binary: true });
  }
  ws._drainingQueue = false;
  if (ws.bufferedAmount <= WS_LOW_WATER && queueDepth(ws) === 0) {
    try { ws._onLowWater?.(); } catch {}
  }
}

function queueDepth(ws) {
  return (ws?._outboundQueue?.length || 0);
}

function isBackedUp(ws) {
  if (!ws || ws.readyState !== 1) return true;
  return queueDepth(ws) > 256 || ws.bufferedAmount > WS_HIGH_WATER;
}

module.exports = {
  WS_HIGH_WATER,
  WS_LOW_WATER,
  attachWsBackpressure,
  sendBinary,
  queueDepth,
  isBackedUp,
};
