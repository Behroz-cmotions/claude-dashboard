const fs = require('fs');

const SECRET_KEY_RE = /key|token|secret|password|credential/i;
const SECRET_VALUE_RE = /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|xox[a-z]-[A-Za-z0-9-]{8,})\b/g;

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonlLines(filePath, { tail } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  let lines = raw.split('\n').filter((l) => l.trim());
  if (tail) lines = lines.slice(-tail);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // corrupte regel overslaan
    }
  }
  return out;
}

function readTailLines(filePath, maxBytes = 65536) {
  try {
    const st = fs.statSync(filePath);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    let lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
    if (start > 0) lines = lines.slice(1); // eerste regel kan afgekapt zijn
    const out = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // corrupte of afgekapte regel overslaan
      }
    }
    return out;
  } catch {
    return [];
  }
}

function maskSecrets(value, keyHint = '') {
  if (typeof value === 'string') {
    if (SECRET_KEY_RE.test(keyHint)) return '••••';
    return value.replace(SECRET_VALUE_RE, '••••');
  }
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskSecrets(v, k);
    return out;
  }
  return value;
}

module.exports = { readJsonSafe, readJsonlLines, readTailLines, maskSecrets };
