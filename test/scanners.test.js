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
  assert.strictEqual(out.find((a) => a.name === 'docs-agent').scope, 'global');
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
  assert.strictEqual(stop.source, 'global');
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
  assert.strictEqual(glob.scope, 'global');
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
  await assert.rejects(
    () => scanners.scanPlan(dir, async () => ({ ok: true }), { platform: 'win32', env: {}, homeDir: dir }),
    /credentials/
  );
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't' } }));
  await assert.rejects(() => scanners.scanPlan(dir, async () => ({ ok: false, status: 401 })), /401/);
});

test('scanPlan herkent een API-key via settings.json zonder de usage-API aan te roepen', async () => {
  const dir = makeClaudeDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ apiKeyHelper: 'C:\\keys\\helper.ps1' }));
  let fetchCalled = false;
  const out = await scanners.scanPlan(dir, async () => { fetchCalled = true; return { ok: true }; },
    { platform: 'win32', env: {}, homeDir: dir });
  assert.strictEqual(out.authMethod, 'api-key');
  assert.match(out.source, /apiKeyHelper/);
  assert.deepStrictEqual(out.limits, []);
  assert.strictEqual(out.spend, null);
  assert.strictEqual(fetchCalled, false, 'geen usage-API-call bij een API-key');
});

test('scanPlan herkent Bedrock en Vertex via settings.json env', async () => {
  const dir = makeClaudeDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }));
  const out = await scanners.scanPlan(dir, async () => ({ ok: true }), { platform: 'win32', env: {}, homeDir: dir });
  assert.strictEqual(out.authMethod, 'bedrock');

  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: '1' } }));
  const out2 = await scanners.scanPlan(dir, async () => ({ ok: true }), { platform: 'win32', env: {}, homeDir: dir });
  assert.strictEqual(out2.authMethod, 'vertex');
});

test('scanPlan herkent een goedgekeurde API-key in .claude.json', async () => {
  const dir = makeClaudeDir();
  const home = makeClaudeDir();
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ customApiKeyResponses: { approved: ['sk-tail'] } }));
  const out = await scanners.scanPlan(dir, async () => ({ ok: true }), { platform: 'win32', env: {}, homeDir: home });
  assert.strictEqual(out.authMethod, 'api-key');
  assert.match(out.source, /\.claude\.json/);
});

test('scanPlan herkent ANTHROPIC_API_KEY in de proces-omgeving', async () => {
  const dir = makeClaudeDir();
  const out = await scanners.scanPlan(dir, async () => ({ ok: true }),
    { platform: 'win32', env: { ANTHROPIC_API_KEY: 'sk-x' }, homeDir: dir });
  assert.strictEqual(out.authMethod, 'api-key');
  assert.match(out.source, /environment/);
});

test('scanPlan geeft OAuth voorrang boven API-key-sporen', async () => {
  const dir = makeClaudeDir();
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't', subscriptionType: 'pro' } }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ apiKeyHelper: 'x' }));
  const out = await scanners.scanPlan(dir, async () => ({ ok: true, status: 200, json: async () => ({ limits: [] }) }),
    { platform: 'win32', env: {}, homeDir: dir });
  assert.strictEqual(out.plan, 'pro');
  assert.strictEqual(out.authMethod, undefined);
});

test('scanPlan valt op macOS terug op de Keychain als .credentials.json ontbreekt', async () => {
  const dir = makeClaudeDir();
  let capturedCmd = null;
  const fakeExec = (cmd, args) => {
    capturedCmd = [cmd, ...args];
    return JSON.stringify({ claudeAiOauth: { accessToken: 'tok-mac', subscriptionType: 'pro' } }) + '\n';
  };
  let capturedHeaders = null;
  const fakeFetch = async (url, opts) => {
    capturedHeaders = opts.headers;
    return { ok: true, status: 200, json: async () => ({ limits: [] }) };
  };
  const out = await scanners.scanPlan(dir, fakeFetch, { platform: 'darwin', execFileSync: fakeExec });
  assert.strictEqual(out.plan, 'pro');
  assert.ok(capturedHeaders.Authorization.includes('tok-mac'));
  assert.strictEqual(capturedCmd[0], 'security');
  assert.ok(capturedCmd.includes('Claude Code-credentials'));
});

test('scanPlan op macOS geeft de duidelijke fout als ook de Keychain niets oplevert', async () => {
  const dir = makeClaudeDir();
  const failingExec = () => {
    throw new Error('security: SecKeychainSearchCopyNext: The specified item could not be found.');
  };
  await assert.rejects(
    () => scanners.scanPlan(dir, async () => ({ ok: true }), { platform: 'darwin', execFileSync: failingExec }),
    /credentials/
  );
});

test('scanPlan gebruikt .credentials.json ook op macOS als het bestand er wél is', async () => {
  const dir = makeClaudeDir();
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-file', subscriptionType: 'max' } }));
  let execCalled = false;
  const fakeExec = () => {
    execCalled = true;
    return '{}';
  };
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ limits: [] }) });
  const out = await scanners.scanPlan(dir, fakeFetch, { platform: 'darwin', execFileSync: fakeExec });
  assert.strictEqual(out.plan, 'max');
  assert.strictEqual(execCalled, false, 'geen Keychain-call als het bestand volstaat');
});

