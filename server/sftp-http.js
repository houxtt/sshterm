// HTTP handlers for /api/sftp/* and Zmodem download.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash } = require('crypto');
const { createParallelReadStream, receiveParallelUpload } = require('./sftp-transfer');

function statMtimeHeader(st) {
  const value = st && st.mtime;
  if (value instanceof Date) return String(Math.floor(value.getTime() / 1000));
  if (Number.isFinite(value)) return String(Math.floor(value));
  return '0';
}

function remoteFileIdentity(st) {
  const size = st && Number.isSafeInteger(st.size) ? st.size : 0;
  return `${size}:${statMtimeHeader(st)}`;
}

function handleSftpHttp(req, res, ctx) {
  const url = ctx.url;
  const getHttpConnection = ctx.getHttpConnection;
  const activeUploadKeys = ctx.activeUploadKeys;
  const directoryDownloads = ctx.directoryDownloads;
  const MAX_CONCURRENT_UPLOADS = ctx.MAX_CONCURRENT_UPLOADS;
  // uploadState.n is a mutable box: { n: number }
  const uploadState = ctx.uploadState;

  const isSftpApi = url.startsWith('/api/sftp/') || url.startsWith('/api/zmodem/');
  if (!isSftpApi) return false;

  // Zmodem 文件下载: /api/zmodem/download?file=<文件名>
  if (url.startsWith('/api/zmodem/download')) {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const name = qs.get('file') || '';
    const safe = path.basename(name).replace(/[\\/]/g, '_');
    const fp = path.join(os.homedir(), '.sshterm', 'zmodem', safe);
    // 使用流式传输避免大文件占用过多内存
    if (!fs.existsSync(fp)) { res.writeHead(404); return res.end('文件不存在'); }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(safe)}"`,
    });
    const stream = fs.createReadStream(fp);
    stream.on('error', () => { try { res.end(); } catch {} });
    stream.pipe(res);
    return true;
  }

  // SFTP 上传: HEAD 查询远端文件已存在大小 (断点续传判断)
  // PUT /api/sftp/upload?conn=<id>&path=<dir>&name=<file>&offset=N → 从 N 偏移续写
  if (req.method === 'HEAD' && url.startsWith('/api/sftp/upload')) {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const conn = getHttpConnection(qs);
    const dir = qs.get('path') || '.';
    const name = qs.get('name') || '';
    if (!conn || !conn.getSftpInst() || !name) { res.writeHead(400); return res.end(); }
    const remotePath = dir.endsWith('/') ? dir + name : `${dir}/${name}`;
    const sftp = conn.getSftpInst();
    sftp.stat(remotePath, (err, st) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Remote-Size': String(st.size),
        'X-Remote-Mtime': statMtimeHeader(st),
      });
      res.end(JSON.stringify({ size: st.size }));
    });
    return true;
  }
  if (req.method === 'PUT' && url.startsWith('/api/sftp/upload')) {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const conn = getHttpConnection(qs);
    const dir = qs.get('path') || '.';
    const name = qs.get('name') || '';
    const rawOffset = qs.get('offset');
    const offset = rawOffset === null ? 0 : Number(rawOffset);
    const segments = String(name).replace(/\\/g, '/').split('/');
    const contentLength = Number(req.headers['content-length'] || 0);
    const totalSizeHeader = req.headers['x-upload-total-size'];
    const totalSize = totalSizeHeader == null || totalSizeHeader === ''
      ? null
      : Number(totalSizeHeader);
    if (!conn || !conn.getSftpInst() || !name || !Number.isSafeInteger(offset) || offset < 0 ||
        segments.some(p => !p || p === '.' || p === '..' || p.includes('\0')) ||
        (contentLength && (!Number.isSafeInteger(contentLength) || contentLength < 0)) ||
        (totalSize != null && (!Number.isSafeInteger(totalSize) || totalSize < 0)) ||
        (contentLength && !Number.isSafeInteger(offset + contentLength))) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('上传参数错误(连接或文件名无效)');
    }
    const remotePath = dir.endsWith('/') ? dir + name : `${dir}/${name}`;
    // Include the window namespace so identical conn ids in different browser
    // windows cannot collide, while uploads from the same window sharing one
    // connection still block each other on the same remote file.
    const windowId = String(qs.get('window') || '');
    const uploadKey = `${windowId}:${conn.id}:${remotePath}`;
    if (uploadState.n >= MAX_CONCURRENT_UPLOADS) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '2' });
      return res.end('上传队列繁忙，请稍后重试');
    }
    if (activeUploadKeys.has(uploadKey)) {
      res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('同一远端文件正在上传');
    }
    uploadState.n++;
    activeUploadKeys.add(uploadKey);
    let finished = false;
    const finish = (status, message, payload) => {
      if (finished) return;
      finished = true;
      uploadState.n--;
      activeUploadKeys.delete(uploadKey);
      if (res.writableEnded) return;
      if (payload) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      } else {
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(message);
      }
    };
    const sftp = conn.getSftpInst();
    console.log(`[sftp-upload] ${remotePath} offset=${offset}`);
    // 递归创建父目录 (文件夹上传的子目录可能不存在)
    const parent = remotePath.slice(0, remotePath.lastIndexOf('/'));
    const mkdirs = (p) => new Promise((resolve) => {
      const parts = p.split('/').filter(Boolean);
      let cur = '';
      const next = (i) => {
        if (i >= parts.length) return resolve();
        cur += '/' + parts[i];
        sftp.mkdir(cur, () => next(i + 1));   // 已存在则忽略错误
      };
      next(0);
    });
    mkdirs(parent).then(() => {
      // createWriteStream 每次只保持一个约 32 KiB 的 WRITE 在途，高延迟
      // 网络会被 RTT 严重限速。这里使用有界并发随机写，同时保持偏移
      // 有序且仍然只允许一个请求写同一远端文件。
      // Only hash when this request body is the entire file — never treat a
      // partial chunk hash as the full-file digest.
      let shouldHash = false;
      if (totalSize != null) {
        shouldHash = offset === 0 && contentLength > 0 && offset + contentLength === totalSize;
        if (totalSize === 0 && offset === 0 && contentLength === 0) shouldHash = true;
      } else if (offset === 0) {
        shouldHash = true; // legacy single-shot: hash this body
      }
      const hash = shouldHash ? createHash('sha256') : null;
      const transfer = receiveParallelUpload(req, sftp, remotePath, {
        start: offset,
        flags: offset > 0 ? 'r+' : 'w',
        // Cap only this request body (chunk size), not a product file-size limit.
        maxBytes: contentLength > 0 ? contentLength : Infinity,
        onData: hash ? chunk => hash.update(chunk) : undefined,
      });
      req.setTimeout(30 * 60 * 1000, () => {
        const error = new Error('上传超时');
        transfer.abort(error);
        req.destroy(error);
      });
      transfer.promise.then(({ received }) => {
        req.setTimeout(0);
        const fileHash = hash ? hash.digest('hex') : null;
        console.log(`[sftp-upload] ${remotePath} 完成, size=${received}${fileHash ? `, hash=${fileHash.substring(0, 16)}...` : ''}`);
        finish(200, '', {
          ok: true, size: received, hash: fileHash,
          message: offset > 0 ? '续写完成' : '上传完成',
        });
      }).catch((e) => {
        console.log('[sftp-upload] 错误:', e.message);
        finish(req.aborted ? 499 : 500, e.message);
      });
    }).catch((e) => finish(500, `创建远端目录失败: ${e.message}`));
    return true;
  }

  // SFTP 文件管理: 重命名/移动/删除/权限修改 (均要求 SFTP 通道就绪)
  // POST /api/sftp/rename?conn=<id>&path=<old>&newPath=<new>
  if (req.method === 'POST' && url.startsWith('/api/sftp/rename')) {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const conn = getHttpConnection(qs);
    const rpath = qs.get('path') || '';
    const newPath = qs.get('newPath') || '';
    if (!conn || !conn.getSftpInst() || !rpath || !newPath || rpath === newPath ||
        rpath === '/' || newPath.includes('\0')) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('重命名参数错误(连接或路径无效)');
    }
    const sftp = conn.getSftpInst();
    sftp.rename(rpath, newPath, (err) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(`重命名失败: ${err.message}`);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: newPath }));
    });
    return true;
  }

  // POST /api/sftp/delete?conn=<id>&path=<path>&recursive=<bool>
  // 目录仅在 recursive=1 时递归删除; 文件/符号链接直接 unlink
  if (req.method === 'POST' && url.startsWith('/api/sftp/delete')) {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const conn = getHttpConnection(qs);
    const rpath = qs.get('path') || '';
    const recursive = qs.get('recursive') === '1' || qs.get('recursive') === 'true';
    if (!conn || !conn.getSftpInst() || !rpath || rpath === '/' || rpath === '.' || rpath.includes('\0')) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('删除参数错误(连接或路径无效)');
    }
    const sftp = conn.getSftpInst();
    sftp.lstat(rpath, (statErr, st) => {
      if (statErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('远端路径不存在或无法读取');
      }
      if (!st.isDirectory()) {
        return sftp.unlink(rpath, (err) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end(`删除失败: ${err.message}`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, removed: 1 }));
        });
      }
      if (!recursive) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('目录需要确认递归删除(recursive=1)');
      }
      // 迭代式递归删除: 目录先入 pending 栈; 遇到子目录时把父目录重新压栈在
      // 子目录之后, 保证子目录先清空再 rmdir 父目录 (深目录树不栈溢出)
      let removed = 0;
      const pending = [rpath];
      const finish = (status, message, payload) => {
        if (payload) {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        } else {
          res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(message);
        }
      };
      const step = () => {
        const dir = pending.pop();
        if (dir === undefined) return finish(200, '', { ok: true, removed });
        sftp.readdir(dir, (rdErr, list) => {
          if (rdErr) return finish(500, `删除失败: 无法读取目录 ${dir}: ${rdErr.message}`);
          const children = (list || []).map((f) => `${dir}/${f.filename}`);
          const removeChild = (i) => {
            if (i >= children.length) {
              return sftp.rmdir(dir, (err) => {
                if (err) return finish(500, `删除目录失败 ${dir}: ${err.message}`);
                removed++;
                step();
              });
            }
            const child = children[i];
            sftp.lstat(child, (lsErr, cst) => {
              if (lsErr) return finish(500, `删除失败: 无法读取 ${child}: ${lsErr.message}`);
              if (cst.isDirectory()) {
                pending.push(dir, child);
                return step();
              }
              sftp.unlink(child, (err) => {
                if (err) return finish(500, `删除文件失败 ${child}: ${err.message}`);
                removed++;
                removeChild(i + 1);
              });
            });
          };
          removeChild(0);
        });
      };
      step();
    });
    return true;
  }

  // POST /api/sftp/chmod?conn=<id>&path=<path>&mode=<octal> — 仅对文件有效
  if (req.method === 'POST' && url.startsWith('/api/sftp/chmod')) {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const conn = getHttpConnection(qs);
    const rpath = qs.get('path') || '';
    const modeText = qs.get('mode') || '';
    const mode = parseInt(modeText, 8);
    if (!conn || !conn.getSftpInst() || !rpath || rpath === '/' || rpath.includes('\0') ||
        !/^[0-7]{3,4}$/.test(modeText) || !Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('权限参数错误(连接、路径或权限模式无效)');
    }
    const sftp = conn.getSftpInst();
    sftp.stat(rpath, (statErr, st) => {
      if (statErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('远端路径不存在或无法读取');
      }
      if (st.isDirectory()) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('权限修改仅支持文件');
      }
      sftp.chmod(rpath, mode, (err) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end(`修改权限失败: ${err.message}`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mode: mode.toString(8) }));
      });
    });
    return true;
  }

  // SHA-256 is calculated server-side from the remote SFTP stream so uploads
  // can be verified without running shell commands on the remote machine.
  if (url.startsWith('/api/sftp/checksum')) {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const conn = getHttpConnection(qs);
    const rpath = qs.get('path') || '';
    if (!conn || !conn.getSftpInst() || !rpath) { res.writeHead(400); return res.end('SFTP 通道未就绪'); }
    const hash = require('crypto').createHash('sha256');
    const rs = conn.getSftpInst().createReadStream(rpath);
    rs.on('data', d => hash.update(d));
    rs.on('error', e => { res.writeHead(500); res.end(e.message); });
    rs.on('end', () => {
      if (!res.writableEnded) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ algorithm: 'sha256', hash: hash.digest('hex') })); }
    });
    return true;
  }

  // 目录 ZIP 的 HTTP 字节数与压缩前文件字节数不是同一口径。前端通过
  // 此轻量接口读取服务端实际已读取的远端字节数，扫描和压缩阶段均可
  // 显示真实进度。
  if (url.startsWith('/api/sftp/download-progress')) {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const conn = getHttpConnection(qs);
    const jobId = qs.get('job') || '';
    const job = directoryDownloads.get(jobId);
    if (!conn || !job || job.conn !== conn) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '下载任务不存在' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      phase: job.phase, loaded: job.loaded, total: job.total,
      filesDone: job.filesDone, filesTotal: job.filesTotal,
      skipped: job.skipped || 0, warning: job.warning || '', error: job.error || '',
    }));
  }

  // SFTP 目录下载 (递归打包 zip, 流式): /api/sftp/download-dir?conn=<id>&path=<远端目录>
  if (url.startsWith('/api/sftp/download-dir')) {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const conn = getHttpConnection(qs);
    const rdir = qs.get('path') || '';
    const jobId = qs.get('job') || '';
    if (!conn || !conn.getSftpInst()) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('SFTP 通道未就绪(连接可能已断开)');
    }
    if (jobId && !/^[a-zA-Z0-9_-]{8,80}$/.test(jobId)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('下载任务标识无效');
    }
    const job = {
      conn, phase: 'scanning', loaded: 0, total: 0,
      filesDone: 0, filesTotal: 0, skipped: 0,
      warning: '', error: '', updatedAt: Date.now(),
    };
    if (jobId) directoryDownloads.set(jobId, job);
    const dirName = path.basename(rdir) || 'download';
    conn.sftpCollectFiles(rdir).then(async (collected) => {
      try {
        const files = collected.files || collected;
        const scanSkipped = collected.skipped || [];
        const collectedCount = files.length;
        const skippedLinks = files.filter(file => file.isSymlink);
        const usable = files.filter(file => !file.isSymlink);
        const totalBytes = usable.reduce((s, f) => s + f.size, 0);
        job.phase = 'transferring';
        job.total = totalBytes;
        job.filesTotal = collectedCount;
        job.filesDone = skippedLinks.length + scanSkipped.length;
        job.skipped = skippedLinks.length + scanSkipped.length;
        const warnings = [];
        if (skippedLinks.length) warnings.push(`已跳过 ${skippedLinks.length} 个符号链接`);
        if (scanSkipped.length) warnings.push(`已跳过 ${scanSkipped.length} 个不可读目录`);
        if (warnings.length) job.warning = warnings.join('；');
        job.updatedAt = Date.now();
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(dirName)}.zip"`,
          'Cache-Control': 'no-cache',
          'X-Total-Size': String(totalBytes),
          'X-File-Count': String(collectedCount),
          'X-Skipped-Count': String(skippedLinks.length),
        });
        const { ZipArchive } = require('archiver');
        const archive = new ZipArchive({ zlib: { level: 1 } });   // 低压缩快打包
        const activeStreams = new Set();
        const entryWaiters = new Map();
        let archiveFailed = false;
        const rejectEntryWaiters = (error) => {
          for (const waiter of entryWaiters.values()) waiter.reject(error);
          entryWaiters.clear();
        };
        const failArchive = (e) => {
          if (archiveFailed) return;
          archiveFailed = true;
          console.log('[sftp-zip]', e.message);
          job.phase = 'failed'; job.error = e.message; job.updatedAt = Date.now();
          rejectEntryWaiters(e);
          for (const stream of activeStreams) stream.destroy();
          if (!res.destroyed) res.destroy(e);
        };
        archive.on('error', failArchive);
        archive.on('entry', entry => {
          const waiter = entryWaiters.get(entry.name);
          if (!waiter) return;
          entryWaiters.delete(entry.name);
          waiter.resolve();
        });
        archive.on('end', () => {
          job.phase = 'done'; job.loaded = job.total;
          job.filesDone = job.filesTotal; job.updatedAt = Date.now();
        });
        archive.pipe(res);
        req.on('aborted', () => {
          job.phase = 'cancelled'; job.error = '下载已取消'; job.updatedAt = Date.now();
          rejectEntryWaiters(new Error('下载已取消'));
          for (const stream of activeStreams) stream.destroy();
          archive.abort();
        });
        // 小文件先由多个 worker 并发预取，隐藏每个文件的
        // open/read/close 往返延迟；每个大文件内部则保持 32 个 READ
        // 请求在途。仅预取固定数量的小文件，内存有明确上限。
        const MAX_STREAMS = 8;
        const SMALL_FILE_BUFFER = 512 * 1024;
        let idx = 0;
        const appendBuffer = (buffer, name) => new Promise((resolve, reject) => {
          entryWaiters.set(name, { resolve, reject });
          archive.append(buffer, { name });
        });
        const skipUnreadableFile = (file, error, loadedForFile) => {
          activeStreams.delete(file.stream);
          job.loaded = Math.max(0, job.loaded - loadedForFile);
          job.total = Math.max(0, job.total - file.size);
          job.filesDone++;
          job.skipped++;
          job.warning = `${file.name}: ${error.message}`;
          job.updatedAt = Date.now();
          console.log(`[sftp-zip] 跳过无法读取的文件 ${file.path}: ${error.message}`);
        };
        const worker = async () => {
          while (idx < usable.length) {
            const f = usable[idx++];
            const rs = createParallelReadStream(conn.getSftpInst(), f.path, {
              start: 0, end: Math.max(-1, f.size - 1),
              concurrency: f.size <= SMALL_FILE_BUFFER ? 4 : 32,
            });
            f.stream = rs;
            activeStreams.add(rs);
            let fileLoaded = 0;
            if (f.size <= SMALL_FILE_BUFFER) {
              const chunks = [];
              try {
                await new Promise((resolve, reject) => {
                  rs.on('data', chunk => {
                    chunks.push(chunk);
                    fileLoaded += chunk.length;
                    job.loaded += chunk.length;
                    job.updatedAt = Date.now();
                  });
                  rs.on('error', reject);
                  rs.on('end', resolve);
                });
              } catch (error) {
                skipUnreadableFile(f, error, fileLoaded);
                continue;
              }
              activeStreams.delete(rs);
              job.filesDone++;
              job.updatedAt = Date.now();
              await appendBuffer(Buffer.concat(chunks, f.size), f.name);
            } else {
              let opened = false;
              try {
                await new Promise((resolve, reject) => {
                  rs.once('open', () => {
                    opened = true;
                    archive.append(rs, { name: f.name });
                  });
                  rs.on('data', chunk => {
                    fileLoaded += chunk.length;
                    job.loaded += chunk.length;
                    job.updatedAt = Date.now();
                  });
                  rs.on('error', reject);
                  rs.on('end', resolve);
                });
              } catch (error) {
                if (opened) {
                  failArchive(error);
                  throw error;
                }
                skipUnreadableFile(f, error, fileLoaded);
                continue;
              }
              activeStreams.delete(rs);
              job.filesDone++;
              job.updatedAt = Date.now();
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(MAX_STREAMS, files.length) }, worker));
        job.phase = 'packing'; job.updatedAt = Date.now();
        await archive.finalize();
        console.log(`[sftp-zip] ${rdir} → ${usable.length - skippedLinks.length} 文件打包完成, 跳过 ${job.skipped}`);
      } catch (e) {
        console.log('[sftp-zip] 异常:', e.message);
        job.phase = 'failed'; job.error = e.message; job.updatedAt = Date.now();
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`目录打包失败: ${e.message}`);
        } else if (!res.destroyed) res.destroy(e);
      }
    }).catch((e) => {
      console.log('[sftp-zip] 收集失败:', e.message);
      job.phase = 'failed'; job.error = e.message; job.updatedAt = Date.now();
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`目录扫描失败: ${e.message}`);
    });
    return true;
  }

  // SFTP file download with single-range support.  Range lets an interrupted
  // browser download continue without asking the remote server to resend the
  // bytes already received.
  if (url.startsWith('/api/sftp/download')) {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const conn = getHttpConnection(qs);
    const rpath = qs.get('path') || '';
    if (!conn || !conn.getSftpInst()) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('SFTP 通道未就绪(连接可能已断开)');
    }
    const sftp = conn.getSftpInst();
    sftp.stat(rpath, (statErr, st) => {
      if (statErr || !st || !Number.isSafeInteger(st.size)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('远端文件不存在或无法读取');
      }
      const size = st.size;
      const name = path.basename(rpath);
      let start = 0;
      let end = Math.max(0, size - 1);
      let partial = false;
      const identity = remoteFileIdentity(st);
      const range = req.headers.range;
      const clientIdentity = req.headers['x-remote-identity'];
      if (range) {
        if (clientIdentity && clientIdentity !== identity) {
          res.writeHead(412, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Remote-Identity': identity });
          return res.end('远端文件身份已变化，请重新下载');
        }
        const m = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!m) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          return res.end();
        }
        start = Number(m[1]);
        end = m[2] ? Number(m[2]) : end;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          return res.end();
        }
        end = Math.min(end, size - 1);
        partial = true;
      }
      const length = size === 0 ? 0 : end - start + 1;
      const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`,
        'Cache-Control': 'no-cache',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(length),
        'X-Remote-Size': String(size),
        'X-Remote-Mtime': statMtimeHeader(st),
        'X-Remote-Identity': identity,
      };
      if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      res.writeHead(partial ? 206 : 200, headers);
      if (size === 0) return res.end();
      const rs = createParallelReadStream(sftp, rpath, { start, end });
      rs.on('error', (e) => { if (!res.writableEnded) res.destroy(e); });
      req.on('aborted', () => { try { rs.destroy(); } catch {} });
      rs.pipe(res);
    });
    return true;
  }

  return false;
}

module.exports = { handleSftpHttp, statMtimeHeader, remoteFileIdentity };
