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

test('scanUsage aggregates tokens per day, model and tool from usage.db', () => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = makeClaudeDir();
  const db = new DatabaseSync(path.join(dir, 'usage.db'));
  db.exec(`CREATE TABLE turns (
    id INTEGER PRIMARY KEY, session_id TEXT, timestamp TEXT, model TEXT,
    input_tokens INT, output_tokens INT, cache_read_tokens INT, cache_creation_tokens INT,
    tool_name TEXT, cwd TEXT, message_id TEXT)`);
  const ins = db.prepare(
    "INSERT INTO turns (session_id, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, tool_name) VALUES (?, datetime('now'), ?, ?, ?, 0, 0, ?)"
  );
  ins.run('s1', 'claude-fable-5', 10, 100, 'Bash');
  ins.run('s1', 'claude-fable-5', 5, 50, 'Bash');
  ins.run('s2', 'claude-haiku-4-5', 1, 10, 'Read');
  db.close();
  const out = scanners.scanUsage(dir);
  assert.strictEqual(out.days.length, 1);
  assert.strictEqual(out.days[0].tokens, 176);
  assert.strictEqual(out.models[0].model, 'claude-fable-5');
  assert.strictEqual(out.models[0].tokens, 165);
  assert.strictEqual(out.tools[0].tool, 'Bash');
  assert.strictEqual(out.tools[0].uses, 2);
  assert.strictEqual(out.today.tokens, 176);
  assert.strictEqual(out.today.turns, 3);
});

test('scanUsage returns empty aggregates when usage.db is missing', () => {
  const out = scanners.scanUsage(makeClaudeDir());
  assert.deepStrictEqual(out.days, []);
  assert.strictEqual(out.today.tokens, 0);
});

test('scanActivity extracts last tool and text per active session', () => {
  const dir = makeClaudeDir();
  const projDir = path.join(dir, 'projects', 'C--demo');
  fs.mkdirSync(projDir, { recursive: true });
  const lines = [
    { type: 'assistant', timestamp: '2026-07-13T10:00:00Z', message: { content: [{ type: 'text', text: 'Ik ga de tests draaien.' }] } },
    { type: 'assistant', timestamp: '2026-07-13T10:00:05Z', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
    { type: 'user', timestamp: '2026-07-13T10:00:06Z', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
  ];
  fs.writeFileSync(path.join(projDir, 'sess-1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  const sessions = [{ sessionId: 'sess-1', name: 'demo-sessie', status: 'busy' }];
  const out = scanners.scanActivity(dir, sessions);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].sessionId, 'sess-1');
  assert.strictEqual(out[0].lastTool, 'Bash');
  assert.strictEqual(out[0].lastText, 'Ik ga de tests draaien.');
});

test('scanSkills lists skill dirs with frontmatter and enabled plugins', () => {
  const dir = makeClaudeDir();
  fs.mkdirSync(path.join(dir, 'skills', 'factuur'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'skills', 'factuur', 'SKILL.md'),
    '---\nname: factuur\ndescription: Maak een dansfactuur\n---\n'
  );
  fs.mkdirSync(path.join(dir, 'skills', 'zonder-md'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'superpowers@claude-plugins-official': true, 'uit@x': false } })
  );
  const out = scanners.scanSkills(dir);
  assert.strictEqual(out.skills.length, 2);
  assert.strictEqual(out.skills[0].name, 'factuur');
  assert.strictEqual(out.skills[0].description, 'Maak een dansfactuur');
  assert.strictEqual(out.skills[1].name, 'zonder-md');
  assert.deepStrictEqual(out.plugins, [{ name: 'superpowers@claude-plugins-official', enabled: true }, { name: 'uit@x', enabled: false }]);
});

test('scanMcpServers reads global and project servers from .claude.json', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-home-'));
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: { globalsrv: { type: 'stdio', command: 'npx globalsrv --key sk-abc123def456ghij' } },
      projects: {
        'C:\\proj-a': { mcpServers: { notion: { type: 'http', url: 'https://mcp.notion.com' } } },
        'C:\\proj-b': {},
      },
    })
  );
  const out = scanners.scanMcpServers(home);
  assert.strictEqual(out.length, 2);
  const glob = out.find((s) => s.name === 'globalsrv');
  assert.strictEqual(glob.scope, 'globaal');
  assert.ok(glob.detail.includes('••••'));
  const notion = out.find((s) => s.name === 'notion');
  assert.strictEqual(notion.scope, 'C:\\proj-a');
  assert.strictEqual(notion.detail, 'https://mcp.notion.com');
});

test('scanPlan reads plan from credentials and limits from the usage API', async () => {
  const dir = makeClaudeDir();
  fs.writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'tok-x', subscriptionType: 'max', rateLimitTier: 'max_20x' } })
  );
  const apiResponse = {
    limits: [
      { kind: 'session', percent: 34, severity: 'normal', resets_at: '2026-07-13T12:29:59Z', is_active: true, scope: null },
      { kind: 'weekly_all', percent: 4, severity: 'normal', resets_at: '2026-07-20T07:59:59Z', is_active: false, scope: null },
      { kind: 'weekly_scoped', percent: 6, severity: 'warning', resets_at: '2026-07-20T07:59:59Z', is_active: false, scope: { model: { display_name: 'Fable' } } },
    ],
    spend: { used: { amount_minor: 150 }, limit: { amount_minor: 3000 }, percent: 5, currency: 'EUR', enabled: true },
  };
  let capturedHeaders = null;
  const fakeFetch = async (url, opts) => {
    capturedHeaders = opts.headers;
    return { ok: true, status: 200, json: async () => apiResponse };
  };
  const out = await scanners.scanPlan(dir, fakeFetch);
  assert.strictEqual(out.plan, 'max');
  assert.strictEqual(out.tier, 'max_20x');
  assert.strictEqual(out.limits.length, 3);
  assert.strictEqual(out.limits[0].kind, 'session');
  assert.strictEqual(out.limits[0].percent, 34);
  assert.strictEqual(out.limits[0].isActive, true);
  assert.strictEqual(out.limits[2].scope, 'Fable');
  assert.strictEqual(out.limits[2].severity, 'warning');
  assert.strictEqual(out.spend.usedMinor, 150);
  assert.strictEqual(out.spend.limitMinor, 3000);
  assert.ok(capturedHeaders.Authorization.includes('tok-x'));
  // het token mag nooit in de output zitten
  assert.ok(!JSON.stringify(out).includes('tok-x'));
});

test('scanPlan throws a clear error without credentials or on API failure', async () => {
  const dir = makeClaudeDir();
  await assert.rejects(() => scanners.scanPlan(dir, async () => ({ ok: true })), /credentials/);
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't' } }));
  await assert.rejects(() => scanners.scanPlan(dir, async () => ({ ok: false, status: 401 })), /401/);
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
