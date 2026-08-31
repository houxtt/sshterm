const assert = require('assert');
const net = require('net');
const scheduler = require('../server/ssh-connect-scheduler');
const SSHConnection = require('../server/connections/ssh');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function schedulerContract() {
  let active = 0;
  let maxActive = 0;
  const order = [];
  const task = id => scheduler.runExclusive('same-host:22', async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    order.push(`start-${id}`);
    await delay(20);
    order.push(`end-${id}`);
    active--;
  });

  await Promise.all([task(1), task(2), task(3)]);
  assert.strictEqual(maxActive, 1, 'same endpoint handshakes must be serialized');
  assert.deepStrictEqual(order, [
    'start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3',
  ]);
  assert.strictEqual(scheduler.isBusy('same-host:22'), false, 'queue must be released');

  const first = scheduler.runExclusive('cancel-host:22', () => delay(30));
  const cancelled = scheduler.runExclusive('cancel-host:22', () => {
    throw new Error('cancelled task must not run');
  }, () => true);
  await first;
  await assert.rejects(cancelled, error => error.code === 'SSH_CONNECT_CANCELLED');
}

async function timeoutAndCancellationContract() {
  assert.strictEqual(SSHConnection._test.readyTimeoutFor({}), 30000);
  assert.strictEqual(SSHConnection._test.readyTimeoutFor({ readyTimeout: 45000 }), 45000);
  assert.strictEqual(SSHConnection._test.readyTimeoutFor({ readyTimeout: 1000 }), 30000);
  const message = SSHConnection._test.connectionErrorMessage(
    Object.assign(new Error('Timed out while waiting for handshake'), { level: 'client-timeout' }),
    30000,
  );
  assert.match(message, /TCP 已连接/);
  assert.match(message, /MaxStartups/);

  let reset = 0;
  let destroyed = 0;
  SSHConnection._test.forceDestroyClient({
    _sock: { destroyed: false, resetAndDestroy: () => { reset++; } },
    destroy: () => { destroyed++; },
  });
  assert.strictEqual(reset, 1, 'pre-auth cancellation should send TCP RST');
  assert.strictEqual(destroyed, 0, 'RST path should not fall back to FIN destroy');

  // A server that accepts TCP but never sends an SSH banner reproduces the
  // reported failure. Closing a connecting tab must settle immediately instead
  // of waiting for readyTimeout and leaving a pre-auth socket behind.
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const conn = new SSHConnection({
      host: '127.0.0.1', port: server.address().port,
      username: 'test', password: 'test', readyTimeout: 10000,
    });
    conn.on('error', () => {});
    conn.on('close', () => {});
    const started = Date.now();
    const connecting = conn.connect();
    await delay(50);
    conn.close();
    await assert.rejects(connecting, error => error.code === 'SSH_CONNECT_CANCELLED');
    assert.ok(Date.now() - started < 1000, 'cancel should not wait for handshake timeout');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

(async () => {
  await schedulerContract();
  await timeoutAndCancellationContract();
  console.log('ssh_connect_resilience: PASS');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
