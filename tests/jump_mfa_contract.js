// 行为测试: 跳板机复杂 MFA (keyboard-interactive 多轮挑战 / OTP)
//
//  1) 口令类提示由服务端用已存凭据自动回答, 秘密不出网 (不发给浏览器);
//  2) OTP / 验证码类提示交给用户, 多提示顺序与 ssh2 的 finish() 对齐;
//  3) 同一轮挑战混用"密码 + 验证码"时, 只把验证码交给用户, 密码仍由服务端填;
//  4) 跳板机与目标主机都走同一个 UI 通道, 并带 target 信息标识来源跳数;
//  5) 用户取消 / 超时会以空回答结束, 不会把连接永久挂起。
const assert = require('assert');
const { EventEmitter } = require('events');
const SSHConnection = require('../server/connections/ssh');
const { attachKeyboardInteractive, interactiveAnswerPlan, mergeInteractiveAnswers } = SSHConnection._test;

// 最小 ssh2 Client 替身: 只需要 EventEmitter 行为 + 触发键盘交互事件。
function fakeClient() {
  const client = new EventEmitter();
  client.trigger = (prompts) => new Promise((resolve) => {
    client.emit('keyboard-interactive', 'SSH Server', 'instructions', 'en-US', prompts, resolve);
  });
  return client;
}

function fakeConnection() {
  const conn = new EventEmitter();
  conn._pendingInteractive = null;
  conn.emitted = [];
  conn.on('interactive-auth', (info) => { conn.emitted.push(info); });
  conn.answer = (values) => {
    const pending = conn._pendingInteractive;
    conn._pendingInteractive = null;
    clearTimeout(pending.timer);
    pending.finish(values);
  };
  conn.cancelled = () => {
    const pending = conn._pendingInteractive;
    conn._pendingInteractive = null;
    clearTimeout(pending.timer);
    pending.finish([]);
  };
  return conn;
}


