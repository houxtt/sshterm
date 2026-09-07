'use strict';

const { Readable } = require('stream');

// ssh2's SFTP ReadStream/WriteStream issue one request at a time. On a
// high-latency link that limits throughput to roughly one 32 KiB packet per
// round trip. These helpers keep several independent SFTP requests in flight
// while retaining ordered output and bounded memory usage.
const DEFAULT_CHUNK_SIZE = 32 * 1024;
const DEFAULT_CONCURRENCY = 32;

class ParallelSftpReadStream extends Readable {
  constructor(sftp, remotePath, options = {}) {
    super({ highWaterMark: options.highWaterMark || 1024 * 1024 });
    this.sftp = sftp;
    this.remotePath = remotePath;
    this.start = Number.isSafeInteger(options.start) ? options.start : 0;
    this.end = Number.isSafeInteger(options.end) ? options.end : -1;
    this.chunkSize = Math.max(1024, Math.min(options.chunkSize || DEFAULT_CHUNK_SIZE, 32 * 1024));
    this.concurrency = Math.max(1, Math.min(options.concurrency || DEFAULT_CONCURRENCY, 64));
    this.nextRequest = this.start;
    this.nextOutput = this.start;
    this.pending = 0;
    this.results = new Map();
    this.handle = null;
    this.opening = true;
    this.wantData = false;
    this.finished = false;

    if (this.end < this.start) {
      this.opening = false;
      this.finished = true;
      process.nextTick(() => this.push(null));
      return;
    }
    sftp.open(remotePath, 'r', (error, handle) => {
      this.opening = false;
      if (this.destroyed) {
        if (handle) return sftp.close(handle, () => {});
        return;
      }
      if (error) return this.destroy(error);
      this.handle = handle;
      this.emit('open', handle);
      this._pump();
    });
  }

  _read() {
    this.wantData = true;
    this._pump();
  }

  _pump() {
    if (this.destroyed || this.finished || this.opening || !this.handle) return;

    while (this.wantData && this.results.has(this.nextOutput)) {
      const data = this.results.get(this.nextOutput);
      this.results.delete(this.nextOutput);
      this.nextOutput += data.length;
      if (!this.push(data)) this.wantData = false;
    }

    if (this.nextOutput > this.end && this.pending === 0 && this.results.size === 0) {
      this.finished = true;
      const handle = this.handle;
      this.handle = null;
      return this.sftp.close(handle, (error) => error ? this.destroy(error) : this.push(null));
    }

    // Bound both in-flight requests and out-of-order cached chunks so a slow
    // first block cannot grow memory toward the whole file size.
    while (this.wantData
      && this.pending < this.concurrency
      && this.pending + this.results.size < this.concurrency
      && this.nextRequest <= this.end) {
      const position = this.nextRequest;
      const length = Math.min(this.chunkSize, this.end - position + 1);
      const buffer = Buffer.allocUnsafe(length);
      this.nextRequest += length;
      this.pending++;
      this.sftp.read(this.handle, buffer, 0, length, position, (error, bytesRead) => {
        this.pending--;
        if (this.destroyed) return;
        if (error) return this.destroy(error);
        if (bytesRead !== length) {
          return this.destroy(new Error(`SFTP 文件在下载期间发生变化 (${position}: ${bytesRead}/${length})`));
        }
        this.results.set(position, bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
        this._pump();
      });
    }
  }

  _destroy(error, callback) {
    const handle = this.handle;
    this.handle = null;
    this.results.clear();
    if (!handle) return callback(error);
    this.sftp.close(handle, () => callback(error));
  }
}

function createParallelReadStream(sftp, remotePath, options) {
  return new ParallelSftpReadStream(sftp, remotePath, options);
}

function receiveParallelUpload(req, sftp, remotePath, options = {}) {
  const start = Number.isSafeInteger(options.start) ? options.start : 0;
  const concurrency = Math.max(1, Math.min(options.concurrency || DEFAULT_CONCURRENCY, 64));
  const chunkSize = Math.max(1024, Math.min(options.chunkSize || DEFAULT_CHUNK_SIZE, 32 * 1024));
  const maxBytes = options.maxBytes || Infinity;
  let handle = null;
  let position = start;
  let received = 0;
  let pending = 0;
  let inputEnded = false;
  let settled = false;
  let paused = false;
  const queue = [];

  let rejectPromise;
  let resolvePromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const cleanup = () => {
    req.removeListener('data', onData);
    req.removeListener('end', onEnd);
    req.removeListener('aborted', onAborted);
    req.removeListener('error', onRequestError);
  };
  const close = (callback) => {
    const current = handle;
    handle = null;
    if (!current) return callback();
    sftp.close(current, (error) => callback(error));
  };
  const fail = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    try { req.pause(); } catch {}
    close((closeErr) => rejectPromise(closeErr || error));
  };
  const finishIfReady = () => {
    if (settled || !inputEnded || pending || queue.length) return;
    settled = true;
    cleanup();
    close((closeErr) => (closeErr ? rejectPromise(closeErr) : resolvePromise({ received })));
  };
  const drain = () => {
    if (settled || !handle) return;
    while (pending < concurrency && queue.length) {
      const chunk = queue.shift();
      const writePosition = position;
      position += chunk.length;
      pending++;
      sftp.write(handle, chunk, 0, chunk.length, writePosition, (error) => {
        pending--;
        if (error) return fail(error);
        if (paused && pending < concurrency && queue.length === 0 && !inputEnded) {
          paused = false;
          req.resume();
        }
        drain();
        finishIfReady();
      });
    }
    if ((pending >= concurrency || queue.length) && !paused && !inputEnded) {
      paused = true;
      req.pause();
    }
  };
  function onData(chunk) {
    if (settled) return;
    received += chunk.length;
    if (received > maxBytes) {
      const error = new Error('上传文件超过大小上限');
      fail(error);
      return req.destroy(error);
    }
    if (options.onData) options.onData(chunk);
    for (let offset = 0; offset < chunk.length; offset += chunkSize) {
      queue.push(chunk.subarray(offset, Math.min(offset + chunkSize, chunk.length)));
    }
    drain();
  }
  function onEnd() { inputEnded = true; drain(); finishIfReady(); }
  function onAborted() { fail(new Error('上传已取消')); }
  function onRequestError(error) { fail(error); }

  sftp.open(remotePath, options.flags || (start > 0 ? 'r+' : 'w'), options.mode || 0o666, (error, openedHandle) => {
    if (error) return fail(error);
    if (settled) return sftp.close(openedHandle, () => {});
    handle = openedHandle;
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('aborted', onAborted);
    req.on('error', onRequestError);
    req.resume();
  });

  return { promise, abort: (error = new Error('上传已取消')) => fail(error) };
}

module.exports = {
  createParallelReadStream,
  receiveParallelUpload,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CONCURRENCY,
};
