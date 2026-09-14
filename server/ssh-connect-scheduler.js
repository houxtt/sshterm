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

function watchCancel(shouldCancel) {
  let iv;
  let stopped = false;
  const promise = new Promise((_, reject) => {
    const fail = () => {
      if (stopped) return;
      stopped = true;
      if (iv) { clearInterval(iv); iv = null; }
      reject(new SSHConnectCancelledError());
    };
    iv = setInterval(() => { if (shouldCancel()) fail(); }, 50);
    if (shouldCancel()) queueMicrotask(fail);
  });
  promise.catch(() => {});
  return {
    promise,
    stop() {
      stopped = true;
      if (iv) { clearInterval(iv); iv = null; }
    },
  };
}

async function runExclusive(key, task, shouldCancel = () => false) {
  const previous = tails.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  tails.set(key, current);

  // Keep the serialization chain even if this caller gives up while queued.
  // Otherwise a cancelled waiter would release the slot and overlap handshakes.
  const chained = previous.catch(() => {}).then(async () => {
    try {
      if (shouldCancel()) throw new SSHConnectCancelledError();
      return await task();
    } finally {
      release();
      if (tails.get(key) === current) tails.delete(key);
    }
  });
  chained.catch(() => {});

  const watch = watchCancel(shouldCancel);
  try {
    return await Promise.race([chained, watch.promise]);
  } finally {
    watch.stop();
  }
}

module.exports = { isBusy, runExclusive, SSHConnectCancelledError };
