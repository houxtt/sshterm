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

module.exports = { connectionConfigForRequest };
