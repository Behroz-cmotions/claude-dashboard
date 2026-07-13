const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scanners = require('../lib/scanners');

function makeClaudeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aos-claude-'));
}

test('scanSessions returns only alive sessions, newest first', () => {
  const dir = makeClaudeDir();
  fs.mkdirSync(path.join(dir, 'sessions'));
  const mk = (pid, updatedAt) =>
    fs.writeFileSync(
      path.join(dir, 'sessions', `${pid}.json`),
      JSON.stringify({
        pid, sessionId: `s-${pid}`, name: `sessie-${pid}`, cwd: 'C:\\proj',
        status: 'idle', kind: 'interactive', version: '2.1.0',
        startedAt: 1, updatedAt,
      })
    );
  mk(111, 100);
  mk(222, 300);
  mk(333, 200);
  fs.writeFileSync(path.join(dir, 'sessions', 'kapot.json'), '{niet json');
  const alive = (pid) => pid !== 333;
  const out = scanners.scanSessions(dir, alive);
  assert.deepStrictEqual(out.map((s) => s.pid), [222, 111]);
  assert.strictEqual(out[0].name, 'sessie-222');
});

test('scanSessions returns [] when sessions dir is missing', () => {
  assert.deepStrictEqual(scanners.scanSessions(makeClaudeDir()), []);
});