(async () => {
  // ---------- 1) 纯口令轮次: 自动回答, 不弹 UI ----------
  {
    const conn = fakeConnection();
    const client = fakeClient();
    attachKeyboardInteractive(client, conn, 's3cret', { target: { host: '10.0.0.1', port: 22 } });
    const answers = await client.trigger([{ prompt: 'Password: ', echo: false }]);
    assert.deepStrictEqual(answers, ['s3cret'], '口令提示必须由服务端自动回答');
    assert.strictEqual(conn.emitted.length, 0, '纯口令轮次不得打扰用户');
  }

  // ---------- 2) OTP 轮次: 交给用户, 带跳板机来源 ----------
  {
    const conn = fakeConnection();
    const client = fakeClient();
    attachKeyboardInteractive(client, conn, 's3cret', {
      target: { host: 'jump.example', port: 2222, hopIndex: 1, hopTotal: 2 },
    });
    const pending = client.trigger([{ prompt: 'Verification code: ', echo: true }]);
    assert.strictEqual(conn.emitted.length, 1, '需要用户输入时必须发出 interactive-auth');
    const info = conn.emitted[0];
    assert.deepStrictEqual(info.prompts, [{ prompt: 'Verification code: ', echo: true }],
      '只有无法自动回答的提示才交给用户');
    assert.strictEqual(info.target.hopIndex, 1);
    assert.strictEqual(info.target.hopTotal, 2);
    assert.ok(info.label.includes('1/2') && info.label.includes('jump.example:2222'),
      `label 必须标明跳板机位置, 实际: ${info.label}`);
    conn.answer(['123456']);
    assert.deepStrictEqual(await pending, ['123456'], '用户回答必须按提示顺序回填');
  }

  // ---------- 3) 混合轮次: 密码服务端填, 验证码问用户 ----------
  {
    const conn = fakeConnection();
    const client = fakeClient();
    attachKeyboardInteractive(client, conn, 's3cret');
    const pending = client.trigger([
      { prompt: 'Password: ', echo: false },
      { prompt: 'OTP code: ', echo: true },
    ]);
    assert.strictEqual(conn.emitted.length, 1);
    assert.deepStrictEqual(conn.emitted[0].prompts.map(p => p.prompt), ['OTP code: '],
      '口令类提示不应出现在 UI 中');
    conn.answer(['654321']);
    assert.deepStrictEqual(await pending, ['s3cret', '654321'],
      'finish() 参数顺序必须与原始提示顺序一致');
  }

  // ---------- 4) 未存密码的口令提示仍需用户输入 ----------
  {
    const plan = interactiveAnswerPlan([{ prompt: 'Password: ' }], '');
    assert.strictEqual(plan.ask.length, 1, '没有已存密码时必须询问用户');
    assert.deepStrictEqual(plan.answers, ['']);
  }

  // ---------- 5) 多轮挑战连续处理 (密码 -> OTP) ----------
  {
    const conn = fakeConnection();
    const client = fakeClient();
    attachKeyboardInteractive(client, conn, 'pw');
    assert.deepStrictEqual(await client.trigger([{ prompt: 'Password: ' }]), ['pw'], '第一轮自动回答');
    const second = client.trigger([{ prompt: 'One-time password: ' }]);
    assert.strictEqual(conn.emitted.length, 1, '第二轮才需要用户输入');
    conn.answer(['000000']);
    assert.deepStrictEqual(await second, ['000000']);
    assert.strictEqual(conn._pendingInteractive, null, '回答后必须清空等待槽');
  }

  // ---------- 6) 取消不会挂起连接 ----------
  {
    const conn = fakeConnection();
    const client = fakeClient();
    attachKeyboardInteractive(client, conn, 'pw');
    const pending = client.trigger([{ prompt: 'Token: ' }]);
    conn.cancelled();
    assert.deepStrictEqual(await pending, [''], '取消应以空回答结束, 不能永久 pending');
    assert.strictEqual(conn._pendingInteractive, null);
  }

  // ---------- 7) 并发第二个挑战不得覆盖等待槽 ----------
  {
    const conn = fakeConnection();
    const client = fakeClient();
    attachKeyboardInteractive(client, conn, 'pw');
    const first = client.trigger([{ prompt: 'Token A: ' }]);
    const second = client.trigger([{ prompt: 'Token B: ' }]);
    assert.deepStrictEqual(await second, [], '并发的第二个挑战不应覆盖等待槽');
    conn.answer(['abc']);
    assert.deepStrictEqual(await first, ['abc']);
  }

  // ---------- 7b) 含 "password" 的 OTP 提示仍必须问用户 ----------
  {
    const { promptNeedsUserInput } = SSHConnection._test;
    for (const prompt of ['One-time password: ', 'one time password', 'Passcode: ',
      'Enter OTP: ', 'Verification code: ', '令牌: ', '动态口令: ']) {
      assert.strictEqual(promptNeedsUserInput(prompt), true, `OTP 提示必须问用户: ${prompt}`);
    }
    for (const prompt of ['Password: ', 'password:', 'Passphrase for key: ', '密码: ', '口令: ']) {
      assert.strictEqual(promptNeedsUserInput(prompt), false, `口令提示应自动填充: ${prompt}`);
    }
    // 有密码时: "One-time password" 仍问用户, 而不是被当作口令静默回填
    const plan = interactiveAnswerPlan([{ prompt: 'One-time password: ' }], 'stored');
    assert.deepStrictEqual(plan.answers, [''], 'OTP 不得使用已存密码回填');
    assert.strictEqual(plan.ask.length, 1);
  }

  // ---------- 8) mergeInteractiveAnswers 保留全部位置 ----------
  {
    const plan = interactiveAnswerPlan(
      [{ prompt: 'Password: ' }, { prompt: 'Verification code: ' }, { prompt: 'Password: ' }], 'pw');
    assert.deepStrictEqual(mergeInteractiveAnswers(plan, ['777']), ['pw', '777', 'pw']);
    assert.deepStrictEqual(mergeInteractiveAnswers(plan, []), ['pw', '', 'pw']);
  }

  // ---------- 9) 源码级: 跳板机循环走完整 MFA 通道而非静默回填 ----------
  {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'connections', 'ssh.js'), 'utf8');
    assert(src.includes('attachKeyboardInteractive(jump, this, jumpCredentials.password'),
      '跳板机跳必须走 attachKeyboardInteractive');
    assert(!src.includes('finishKb(answerInteractivePrompts('),
      '不得再用静默回填密码处理跳板机 keyboard-interactive');
    assert(src.includes('hopTotal: jumps.length'), '跳板机挑战必须标注总跳数');
    const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
    assert(app.includes('function mfaTargetText('), '前端必须渲染 MFA 来源提示');
    assert(app.includes("'mfa_jump'"), 'MFA 跳板机标签需要 i18n');
  }

  console.log('✅ jump-host MFA (keyboard-interactive multi-round) contract passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
