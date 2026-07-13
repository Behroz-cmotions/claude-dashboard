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

test('scanTasks lists task dirs and links session tasks', () => {
  const dir = makeClaudeDir();
  fs.mkdirSync(path.join(dir, 'tasks', 'session-4efa8a05'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tasks', '1d8cfbc3-aaaa'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks', '1d8cfbc3-aaaa', '.lock'), '');
  const out = scanners.scanTasks(dir);
  assert.strictEqual(out.length, 2);
  const linked = out.find((t) => t.id === 'session-4efa8a05');
  assert.strictEqual(linked.linkedSession, '4efa8a05');
  assert.strictEqual(out.find((t) => t.id === '1d8cfbc3-aaaa').fileCount, 1);
});

test('parseFrontmatter parses key-value frontmatter with continuation lines', () => {
  const fm = scanners.parseFrontmatter(
    '---\nname: docs-agent\ndescription: Documentatie-specialist.\n  Tweede regel.\ntools: Read, Grep\n---\n\n# Body'
  );
  assert.strictEqual(fm.name, 'docs-agent');
  assert.strictEqual(fm.description, 'Documentatie-specialist. Tweede regel.');
  assert.strictEqual(fm.tools, 'Read, Grep');
});

test('scanAgents merges global and project agents', () => {
  const dir = makeClaudeDir();
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'agents', 'docs-agent.md'),
    '---\nname: docs-agent\ndescription: Notion-docs\n---\n'
  );
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-proj-'));
  fs.mkdirSync(path.join(proj, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\n---\n');
  const out = scanners.scanAgents(dir, [proj]);
  assert.deepStrictEqual(out.map((a) => a.name).sort(), ['docs-agent', 'reviewer']);
  assert.strictEqual(out.find((a) => a.name === 'docs-agent').scope, 'globaal');
  assert.strictEqual(out.find((a) => a.name === 'reviewer').scope, proj);
});

test('scanHooks flattens hooks from settings and masks secrets', () => {
  const dir = makeClaudeDir();
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'python doc_signal.py --token sk-abc123def456ghij' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check.sh' }] }],
      },
    })
  );
  const out = scanners.scanHooks(dir, []);
  assert.strictEqual(out.length, 2);
  const stop = out.find((h) => h.event === 'Stop');
  assert.ok(stop.command.includes('••••'));
  assert.strictEqual(out.find((h) => h.event === 'PreToolUse').matcher, 'Bash');
  assert.strictEqual(stop.source, 'globaal');
});

test('scanLoops finds cron/schedule-like entries, else empty', () => {
  const dir = makeClaudeDir();
  assert.deepStrictEqual(scanners.scanLoops(dir), []);
  fs.mkdirSync(path.join(dir, 'cron'));
  assert.deepStrictEqual(scanners.scanLoops(dir).map((l) => l.name), ['cron']);
});

test('scanHistory returns newest entries first, limited', () => {
  const dir = makeClaudeDir();
  const lines = [];
  for (let i = 0; i < 30; i++) {
    lines.push(JSON.stringify({ display: `prompt ${i}`, timestamp: i, sessionId: `s${i}`, project: 'C:\\p' }));
  }
  fs.writeFileSync(path.join(dir, 'history.jsonl'), lines.join('\n'));
  const out = scanners.scanHistory(dir, 5);
  assert.strictEqual(out.length, 5);
  assert.strictEqual(out[0].display, 'prompt 29');
  assert.strictEqual(out[4].display, 'prompt 25');
});
