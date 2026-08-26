// Test-only SFTP facade. It is installed solely when SSHTERM_TEST_SFTP_ROOT is
// explicitly set, allowing transport routes to be integration-tested without
// a network host. Production startup never imports or enables this fixture.
const fs = require('fs');
const net = require('net');
const path = require('path');

function installLocalSftpFixture(connections, root, id = 9900) {
  const base = path.resolve(root);
  const resolve = (remotePath) => {
    const relative = String(remotePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const local = path.resolve(base, relative);
    const rel = path.relative(base, local);
    if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) throw new Error('测试 SFTP 路径越界');
    return local;
  };
  const sftp = {
    stat(remotePath, callback) { fs.stat(resolve(remotePath), callback); },
    mkdir(remotePath, callback) { fs.mkdir(resolve(remotePath), { recursive: true }, () => callback()); },
    open(remotePath, flags, attrs, callback) {
      if (typeof attrs === 'function') { callback = attrs; attrs = 0o666; }
      fs.open(resolve(remotePath), flags, attrs || 0o666, callback);
    },
    read(handle, buffer, offset, length, position, callback) {
      fs.read(handle, buffer, offset, length, position, callback);
    },
    write(handle, buffer, offset, length, position, callback) {
      fs.write(handle, buffer, offset, length, position, error => callback(error));
    },
    close(handle, callback) { fs.close(handle, callback); },
    createReadStream(remotePath, options) { return fs.createReadStream(resolve(remotePath), options); },
    createWriteStream(remotePath, options) { return fs.createWriteStream(resolve(remotePath), options); },
  };
  connections.set(id, {
    id, state: 'connected', config: { type: 'ssh', name: 'fixture' }, getSftpInst: () => sftp,
    openForward: (host, port) => new Promise((resolveForward, rejectForward) => {
      if (host !== '127.0.0.1' && host !== 'localhost') return rejectForward(new Error('测试转发仅允许回环地址'));
      const socket = net.connect({ host: '127.0.0.1', port }, () => resolveForward(socket));
      socket.once('error', rejectForward);
    }),
    sftpCollectFiles: async (dir) => {
      const files = [];
      const localDir = resolve(dir);
      const walk = (base) => {
        for (const e of fs.readdirSync(path.join(localDir, base), { withFileTypes: true })) {
          const full = base ? `${base}/${e.name}` : e.name;
          if (e.isDirectory()) walk(full);
          else files.push({
            path: `${String(dir).replace(/\/$/, '')}/${full}`,
            name: full,
            size: fs.statSync(path.join(localDir, full)).size,
            isSymlink: e.isSymbolicLink(),
          });
        }
      };
      walk('');
      if (process.env.SSHTERM_TEST_SFTP_MISSING_ENTRY) {
        files.push({
          path: `${String(dir).replace(/\/$/, '')}/removed-after-scan.bin`,
          name: 'removed-after-scan.bin', size: 123, isSymlink: false,
        });
      }
      return files;
    },
  });
  return id;
}

module.exports = { installLocalSftpFixture };
