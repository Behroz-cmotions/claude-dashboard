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

test('buildSessionTitles keeps the earliest prompt per session', () => {
  const dir = makeClaudeDir();
  const lines = [
    { display: 'tweede prompt', timestamp: 200, sessionId: 'abc', project: 'C:\\p' },
    { display: 'eerste prompt', timestamp: 100, sessionId: 'abc', project: 'C:\\p' },
    { display: 'andere sessie', timestamp: 150, sessionId: 'def', project: 'C:\\p' },
  ];
  fs.writeFileSync(path.join(dir, 'history.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  const titles = scanners.buildSessionTitles(dir);
  assert.strictEqual(titles.abc.display, 'eerste prompt');
  assert.strictEqual(titles.def.display, 'andere sessie');
});

test('scanProjects lists projects with sessions, titles and real path from cwd', () => {
  const dir = makeClaudeDir();
  const projDir = path.join(dir, 'projects', 'C--proj-demo');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(
    path.join(projDir, 'sessie-1.jsonl'),
    JSON.stringify({ cwd: 'C:\\proj demo', type: 'user' }) + '\n'
  );
  const titles = { 'sessie-1': { display: 'bouw een dashboard', timestamp: 1 } };
  const out = scanners.scanProjects(dir, titles);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].path, 'C:\\proj demo');
  assert.strictEqual(out[0].sessionCount, 1);
  assert.strictEqual(out[0].sessions[0].title, 'bouw een dashboard');
});

test('scanProjects falls back to dirName when no cwd found', () => {
  const dir = makeClaudeDir();
  const projDir = path.join(dir, 'projects', 'C--leeg');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 's.jsonl'), '{"type":"summary"}\n');
  const out = scanners.scanProjects(dir, {});
  assert.strictEqual(out[0].path, 'C--leeg');
});
