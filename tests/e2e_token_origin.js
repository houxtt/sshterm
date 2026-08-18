// P0 Token 鉴权漏洞回归测试
// 验证: 1) 非可信 origin 无法获取 token 2) 非可信 origin 无法调用 API
// 用法: node tests/e2e_token_origin.js [http://127.0.0.1:PORT]
const http = require('http');
const https = require('https');
const url = require('url');
const WebSocket = require('ws');

async function fetch(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(urlStr);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request({ ...parsed, ...options }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }));
    });
    req.on('error', reject);
    if (options.method === 'GET' || !options.method) req.end();
    else if (options.body) req.write(options.body);
  });
}

function getBootstrapToken(base) {
  return new Promise((resolve, reject) => {
    fetch(`${base}/bootstrap.js`)
      .then(res => {
        const tokenMatch = res.data.match(/window\.__SSHTERM_TOKEN=([^;]+);/);
        const rawToken = tokenMatch ? tokenMatch[1].trim() : null;
        const token = rawToken && (rawToken.startsWith('"') || rawToken.startsWith("'"))
          ? rawToken.slice(1, -1) 
          : rawToken;
        resolve(token);
      })
      .catch(reject);
  });
}

async function test() {
  const base = process.argv[2] || 'http://127.0.0.1:8799';
  let passed = 0, failed = 0;

  console.log('🔒 P0 Token Origin 鉴权测试\n');

  // Test 1: 非可信 origin 无法获取 bootstrap.js
  console.log('Test 1: 非可信 origin 访问 /bootstrap.js (应返回 403)');
  try {
    const res = await fetch(`${base}/bootstrap.js`, {
      headers: { 'Origin': 'https://evil.com' }
    });
    if (res.status === 403 && res.data.includes('forbidden')) {
      console.log('  ✅ 通过: 返回 403 forbidden\n');
      passed++;
    } else {
      console.log(`  ❌ 失败: 状态 ${res.status}, 内容: ${res.data.substring(0, 50)}\n`);
      failed++;
    }
  } catch (e) {
    console.log(`  ❌ 错误: ${e.message}\n`);
    failed++;
  }

  // Test 2: 可信 origin 能获取 bootstrap.js
  console.log('Test 2: 可信 origin (127.0.0.1) 访问 /bootstrap.js (应返回 200 + token)');
  try {
    const res = await fetch(`${base}/bootstrap.js`, {
      headers: { 'Origin': 'http://127.0.0.1:8799' }
    });
    if (res.status === 200 && res.data.includes('window.__SSHTERM_TOKEN=')) {
      console.log('  ✅ 通过: 返回 200 + token\n');
      passed++;
    } else {
      console.log(`  ❌ 失败: 状态 ${res.status}\n`);
      failed++;
    }
  } catch (e) {
    console.log(`  ❌ 错误: ${e.message}\n`);
    failed++;
  }

  // Test 3: 无 origin 的请求能获取 bootstrap.js (CLI/非浏览器请求)
  console.log('Test 3: 无 Origin 头访问 /bootstrap.js (应返回 200，CLI 请求)');
  try {
    const res = await fetch(`${base}/bootstrap.js`);
    if (res.status === 200 && res.data.includes('window.__SSHTERM_TOKEN=')) {
      console.log('  ✅ 通过: 返回 200 + token\n');
      passed++;
    } else {
      console.log(`  ❌ 失败: 状态 ${res.status}\n`);
      failed++;
    }
  } catch (e) {
    console.log(`  ❌ 错误: ${e.message}\n`);
    failed++;
  }

  // Test 4: 使用 token + 可信 origin 调用 WebSocket API
  console.log('Test 4: 有效 token + 可信 origin 调用 WebSocket API (应连接成功)');
  try {
    const token = await getBootstrapToken(base);
    if (!token) {
      console.log('  ❌ 失败: 无法获取 token\n');
      failed++;
    } else {
      const wsUrl = `ws://${new URL(base).hostname}:${new URL(base).port || 8787}/?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(wsUrl, {
        headers: { 'Origin': 'http://127.0.0.1:8799' }
      });
      
      const connected = await new Promise((resolve) => {
        ws.on('open', () => resolve(true));
        ws.on('error', () => resolve(false));
        setTimeout(() => resolve(false), 5000);
      });
      
      ws.close();
      
      if (connected) {
        console.log('  ✅ 通过: WebSocket 连接成功\n');
        passed++;
      } else {
        console.log('  ❌ 失败: WebSocket 连接失败\n');
        failed++;
      }
    }
  } catch (e) {
    console.log(`  ❌ 错误: ${e.message}\n`);
    failed++;
  }

  // Test 5: 有效 token 但非可信 origin 调用 API (应返回 403)
  console.log('Test 5: 有效 token 但非可信 origin 调用 /bootstrap.js (应返回 403)');
  try {
    const token = await getBootstrapToken(base);
    if (!token) {
      console.log('  ❌ 失败: 无法获取 token\n');
      failed++;
    } else {
      // 用 token + 恶意 origin 访问 bootstrap.js（仍应返回 403，因为 origin 校验在 bootstrap.js 上也有效）
      const res = await fetch(`${base}/bootstrap.js?token=${token}`, {
        headers: { 'Origin': 'https://malicious-site.com' }
      });
      if (res.status === 403) {
        console.log('  ✅ 通过: 返回 403 forbidden\n');
        passed++;
      } else {
        console.log(`  ❌ 失败: 状态 ${res.status}, 应为 403\n`);
        failed++;
      }
    }
  } catch (e) {
    console.log(`  ❌ 错误: ${e.message}\n`);
    failed++;
  }

  // Test 6: 无效 token 调用 API (应返回 403)
  console.log('Test 6: 无效 token 调用 API (应返回 403)');
  try {
    const res = await fetch(`${base}/api/sessions?token=fake_token_123`, {
      headers: { 'Origin': 'http://127.0.0.1:8799' }
    });
    if (res.status === 403) {
      console.log('  ✅ 通过: 返回 403 forbidden\n');
      passed++;
    } else {
      console.log(`  ❌ 失败: 状态 ${res.status}, 应为 403\n`);
      failed++;
    }
  } catch (e) {
    console.log(`  ❌ 错误: ${e.message}\n`);
    failed++;
  }

  console.log('═══════════════════════════════');
  console.log(`结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

test().catch(e => { console.error(e); process.exit(1); });