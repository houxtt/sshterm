// Token / origin / CSP helpers for the loopback HTTP+WS service.
'use strict';

const path = require('path');

function buildStaticCsp(port) {
  return [
    "default-src 'self'",
    "connect-src 'self' ws://127.0.0.1:" + port + " ws://localhost:" + port + " ws://[::1]:" + port,
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "img-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function createSecurity({ port, clientToken }) {
  function hasClientToken(req) {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      return u.searchParams.get('token') === clientToken;
    } catch { return false; }
  }

  function hasCliCapability(req) {
    return req.headers['x-sshterm-token'] === clientToken;
  }

  function isTrustedOrigin(req) {
    const source = req.headers.origin || req.headers.referer;
    if (!source) return false;
    try {
      const u = new URL(source);
      const validHost = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
        || u.hostname === '[::1]' || u.hostname === '::1';
      const origPort = u.port || (u.protocol === 'https:' ? '443' : '80');
      return validHost && origPort === String(port);
    } catch { return false; }
  }

  function isTrustedRequest(req) {
    return isTrustedOrigin(req) || hasCliCapability(req);
  }

  function isInside(root, candidate) {
    const rel = path.relative(root, candidate);
    return rel && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
  }

  return {
    STATIC_CSP: buildStaticCsp(port),
    hasClientToken,
    hasCliCapability,
    isTrustedOrigin,
    isTrustedRequest,
    isInside,
  };
}

module.exports = { createSecurity, buildStaticCsp };
