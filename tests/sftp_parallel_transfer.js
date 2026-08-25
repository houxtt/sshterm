// Verifies that the optimized SFTP transport performs concurrent requests
// without changing byte order or write offsets.
const assert = require('assert');
const { PassThrough } = require('stream');
const { createParallelReadStream, receiveParallelUpload } = require('../server/sftp-transfer');

function makeSftp(initial = Buffer.alloc(0)) {
  let data = Buffer.from(initial);
  let pendingReads = 0;
  let pendingWrites = 0;
  let maxReads = 0;
  let maxWrites = 0;
  return {
    stats: () => ({ data, maxReads, maxWrites }),
    open(path, flags, attrs, callback) {
      if (typeof attrs === 'function') callback = attrs;
      if (flags === 'w') data = Buffer.alloc(0);
      process.nextTick(() => callback(null, 1));
    },
    close(handle, callback) { process.nextTick(() => callback(null)); },
    read(handle, buffer, offset, length, position, callback) {
      pendingReads++;
      maxReads = Math.max(maxReads, pendingReads);
      setTimeout(() => {
        data.copy(buffer, offset, position, position + length);
        pendingReads--;
        callback(null, length, buffer, position);
      }, 1 + ((position / length) % 5));
    },
    write(handle, buffer, offset, length, position, callback) {
      pendingWrites++;
      maxWrites = Math.max(maxWrites, pendingWrites);
      const copy = Buffer.from(buffer.subarray(offset, offset + length));
      setTimeout(() => {
        if (data.length < position + length) {
          const grown = Buffer.alloc(position + length);
          data.copy(grown);
          data = grown;
        }
        copy.copy(data, position);
        pendingWrites--;
        callback(null);
      }, 1 + ((position / length) % 7));
    },
  };
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

(async () => {
  const source = Buffer.allocUnsafe(2 * 1024 * 1024 + 123);
  for (let i = 0; i < source.length; i++) source[i] = i % 251;

  const readSftp = makeSftp(source);
  const downloaded = await readAll(createParallelReadStream(readSftp, '/large.bin', {
    start: 0, end: source.length - 1, concurrency: 16,
  }));
  assert(downloaded.equals(source), 'parallel read must retain byte order');
  assert(readSftp.stats().maxReads > 1, 'more than one SFTP READ must be in flight');

  const writeSftp = makeSftp();
  const request = new PassThrough();
  const upload = receiveParallelUpload(request, writeSftp, '/large.bin', {
    concurrency: 16, maxBytes: source.length,
  });
  for (let offset = 0; offset < source.length; offset += 97 * 1024) {
    request.write(source.subarray(offset, Math.min(source.length, offset + 97 * 1024)));
  }
  request.end();
  const result = await upload.promise;
  assert.strictEqual(result.received, source.length, 'uploaded byte count');
  assert(writeSftp.stats().data.equals(source), 'parallel writes must honor explicit offsets');
  assert(writeSftp.stats().maxWrites > 1, 'more than one SFTP WRITE must be in flight');

  console.log(`✅ parallel SFTP transport passed (READ x${readSftp.stats().maxReads}, WRITE x${writeSftp.stats().maxWrites})`);
})().catch(error => { console.error('❌', error.stack || error.message); process.exit(1); });
