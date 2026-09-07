// 行为测试: Telnet IAC 分包与跨包自动登录
//
// 复现场景 (来自缺陷清单):
// 1) IAC DO NAWS 拆成两帧到达时, 协商字节此前被当作普通输出, 没有回应;
// 2) login: / Password: 提示被拆成多帧时, 此前无法触发自动登录。
// 这里用假 socket 直接喂分片数据, 断言回应字节与自动填充内容。
const assert = require('assert');
const TelnetConnection = require('../server/connections/telnet');

const IAC = 255, DO = 253, WILL = 251, DONT = 254, WONT = 252, SB = 250, SE = 240;
const OPT_NAWS = 31, OPT_SGA = 3, OPT_ECHO = 1;

function makeConn(config = {}) {
  const conn = new TelnetConnection({ host: '127.0.0.1', port: 23, ...config });
  const written = [];
  const emitted = [];
  conn.sock = {
    write: (chunk) => { written.push(Buffer.from(chunk)); return true; },
  };
  conn.state = 'connected';
  conn._process = (buf) => { emitted.push(Buffer.from(buf)); };
  return { conn, written, emitted };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // ---------- 1) IAC DO NAWS 分包 ----------
  {
    const { conn, written } = makeConn();
    conn._onData(Buffer.from([IAC]));
    assert.deepStrictEqual(conn._buf, Buffer.from([IAC]), '孤立的 IAC 必须保留在缓冲区等待补齐');
    conn._onData(Buffer.from([DO, OPT_NAWS]));
    assert.strictEqual(conn._buf.length, 0, '协商完成后缓冲区应清空');
    const bytes = Buffer.concat(written);
    assert.deepStrictEqual([...bytes.subarray(0, 3)], [IAC, WILL, OPT_NAWS], '必须回应 WILL NAWS');
    assert.deepStrictEqual([...bytes.subarray(3, 5)], [IAC, SB], '必须发送 NAWS 子协商');
    assert.ok(bytes.includes(Buffer.from([IAC, SE])), '子协商必须以 IAC SE 结束');
  }

  // ---------- 2) IAC 拆在命令与选项之间 ----------
  {
    const { conn, written } = makeConn();
    conn._onData(Buffer.from([IAC, DO]));
    assert.strictEqual(conn._buf.length, 2, 'IAC DO 后缺选项字节, 必须等待');
    conn._onData(Buffer.from([OPT_ECHO]));
    assert.deepStrictEqual(Buffer.concat(written).subarray(0, 3), Buffer.from([IAC, DO, OPT_ECHO]),
      '对 DO ECHO 应答 DO ECHO (接受远端回显)');
  }

  // ---------- 3) 子协商中出现 IAC IAC 转义, 不能误判为结束 ----------
  {
    const { conn, written } = makeConn();
    conn._onData(Buffer.from([IAC, SB, 42, IAC, IAC, 43, IAC, SE]));
    assert.strictEqual(conn._buf.length, 0, '含转义的子协商应正常消费');
    assert.deepStrictEqual(Buffer.concat(written), Buffer.alloc(0), '本子协商无需应答');
  }

  // ---------- 4) IAC IAC 转义还原为 0xFF 数据 ---------------------
  {
    const { conn, emitted } = makeConn();
    conn._onData(Buffer.from([0x41, IAC, IAC, 0x42]));
    assert.deepStrictEqual(Buffer.concat(emitted), Buffer.from([0x41, 0xff, 0x42]),
      'IAC IAC 应还原为 0xFF 数据');
  }

  // ---------- 5) WILL SGA 应答语义 (RFC 855: 接受用 DO) ----------
  {
    const { conn, written } = makeConn();
    conn._onData(Buffer.from([IAC, WILL, OPT_SGA, 0x68, 0x69]));
    assert.deepStrictEqual(Buffer.concat(written).subarray(0, 3), Buffer.from([IAC, DO, OPT_SGA]),
      '对 WILL SGA 应答 DO SGA');
    assert.strictEqual(conn._buf.length, 0);
  }

  // ---------- 6) login: 跨包自动登录 (每个字符一帧) ----------
  {
    const { conn, written } = makeConn({ autoLogin: true, loginUser: 'root', loginPass: 'secret' });
    const full = Buffer.from('busybox login: ', 'latin1');
    for (let i = 0; i < full.length; i++) conn._onData(full.subarray(i, i + 1));
    await sleep(400);                          // 登录名在 300ms 后写出
    const sent = written.map(b => b.toString('latin1')).join('');
    assert.ok(sent.includes('root\r\n'), `登录名未跨包发送: ${JSON.stringify(sent)}`);

    // 密码提示逐字符喂
    const passText = 'Password: ';
    for (let i = 0; i < passText.length; i++) conn._onData(Buffer.from(passText[i]));
    await sleep(400);
    const all = written.map(b => b.toString('latin1')).join('');
    assert.ok(all.includes('secret\r\n'), `密码未跨包发送: ${JSON.stringify(all)}`);
  }

  // ---------- 7) 拆包后终端仍只收到净数据 (协商字节不能进终端) ----------
  {
    const { conn, emitted } = makeConn();
    conn._onData(Buffer.from([IAC]));
    conn._onData(Buffer.from([DO, OPT_ECHO]));
    conn._onData(Buffer.from([0x41]));
    assert.deepStrictEqual(Buffer.concat(emitted), Buffer.from([0x41]),
      '协商字节绝不能作为普通输出落入终端');
  }

  console.log('✅ telnet split-packet IAC negotiation & auto-login contract passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});