// 行为测试: SSH 连接层可靠性修复
//  1) SFTP 首次初始化失败后必须清除被缓存的 rejected Promise, 允许重试;
//  2) SFTP 子系统被服务端关闭后清除引用, 下次调用可重建;
//  3) 隧道连接数: socket 与 SSH stream 各自 close 只扣减一次;
//  4) OSC 7 目录跟踪: 解析真实目录并处理跨包序列。
const assert = require('assert');
const { EventEmitter } = require('events');
const SSHConnection = require('../server/connections/ssh');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeConn(config) {
  const conn = new SSHConnection({ host: '127.0.0.1', port: 22, ...(config || {}) });
  conn.state = 'connected';
  return conn;
}

function mockPipeable() {
  const e = new EventEmitter();
  e.pipe = () => e;              // chainable, 与 net.Socket.pipe 签名一致
  return e;
}

(async () => {
  // ---------- 1) SFTP 初始化失败可重试 ----------
  {
    const conn = makeConn();
    let calls = 0;
    conn.client = {
      sftp: (cb) => { calls++; cb(new Error(`sftp-temp-fail-${calls}`)); },
    };
    await assert.rejects(conn.getSftp(), /sftp-temp-fail-1/, '第一次初始化必须失败');
    assert.strictEqual(conn._sftpPending, null, '失败后必须清除缓存的 Promise');
    await assert.rejects(conn.getSftp(), /sftp-temp-fail-2/, '第二次调用必须真正重试底层初始化');
    assert.strictEqual(calls, 2, '失败后重试必须重新调用 client.sftp()');
  }

  // ---------- 2) SFTP 子系统关闭后清除引用 ----------
  {
    const conn = makeConn();
    class FakeSftp extends EventEmitter {}
    const fake = new FakeSftp();
    conn.client = { sftp: (cb) => cb(null, fake) };
    const sf = await conn.getSftp();
    assert.strictEqual(conn._sftp, sf, '成功初始化后应缓存 sftp 实例');
    fake.emit('close');
    assert.ok(conn._sftp == null, '子系统 close 后必须清除引用, 允许下次重建');
    // 重建可用
    const second = new FakeSftp();
    conn.client = { sftp: (cb) => cb(null, second) };
    const sf2 = await conn.getSftp();
    assert.strictEqual(sf2, second, '子系统重建必须成功');
  }

  // ---------- 3) 隧道连接数只扣减一次 ----------
  {
    const conn = makeConn();
    const tunnel = { connections: 0, rxBytes: 0, txBytes: 0 };
    const socket = mockPipeable(), stream = mockPipeable();
    conn._pipeTunnel(tunnel, socket, stream);
    assert.strictEqual(tunnel.connections, 1, '建立后连接数应为 1');
    socket.emit('data', Buffer.alloc(10));
    stream.emit('data', Buffer.alloc(5));
    assert.strictEqual(tunnel.txBytes, 10);
    assert.strictEqual(tunnel.rxBytes, 5);
    socket.emit('close');
    stream.emit('close');           // 两端都会触发 close; 只扣一次
    assert.strictEqual(tunnel.connections, 0, '两次 close 只扣减一次, 不能变负数');
    // 再发一次 close 也不能负
    socket.emit('close');
    assert.strictEqual(tunnel.connections, 0);
  }

  // ---------- 4) OSC 7 目录跟踪 (含跨包) ----------
  {
    const conn = makeConn();
    conn._trackOsc7Cwd(Buffer.from('prefix \x1b]7;file://host/tmp/app\x07 more'));
    assert.strictEqual(conn._shellCwd, '/tmp/app', 'BEL 终止的 OSC 7 应被解析');
    // 跨包: 先收到不带终止符的前半段, 不能更新
    conn._trackOsc7Cwd(Buffer.from('x\x1b]7;file://host/opt'));
    assert.strictEqual(conn._shellCwd, '/tmp/app', '未终止的 OSC 7 必须等待后续数据');
    // 后半段到达补齐
    conn._trackOsc7Cwd(Buffer.from('/cfg\x07y'));
    assert.strictEqual(conn._shellCwd, '/opt/cfg', '跨包 OSC 7 应拼接解析');
    // ST 终止 (ESC \)
    conn._trackOsc7Cwd(Buffer.from('\x1b]7;file://host/var/log\x1b\\'));
    assert.strictEqual(conn._shellCwd, '/var/log', 'ST 终止的 OSC 7 应被解析');
    // URL 编码路径
    conn._trackOsc7Cwd('z\x1b]7;file://h/a%20b\x07');
    assert.strictEqual(conn._shellCwd, '/a b', 'URL 编码路径应 decode');
    // 畸形 OSC 7 不能抛异常
    conn._trackOsc7Cwd(Buffer.from('\x1b]7;file://\x07 bad'));
    assert.strictEqual(conn._shellCwd, '/a b', '畸形序列应被忽略');
  }

  // ---------- 5) SFTP 文件管理辅助 (_joinRemote) ----------
  {
    const conn = makeConn();
    assert.strictEqual(conn._joinRemote({}, '/opt/app/old.txt', 'new.txt'), '/opt/app/new.txt');
    assert.strictEqual(conn._joinRemote({}, '/opt/app/subdir/', 'subdir2'), '/opt/app/subdir2');
    assert.strictEqual(conn._joinRemote({}, 'old.txt', 'new.txt'), '/new.txt');
    assert.throws(() => conn._joinRemote({}, '/opt/app/old.txt', '..'), /名称无效/);
    assert.throws(() => conn._joinRemote({}, '/opt/app/old.txt', 'a/b'), /名称无效/);
  }

  // ---------- 6) 远端 RAM 解析 (/proc/meminfo 优先) ----------
  {
    const { parseRemoteMem } = SSHConnection._test;
    const sample = [
      '__SSHTERM_STATS_START__',
      'MEMINFO_START',
      'MemTotal:       67108864 kB',
      'MemAvailable:   33554432 kB',
      'MemFree:        16777216 kB',
      'MEMINFO_END',
      '__SSHTERM_STATS_END__',
    ].join('\n');
    const mem = parseRemoteMem(sample);
    assert.strictEqual(mem.memTotal, 67108864 * 1024);
    assert.strictEqual(mem.memUsed, (67108864 - 33554432) * 1024);
    const fallback = parseRemoteMem('MEM 2048 4096\n');
    assert.deepStrictEqual(fallback, { memUsed: 2048, memTotal: 4096 });
  }

  // ---------- 7) 交互式 shell pwd 查询 (过滤终端输出) ----------
  {
    const conn = makeConn();
    conn._emitData = () => {};
    conn.stream = { write: () => {}, on: () => {}, removeListener: () => {} };
    const token = 'abc123';
    const start = `__SSHTERM_PWD_START_${token}__`;
    const end = `__SSHTERM_PWD_END_${token}__`;
    conn._pwdCapture = {
      startRe: start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      endRe: end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      buf: Buffer.alloc(0),
      resolve: () => {},
      timer: setTimeout(() => {}, 1000),
    };
    const out = conn._consumeShellData(Buffer.from(`noise\r\n${start}\r\n/home/logic\r\n${end}\r\nrest`));
    assert.strictEqual(conn._shellCwd, '/home/logic');
    assert.strictEqual(out.length, 1);
    assert.ok(out[0].toString('utf8').includes('rest'));
    assert.ok(!out[0].toString('utf8').includes('noise'));
  }

  console.log('✅ SSH reliability contract passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});