// Private-network TCP scan helpers (CIDR / range expansion).
'use strict';

const MAX_SCAN_HOSTS = 4096;

function isPrivateIPv6(ip) {
  const lower = String(ip).toLowerCase();
  if (lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('fe80')) return true;
  return false;
}

function isPrivateIPv4(ip) {
  const n = parseIPv4(ip);
  if (n === null) return false;
  const a = n >>> 24, b = (n >>> 16) & 255;
  if (a === 127) return true;            // loopback
  if (a === 10) return true;             // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12
  if (a === 192 && b === 168) return true;           // 192.168/16
  if (a === 169 && b === 254) return true;           // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

function isScanAllowed(target) {
  // Single IP
  const single = parseIPv4(target);
  if (single !== null) return isPrivateIPv4(target);
  // CIDR or range: expand and verify every address
  const expanded = expandTarget(target);
  if (expanded.error) return false;
  if (!expanded.length) return false;
  return expanded.every(isPrivateIPv4);
}

function parseIPv4(s) {
  const p = String(s).split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3]) >>> 0;
}
function formatIPv4(n) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
function expandTarget(t) {
  t = t.trim();
  const single = parseIPv4(t);
  if (single !== null) return [formatIPv4(single)];

  const cidr = t.match(/^([^/]+)\/(\d{1,2})$/);
  if (cidr) {
    const ip = parseIPv4(cidr[1]);
    const bits = Number(cidr[2]);
    if (ip === null || bits < 0 || bits > 32) return [];
    const size = 2 ** (32 - bits);
    if (size > MAX_SCAN_HOSTS) return { error: `网段过大: ${size} 台, 请缩小到不超过 ${MAX_SCAN_HOSTS} 台` };
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const network = ip & mask;
    return Array.from({ length: size }, (_, i) => formatIPv4((network + i) >>> 0));
  }

  const range = t.match(/^([^\-]+)\s*-\s*(.+)$/);
  if (range) {
    const start = parseIPv4(range[1]);
    const end = parseIPv4(range[2]) ?? (() => {
      const prefix = range[1].trim().split('.').slice(0, 3).join('.');
      const last = Number(range[2].trim());
      return parseIPv4(`${prefix}.${last}`);
    })();
    if (start === null || end === null || end < start) return [];
    const size = end - start + 1;
    if (size > MAX_SCAN_HOSTS) return { error: `扫描范围过大: ${size} 台, 请缩小到不超过 ${MAX_SCAN_HOSTS} 台` };
    return Array.from({ length: size }, (_, i) => formatIPv4((start + i) >>> 0));
  }
  return [];
  }

module.exports = {
  MAX_SCAN_HOSTS,
  isPrivateIPv6,
  isPrivateIPv4,
  isScanAllowed,
  parseIPv4,
  formatIPv4,
  expandTarget,
};