test('createPlanSection valt na een herstart bij 429 terug op de bewaarde stand', async () => {
  const dir = makeClaudeDir();
  fs.writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'tok-x', subscriptionType: 'max', rateLimitTier: 'max_20x' } })
  );
  const apiResponse = {
    limits: [{ kind: 'session', percent: 34, severity: 'normal', resets_at: '2026-07-13T12:29:59Z', is_active: true, scope: null }],
  };
  const okFetch = async () => ({ ok: true, status: 200, json: async () => apiResponse });
  const getFirst = scanners.createPlanSection(dir, okFetch);
  const first = await getFirst();
  assert.strictEqual(first.data.plan, 'max');
  assert.strictEqual(first.data.staleSince, null);
  // de bewaarde stand mag het token niet bevatten
  const snapPath = path.join(dir, 'dashboard-plan-cache.json');
  const rawSnap = fs.readFileSync(snapPath, 'utf8');
  assert.ok(!rawSnap.includes('tok-x'));
  // simuleer verstreken tijd: de bewaarde stand is ouder dan de verscache
  const snap = JSON.parse(rawSnap);
  const oldAt = Date.now() - 300000;
  fs.writeFileSync(snapPath, JSON.stringify({ ...snap, at: oldAt }));
  // 'herstart': nieuwe instantie, de API geeft nu 429
  const getSecond = scanners.createPlanSection(dir, async () => ({ ok: false, status: 429 }));
  const second = await getSecond();
  assert.ok(!second.error, 'geen kale fout maar de oude stand');
  assert.strictEqual(second.data.plan, 'max');
  assert.strictEqual(second.data.limits[0].percent, 34);
  assert.strictEqual(second.data.staleSince, oldAt);
});

test('createPlanSection zonder eerdere stand geeft de fout en wacht 2 minuten met opnieuw proberen', async () => {
  const dir = makeClaudeDir();
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't' } }));
  let calls = 0;
  const getPlan = scanners.createPlanSection(dir, async () => {
    calls++;
    return { ok: false, status: 429 };
  });
  const out1 = await getPlan();
  assert.match(out1.error, /429/);
  const out2 = await getPlan();
  assert.match(out2.error, /429/);
  assert.strictEqual(calls, 1, 'binnen de backoff geen nieuwe API-call');
});

test('scanRecentFiles collects file_path from Write/Edit tool calls, newest first', () => {
  const dir = makeClaudeDir();
  const projDir = path.join(dir, 'projects', 'C--demo');
  fs.mkdirSync(projDir, { recursive: true });
  const real = path.join(dir, 'bestaat.txt');
  fs.writeFileSync(real, 'x');
  const mk = (tool, file, ts) => JSON.stringify({
    type: 'assistant', timestamp: ts,
    message: { content: [{ type: 'tool_use', name: tool, input: { file_path: file } }] },
  });
  fs.writeFileSync(path.join(projDir, 's1.jsonl'), [
    mk('Write', real, '2026-07-13T10:00:00Z'),
    mk('Read', 'C:\\genegeerd.txt', '2026-07-13T10:00:01Z'),
    mk('Edit', 'C:\\weg.txt', '2026-07-13T10:00:02Z'),
    mk('Write', real, '2026-07-13T10:00:03Z'),
  ].join('\n'));
  const out = scanners.scanRecentFiles(dir, 10);
  assert.strictEqual(out.length, 2, 'alleen unieke Write/Edit-paden');
  assert.strictEqual(out[0].path, real, 'nieuwste eerst (laatste Write wint)');
  assert.strictEqual(out[0].tool, 'Write');
  assert.strictEqual(out[0].exists, true);
  assert.strictEqual(out[1].path, 'C:\\weg.txt');
  assert.strictEqual(out[1].exists, false);
});

test('scanWaiting reports the pending question and options for waiting sessions', () => {
  const dir = makeClaudeDir();
  const projDir = path.join(dir, 'projects', 'C--demo');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'w1.jsonl'), [
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-13T10:00:00Z', message: { content: [{ type: 'text', text: 'Even checken.' }] } }),
    JSON.stringify({
      type: 'assistant', timestamp: '2026-07-13T10:00:05Z',
      message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: {
        questions: [{ question: 'Mergen naar master?', options: [{ label: 'Ja' }, { label: 'Nee' }] }],
      } }] },
    }),
  ].join('\n'));
  const sessions = [
    { sessionId: 'w1', name: 'wachtende-sessie', status: 'waiting' },
    { sessionId: 'x9', name: 'druk', status: 'busy' },
  ];
  const out = scanners.scanWaiting(dir, sessions);
  assert.strictEqual(out.length, 1, 'alleen waiting-sessies');
  assert.strictEqual(out[0].sessionId, 'w1');
  assert.strictEqual(out[0].question, 'Mergen naar master?');
  assert.deepStrictEqual(out[0].options, ['Ja', 'Nee']);
});

