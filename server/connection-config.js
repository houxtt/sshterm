// Select the configuration for a new connection. Split panes may clone the
// full server-side config of an authenticated source connection so credentials
// never need to round-trip through browser storage.
function connectionConfigForRequest(source, fallback = {}) {
  const sourceCfg = source && (source.state === 'connected' || source.state === 'connecting') && source.config
    ? source.config : null;
  const cfg = sourceCfg || fallback || {};
  return {
    ...cfg,
    proxy: cfg.proxy ? { ...cfg.proxy } : undefined,
    jumpAuth: cfg.jumpAuth ? { ...cfg.jumpAuth } : undefined,
  };
}

// Refresh/reattach sends the same numeric tab id and may omit host/user.
// Double-clicking a different saved session must not inherit that live socket.
function connectionTargetsMatch(existingCfg, requested) {
  if (!existingCfg || !requested) return true;
  if (!requested.host && !requested.username && !requested.user) return true;
  const hostA = String(existingCfg.host || '').trim().toLowerCase();
  const hostB = String(requested.host || '').trim().toLowerCase();
  if (hostB && hostA !== hostB) return false;
  if (requested.port != null && requested.port !== '') {
    const defaultPort = requested.type === 'telnet' ? 23 : (requested.type === 'vnc' ? 5901 : 22);
    if (Number(existingCfg.port || defaultPort) !== Number(requested.port || defaultPort)) return false;
  }
  const userB = String(requested.username || requested.user || '').trim();
  const userA = String(existingCfg.username || existingCfg.user || '').trim();
  if (userB && userA !== userB) return false;
  if (requested.type && existingCfg.type && requested.type !== existingCfg.type) return false;
  return true;
}

module.exports = { connectionConfigForRequest, connectionTargetsMatch };
