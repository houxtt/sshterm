// 串口打开路径/错误分类/瞬时失败重试
const assert = require('assert');
const SerialConnection = require('../server/connections/serial');
const { winSerialPath, classifySerialError, openWithRetry } = SerialConnection._test;

(async () => {
  if (process.platform === 'win32') {
    assert.strictEqual(winSerialPath('COM27'), '\\\\.\\COM27');
    assert.strictEqual(winSerialPath('\\\\.\\COM10'), '\\\\.\\COM10');
    assert.strictEqual(winSerialPath('com3'), '\\\\.\\COM3');
  } else {
    assert.strictEqual(winSerialPath('COM27'), 'COM27');
  }

  const denied = classifySerialError(Object.assign(new Error('Access denied'), { errno: 5 }));
  assert.strictEqual(denied.busy, true);
  assert.strictEqual(denied.retryable, true);

  const missing = classifySerialError(Object.assign(new Error('File not found'), { code: 'ENOENT' }));
  assert.strictEqual(missing.notFound, true);
  assert.strictEqual(missing.retryable, false);

  const genFail = classifySerialError(Object.assign(new Error('Unknown error code 31'), { errno: 31 }));
  assert.strictEqual(genFail.retryable, true);
  assert.strictEqual(genFail.notFound, false);

  let calls = 0;
  await openWithRetry(async () => {
    calls++;
    if (calls < 3) {
      const e = new Error('Access denied');
      e.errno = 5;
      throw e;
    }
  }, [0, 1, 1, 1]);
  assert.strictEqual(calls, 3, 'busy/open races must retry then succeed');

  let fails = 0;
  await assert.rejects(() => openWithRetry(async () => {
    fails++;
    const e = new Error('File not found');
    e.code = 'ENOENT';
    throw e;
  }, [0, 1, 1]), /not found/i);
  assert.strictEqual(fails, 1, 'missing ports must not be retried');

  console.log('✅ serial open retry / COM path contract passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