test('scanWaiting falls back to the last assistant text when there is no question tool', () => {
  const dir = makeClaudeDir();
  const projDir = path.join(dir, 'projects', 'C--demo');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(
    path.join(projDir, 'w2.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-13T10:00:00Z', message: { content: [{ type: 'text', text: 'Mag ik doorgaan?' }] } })
  );
  const out = scanners.scanWaiting(dir, [{ sessionId: 'w2', name: 's', status: 'waiting' }]);
  assert.strictEqual(out[0].question, 'Mag ik doorgaan?');
  assert.deepStrictEqual(out[0].options, []);
});

test('scanTokenUsage aggregates tokens per project and session with percentages', () => {
  const dir = makeClaudeDir();
  const mkLine = (inTok, outTok, ts) => JSON.stringify({
    type: 'assistant', timestamp: ts || '2026-07-13T10:00:00Z',
    message: { usage: { input_tokens: inTok, output_tokens: outTok, cache_creation_input_tokens: 5, cache_read_input_tokens: 100 } },
  });
  const projA = path.join(dir, 'projects', 'C--proj-a');
  const projB = path.join(dir, 'projects', 'C--proj-b');
  fs.mkdirSync(projA, { recursive: true });
  fs.mkdirSync(projB, { recursive: true });
  fs.writeFileSync(path.join(projA, 's1.jsonl'), [mkLine(10, 50), mkLine(0, 40), 'KAPOT'].join('\n'));
  fs.writeFileSync(path.join(projA, 's2.jsonl'), mkLine(0, 200));
  fs.writeFileSync(path.join(projB, 's3.jsonl'), mkLine(0, 700));

  const titles = { s2: { display: 'grote sessie', timestamp: 1 } };
  const out = scanners.scanTokenUsage(dir, new Map(), titles);

  assert.strictEqual(out.total, 1000, 'input+output geteld, cache niet');
  assert.strictEqual(out.projects[0].dirName, 'C--proj-b', 'grootste project eerst');
  assert.strictEqual(out.projects[0].tokens, 700);
  assert.strictEqual(out.projects[0].pct, 70);
  assert.strictEqual(out.projects[1].tokens, 300);
  const s2 = out.projects[1].sessions.find((s) => s.sessionId === 's2');
  assert.strictEqual(s2.tokens, 200);
  assert.strictEqual(s2.pct, 20);
  assert.strictEqual(s2.title, 'grote sessie');
  assert.strictEqual(out.bySession.s1, 100);
  assert.strictEqual(out.bySession.s3, 700);
});

test('scanTokenUsage reuses cache entries when mtime and size are unchanged', () => {
  const dir = makeClaudeDir();
  const projDir = path.join(dir, 'projects', 'C--p');
  fs.mkdirSync(projDir, { recursive: true });
  const file = path.join(projDir, 's1.jsonl');
  fs.writeFileSync(file, JSON.stringify({
    type: 'assistant', message: { usage: { input_tokens: 0, output_tokens: 10 } },
  }));
  const st = fs.statSync(file);
  const cache = new Map();
  // voorgekookte cache-entry met kloppende mtime/size: parse moet worden overgeslagen
  cache.set(file, {
    mtimeMs: st.mtimeMs, size: st.size,
    totals: { input: 0, output: 999, cacheCreate: 0, cacheRead: 0, byDay: { '2026-07-13': { input: 0, output: 999 } } },
  });
  const out = scanners.scanTokenUsage(dir, cache, {});
  assert.strictEqual(out.total, 999, 'cache-waarde gebruikt in plaats van het bestand te parsen');
});

test('scanTokenUsage filters by sinceDay using per-day buckets', () => {
  const dir = makeClaudeDir();
  const projDir = path.join(dir, 'projects', 'C--p');
  fs.mkdirSync(projDir, { recursive: true });
  const mk = (out, ts) => JSON.stringify({
    type: 'assistant', timestamp: ts,
    message: { usage: { input_tokens: 0, output_tokens: out } },
  });
  fs.writeFileSync(path.join(projDir, 'oud.jsonl'), mk(500, '2026-06-01T09:00:00Z'));
  fs.writeFileSync(path.join(projDir, 'mix.jsonl'), [
    mk(100, '2026-06-01T09:00:00Z'),
    mk(30, '2026-07-12T09:00:00Z'),
    mk(70, '2026-07-13T09:00:00Z'),
  ].join('\n'));

  const all = scanners.scanTokenUsage(dir, new Map(), {});
  assert.strictEqual(all.total, 700);

  const recent = scanners.scanTokenUsage(dir, new Map(), {}, '2026-07-12');
  assert.strictEqual(recent.total, 100, 'alleen 12 en 13 juli tellen mee');
  assert.strictEqual(recent.bySession.mix, 100);
  assert.strictEqual(recent.bySession.oud, 0);
  assert.strictEqual(recent.projects.length, 1);
  assert.strictEqual(recent.projects[0].sessions.length, 1, 'sessies zonder tokens in de periode verdwijnen');
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
