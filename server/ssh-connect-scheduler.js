// Serialize unauthenticated SSH handshakes to the same endpoint.  Restoring a
// workspace can otherwise open several tabs at once and trip sshd MaxStartups
// (or the much smaller pre-auth limits found on embedded devices).
const tails = new Map();

class SSHConnectCancelledError extends Error {
  constructor() {
    super('SSH 连接已取消');
    this.code = 'SSH_CONNECT_CANCELLED';
  }
}

function isBusy(key) {
  return tails.has(key);
}

async function runExclusive(key, task, shouldCancel = () => false) {
  const previous = tails.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  tails.set(key, current);

  try {
    await previous.catch(() => {});
    if (shouldCancel()) throw new SSHConnectCancelledError();
    return await task();
  } finally {
    release();
    if (tails.get(key) === current) tails.delete(key);
  }
}

module.exports = { isBusy, runExclusive, SSHConnectCancelledError };
