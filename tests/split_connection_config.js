const assert = require('assert');
const { connectionConfigForRequest } = require('../server/connection-config');

const source = {
  state: 'connected',
  config: {
    id: 'saved-session', type: 'ssh', host: 'server.internal', username: 'logic',
    password: 'server-memory-only', privateKey: 'C:/keys/id_ed25519',
    proxy: { type: 'socks5', host: 'proxy.internal', port: 1080, password: 'proxy-secret' },
    jumpAuth: { username: 'jump', password: 'jump-secret' },
  },
};
const redactedBrowserConfig = {
  id: 'saved-session', type: 'ssh', host: 'server.internal', username: 'logic',
};

const cloned = connectionConfigForRequest(source, redactedBrowserConfig);
assert.strictEqual(cloned.password, 'server-memory-only', 'split must use the authenticated source password');
assert.strictEqual(cloned.privateKey, 'C:/keys/id_ed25519', 'split must use the authenticated source key');
assert.strictEqual(cloned.proxy.password, 'proxy-secret');
assert.strictEqual(cloned.jumpAuth.password, 'jump-secret');
assert.notStrictEqual(cloned.proxy, source.config.proxy, 'nested proxy config must be copied');
assert.notStrictEqual(cloned.jumpAuth, source.config.jumpAuth, 'nested jump config must be copied');

source.state = 'connecting';
assert.strictEqual(
  connectionConfigForRequest(source, redactedBrowserConfig).password,
  'server-memory-only',
  'a split restored in parallel with its main connection must reuse the in-memory credentials',
);

source.state = 'closed';
assert.deepStrictEqual(
  connectionConfigForRequest(source, redactedBrowserConfig),
  { ...redactedBrowserConfig, proxy: undefined, jumpAuth: undefined },
  'a closed source must not be reused',
);
console.log('✅ split connection credential clone passed');
