// Test-only SFTP facade. It is installed solely when SSHTERM_TEST_SFTP_ROOT is
// explicitly set, allowing transport routes to be integration-tested without
// a network host. Production startup never imports or enables this fixture.
const fs = require('fs');
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
    createReadStream(remotePath, options) { return fs.createReadStream(resolve(remotePath), options); },
    createWriteStream(remotePath, options) { return fs.createWriteStream(resolve(remotePath), options); },
  };
  connections.set(id, { id, getSftpInst: () => sftp });
  return id;
}

module.exports = { installLocalSftpFixture };
