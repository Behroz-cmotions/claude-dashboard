# Agentic OS Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Een lokale, read-only webapp die de volledige Claude Code-omgeving toont (sessies, projecten, runs, tasks, agents, hooks, loops, recente prompts) door `~/.claude` te scannen.

**Architecture:** Eén Node HTTP-server (zero dependencies) met geïsoleerde scanner-functies per databron; één statische HTML-pagina met inline CSS/JS die elke 3 seconden `GET /api/state` pollt. Geen cache, geen database — elke poll scant vers.

**Tech Stack:** Node.js built-ins (`http`, `fs`, `path`, `os`), Node's ingebouwde testrunner (`node --test`), vanilla HTML/CSS/JS.

## Global Constraints

- Zero npm-dependencies: alleen Node built-in modules; geen `package.json`-dependencies, geen build-stap.
- Server bindt uitsluitend op `127.0.0.1`, poort `4545` (overridebaar via env `PORT`).
- Claude-datamap: `os.homedir() + '/.claude'`, overridebaar via env `CLAUDE_DIR` (nodig voor tests).
- Read-only: de server schrijft nooit iets naar `~/.claude` of de projecten.
- Secrets worden gemaskeerd vóór verzending: waarden onder keys die matchen op `/key|token|secret|password|credential/i` en strings die matchen op `sk-…`/`ghp_…`/`xox…`-patronen worden `••••`.
- Eén kapotte databron mag nooit de hele `/api/state`-response breken: elk paneel is `{ data }` of `{ error }`.
- Tests draaien met `node --test test/` en gebruiken tijdelijke fixture-mappen (`fs.mkdtempSync`), nooit de echte `~/.claude`.

## File Structure

```
server.js               HTTP-server, state-assemblage, routes
lib/utils.js            readJsonSafe, readJsonlLines, readTailLines, maskSecrets
lib/scanners.js         scanSessions, scanProjects, scanTasks, scanAgents,
                        scanHooks, scanLoops, scanHistory, buildSessionTitles,
                        parseFrontmatter, flattenHooks
public/index.html       Dashboard-UI (één bestand, inline CSS/JS)
test/utils.test.js      Tests voor utils
test/scanners.test.js   Tests voor scanners (met fixtures in tmpdir)
```

---

### Task 1: Utils — veilig lezen en secrets maskeren

**Files:**
- Create: `lib/utils.js`
- Test: `test/utils.test.js`

**Interfaces:**
- Produces:
  - `readJsonSafe(filePath: string): object|null` — geparste JSON of `null` bij fout.
  - `readJsonlLines(filePath: string, opts?: {tail?: number}): object[]` — alle (of laatste `tail`) geldige JSONL-regels; corrupte regels overgeslagen; `[]` bij ontbrekend bestand.
  - `readTailLines(filePath: string, maxBytes?: number): object[]` — leest alleen de laatste `maxBytes` (default 65536) van het bestand en parset complete JSONL-regels (eerste, mogelijk afgekapte regel wordt gedropt als er vóór het leespunt nog data was).
  - `maskSecrets(value: any, keyHint?: string): any` — recursief; stringwaarden onder secret-achtige keys worden `'••••'`, en secret-patronen ín strings worden vervangen door `'••••'`.

- [ ] **Step 1: Write the failing tests**

```js
// test/utils.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJsonSafe, readJsonlLines, readTailLines, maskSecrets } = require('../lib/utils');

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-utils-'));
  const file = path.join(dir, 'f.jsonl');
  fs.writeFileSync(file, content);
  return file;
}

test('readJsonSafe returns null on missing or corrupt file', () => {
  assert.strictEqual(readJsonSafe(path.join(os.tmpdir(), 'bestaat-niet.json')), null);
  assert.strictEqual(readJsonSafe(tmpFile('{niet json')), null);
});

test('readJsonSafe parses valid json', () => {
  assert.deepStrictEqual(readJsonSafe(tmpFile('{"a":1}')), { a: 1 });
});

test('readJsonlLines skips corrupt lines and supports tail', () => {
  const file = tmpFile('{"n":1}\nKAPOT\n{"n":2}\n{"n":3}\n');
  assert.deepStrictEqual(readJsonlLines(file), [{ n: 1 }, { n: 2 }, { n: 3 }]);
  assert.deepStrictEqual(readJsonlLines(file, { tail: 2 }), [{ n: 2 }, { n: 3 }]);
  assert.deepStrictEqual(readJsonlLines(path.join(os.tmpdir(), 'weg.jsonl')), []);
});

test('readTailLines reads only the tail and drops partial first line', () => {
  const lines = [];
  for (let i = 0; i < 100; i++) lines.push(JSON.stringify({ i }));
  const file = tmpFile(lines.join('\n') + '\n');
  const out = readTailLines(file, 100); // klein venster: eerste regel is afgekapt
  assert.ok(out.length > 0);
  assert.strictEqual(out[out.length - 1].i, 99);
  assert.ok(out.every((o) => typeof o.i === 'number'));
});

test('maskSecrets masks secret-named keys and secret patterns in strings', () => {
  const input = {
    env: { DASHSCOPE_API_KEY: 'sk-abc123def456ghij', NORMAL: 'ok' },
    command: 'run --token sk-abc123def456ghij now',
    nested: [{ password: 'hunter2' }],
  };
  const out = maskSecrets(input);
  assert.strictEqual(out.env.DASHSCOPE_API_KEY, '••••');
  assert.strictEqual(out.env.NORMAL, 'ok');
  assert.strictEqual(out.command, 'run --token •••• now');
  assert.strictEqual(out.nested[0].password, '••••');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/`
Expected: FAIL — `Cannot find module '../lib/utils'`

- [ ] **Step 3: Write the implementation**

```js
// lib/utils.js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/`
Expected: alle tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/utils.js test/utils.test.js
git commit -m "feat: utils voor veilig JSON/JSONL lezen en secrets maskeren"
```

---

### Task 2: Sessie-scanner — actieve sessies en open terminals

**Files:**
- Create: `lib/scanners.js`
- Test: `test/scanners.test.js`

**Interfaces:**
- Consumes: `readJsonSafe` uit `lib/utils.js`.
- Produces:
  - `scanSessions(claudeDir: string, isAlive?: (pid:number)=>boolean): Array<{pid, sessionId, name, cwd, status, kind, version, startedAt, updatedAt}>` — alleen sessies waarvan de PID leeft, nieuwste eerst.
  - `isPidAlive(pid: number): boolean` — default-implementatie via `process.kill(pid, 0)`.

- [ ] **Step 1: Write the failing test**

```js
// test/scanners.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/`
Expected: FAIL — `Cannot find module '../lib/scanners'`

- [ ] **Step 3: Write the implementation**

```js
// lib/scanners.js
const fs = require('fs');
const path = require('path');
const { readJsonSafe, readJsonlLines, readTailLines, maskSecrets } = require('./utils');

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // proces bestaat, maar is van een ander
  }
}

function scanSessions(claudeDir, isAlive = isPidAlive) {
  const dir = path.join(claudeDir, 'sessions');
  if (!fs.existsSync(dir)) return [];
  const sessions = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const s = readJsonSafe(path.join(dir, file));
    if (!s || !s.pid || !isAlive(s.pid)) continue;
    sessions.push({
      pid: s.pid,
      sessionId: s.sessionId,
      name: s.name,
      cwd: s.cwd,
      status: s.status,
      kind: s.kind,
      version: s.version,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
    });
  }
  return sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

module.exports = { isPidAlive, scanSessions };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/`
Expected: alle tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/scanners.js test/scanners.test.js
git commit -m "feat: sessie-scanner met PID-alive-check"
```

---

### Task 3: Project- en runs-scanner met sessietitels

**Files:**
- Modify: `lib/scanners.js` (functies toevoegen, module.exports uitbreiden)
- Test: `test/scanners.test.js` (tests toevoegen)

**Interfaces:**
- Consumes: `readJsonlLines`, `readTailLines` uit `lib/utils.js`.
- Produces:
  - `buildSessionTitles(claudeDir: string): Record<sessionId, {display: string, timestamp: number}>` — eerste (oudste) prompt per sessie uit `history.jsonl`.
  - `scanProjects(claudeDir: string, titles?: Record<string,{display,timestamp}>): Array<{dirName, path, sessionCount, lastActivity, sessions: Array<{sessionId, title, mtime, size}>}>` — nieuwste activiteit eerst; `path` komt uit het `cwd`-veld van het recentste transcript, fallback is `dirName`.

- [ ] **Step 1: Write the failing tests** (toevoegen aan `test/scanners.test.js`)

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/`
Expected: FAIL — `scanners.buildSessionTitles is not a function`

- [ ] **Step 3: Write the implementation** (toevoegen aan `lib/scanners.js`, exports uitbreiden)

```js
function buildSessionTitles(claudeDir) {
  const entries = readJsonlLines(path.join(claudeDir, 'history.jsonl'));
  const titles = {};
  for (const e of entries) {
    if (!e.sessionId || !e.display) continue;
    if (!titles[e.sessionId] || e.timestamp < titles[e.sessionId].timestamp) {
      titles[e.sessionId] = { display: e.display, timestamp: e.timestamp };
    }
  }
  return titles;
}

function scanProjects(claudeDir, titles = {}) {
  const dir = path.join(claudeDir, 'projects');
  if (!fs.existsSync(dir)) return [];
  const projects = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projDir = path.join(dir, entry.name);
    let files;
    try {
      files = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    let lastActivity = 0;
    let newest = null;
    const sessions = [];
    for (const f of files) {
      let st;
      try {
        st = fs.statSync(path.join(projDir, f));
      } catch {
        continue;
      }
      if (st.mtimeMs > lastActivity) {
        lastActivity = st.mtimeMs;
        newest = f;
      }
      const sessionId = f.replace(/\.jsonl$/, '');
      sessions.push({
        sessionId,
        title: titles[sessionId] ? titles[sessionId].display : '',
        mtime: st.mtimeMs,
        size: st.size,
      });
    }
    let realPath = null;
    if (newest) {
      for (const line of readTailLines(path.join(projDir, newest))) {
        if (line.cwd) {
          realPath = line.cwd;
          break;
        }
      }
    }
    projects.push({
      dirName: entry.name,
      path: realPath || entry.name,
      sessionCount: sessions.length,
      lastActivity,
      sessions: sessions.sort((a, b) => b.mtime - a.mtime).slice(0, 15),
    });
  }
  return projects.sort((a, b) => b.lastActivity - a.lastActivity);
}
```

En breid de exports uit:

```js
module.exports = { isPidAlive, scanSessions, buildSessionTitles, scanProjects };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/`
Expected: alle tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/scanners.js test/scanners.test.js
git commit -m "feat: project- en runs-scanner met sessietitels uit history"
```

---

### Task 4: Overige scanners — tasks, agents, hooks, loops, history

**Files:**
- Modify: `lib/scanners.js` (functies toevoegen, module.exports uitbreiden)
- Test: `test/scanners.test.js` (tests toevoegen)

**Interfaces:**
- Consumes: `readJsonSafe`, `readTailLines`, `maskSecrets` uit `lib/utils.js`.
- Produces:
  - `scanTasks(claudeDir): Array<{id, fileCount, lastActivity, linkedSession}>`
  - `parseFrontmatter(content: string): Record<string,string>`
  - `scanAgents(claudeDir, projectPaths: string[]): Array<{name, description, tools, scope}>` — scope is `'globaal'` of het projectpad.
  - `flattenHooks(settings: object|null, source: string): Array<{event, matcher, command, source}>`
  - `scanHooks(claudeDir, projectPaths: string[]): Array<{event, matcher, command, source}>` — gemaskeerd via `maskSecrets`.
  - `scanLoops(claudeDir): Array<{name, path}>` — bestanden/mappen in de root van `claudeDir` die matchen op `/cron|schedule|routine|loop/i`.
  - `scanHistory(claudeDir, limit?: number): Array<{display, project, timestamp, sessionId}>` — nieuwste eerst, default 20.

- [ ] **Step 1: Write the failing tests** (toevoegen aan `test/scanners.test.js`)

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/`
Expected: FAIL — `scanners.scanTasks is not a function`

- [ ] **Step 3: Write the implementation** (toevoegen aan `lib/scanners.js`)

```js
function scanTasks(claudeDir) {
  const dir = path.join(claudeDir, 'tasks');
  if (!fs.existsSync(dir)) return [];
  const tasks = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const taskDir = path.join(dir, entry.name);
    let files = [];
    let mtime = 0;
    try {
      files = fs.readdirSync(taskDir);
      mtime = fs.statSync(taskDir).mtimeMs;
    } catch {
      continue;
    }
    tasks.push({
      id: entry.name,
      fileCount: files.length,
      lastActivity: mtime,
      linkedSession: entry.name.startsWith('session-') ? entry.name.slice(8) : null,
    });
  }
  return tasks.sort((a, b) => b.lastActivity - a.lastActivity);
}

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  let currentKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      out[currentKey] = kv[2].trim();
    } else if (currentKey && line.trim()) {
      out[currentKey] = (out[currentKey] + ' ' + line.trim()).trim();
    }
  }
  return out;
}

function scanAgentDir(dir, scope) {
  if (!fs.existsSync(dir)) return [];
  const agents = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    let fm = {};
    try {
      fm = parseFrontmatter(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    agents.push({
      name: fm.name || file.replace(/\.md$/, ''),
      description: fm.description || '',
      tools: fm.tools || '',
      scope,
    });
  }
  return agents;
}

function scanAgents(claudeDir, projectPaths = []) {
  const agents = scanAgentDir(path.join(claudeDir, 'agents'), 'globaal');
  for (const p of projectPaths) {
    agents.push(...scanAgentDir(path.join(p, '.claude', 'agents'), p));
  }
  return agents;
}

function flattenHooks(settings, source) {
  const out = [];
  if (!settings || !settings.hooks) return out;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      for (const h of g.hooks || []) {
        out.push({ event, matcher: g.matcher || '', command: h.command || h.type || '', source });
      }
    }
  }
  return out;
}

function scanHooks(claudeDir, projectPaths = []) {
  let hooks = flattenHooks(readJsonSafe(path.join(claudeDir, 'settings.json')), 'globaal');
  for (const p of projectPaths) {
    for (const f of ['settings.json', 'settings.local.json']) {
      hooks = hooks.concat(flattenHooks(readJsonSafe(path.join(p, '.claude', f)), p));
    }
  }
  return maskSecrets(hooks);
}

function scanLoops(claudeDir) {
  let names = [];
  try {
    names = fs.readdirSync(claudeDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /cron|schedule|routine|loop/i.test(n))
    .map((n) => ({ name: n, path: path.join(claudeDir, n) }));
}

function scanHistory(claudeDir, limit = 20) {
  const entries = readTailLines(path.join(claudeDir, 'history.jsonl'), 262144);
  return entries
    .slice(-limit)
    .reverse()
    .map((e) => ({
      display: e.display,
      project: e.project,
      timestamp: e.timestamp,
      sessionId: e.sessionId,
    }));
}
```

En breid de exports uit:

```js
module.exports = {
  isPidAlive,
  scanSessions,
  buildSessionTitles,
  scanProjects,
  scanTasks,
  parseFrontmatter,
  scanAgents,
  flattenHooks,
  scanHooks,
  scanLoops,
  scanHistory,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/`
Expected: alle tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/scanners.js test/scanners.test.js
git commit -m "feat: scanners voor tasks, agents, hooks, loops en history"
```

---

### Task 5: HTTP-server met /api/state

**Files:**
- Create: `server.js`

**Interfaces:**
- Consumes: alle scanner-functies uit `lib/scanners.js`.
- Produces: `GET /api/state` → JSON `{ sessions, projects, tasks, agents, hooks, loops, history, runningAgents, generatedAt }` waarbij elk paneel `{ data: … }` of `{ error: "…" }` is. `GET /` → `public/index.html`.

- [ ] **Step 1: Write the implementation**

(Geen unit-test: dit is dunne wiring; verificatie gebeurt handmatig in Step 2, conform de spec.)

```js
// server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const scanners = require('./lib/scanners');

const CLAUDE_DIR = process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude');
const PORT = Number(process.env.PORT) || 4545;

function buildState() {
  const state = {};
  const wrap = (name, fn) => {
    try {
      state[name] = { data: fn() };
    } catch (err) {
      state[name] = { error: String((err && err.message) || err) };
    }
  };
  wrap('sessions', () => scanners.scanSessions(CLAUDE_DIR));
  wrap('projects', () => {
    const titles = scanners.buildSessionTitles(CLAUDE_DIR);
    return scanners.scanProjects(CLAUDE_DIR, titles);
  });
  const projectPaths = ((state.projects && state.projects.data) || [])
    .map((p) => p.path)
    .filter((p) => p && p !== p.replace(/[\\/]/g, '') && fs.existsSync(p));
  wrap('tasks', () => scanners.scanTasks(CLAUDE_DIR));
  wrap('agents', () => scanners.scanAgents(CLAUDE_DIR, projectPaths));
  wrap('hooks', () => scanners.scanHooks(CLAUDE_DIR, projectPaths));
  wrap('loops', () => scanners.scanLoops(CLAUDE_DIR));
  wrap('history', () => scanners.scanHistory(CLAUDE_DIR));
  wrap('runningAgents', () =>
    ((state.sessions && state.sessions.data) || []).filter((s) => s.kind && s.kind !== 'interactive')
  );
  state.generatedAt = Date.now();
  return state;
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/api/state') {
    let body;
    try {
      body = JSON.stringify(buildState());
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String((err && err.message) || err) }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  } else if (url === '/' || url === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end('index.html ontbreekt');
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Agentic OS Dashboard draait op http://localhost:${PORT}`);
});
```

Let op: de `projectPaths`-filter checkt `fs.existsSync` en sluit fallback-`dirName`-waarden (zonder pad-separators) uit, zodat we geen niet-bestaande paden scannen.

- [ ] **Step 2: Manual verify**

Maak eerst een lege placeholder zodat `/` niet 500't: `public/index.html` met inhoud `<h1>placeholder</h1>`.

Run (achtergrond): `node server.js`
Daarna: `curl http://localhost:4545/api/state` (of `Invoke-RestMethod http://localhost:4545/api/state`)
Expected: JSON met keys `sessions`, `projects`, `tasks`, `agents`, `hooks`, `loops`, `history`, `runningAgents`, `generatedAt`; `sessions.data` bevat de huidige Claude Code-sessie(s); geen leesbare API-keys in de output (zoek op `sk-`).

- [ ] **Step 3: Commit**

```bash
git add server.js public/index.html
git commit -m "feat: HTTP-server met /api/state"
```

---

### Task 6: Dashboard-frontend

**Files:**
- Modify: `public/index.html` (placeholder vervangen door volledige UI)

**Interfaces:**
- Consumes: `GET /api/state` JSON-structuur uit Task 5.

- [ ] **Step 1: Write the implementation**

Volledige inhoud van `public/index.html`:

```html
<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agentic OS</title>
<style>
  :root {
    --bg: #0b0e14; --panel: #131722; --panel-border: #1f2533;
    --text: #d7dce5; --muted: #7d8698; --accent: #7aa2f7;
    --ok: #9ece6a; --warn: #e0af68; --err: #f7768e; --idle: #565f89;
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    background: var(--bg); color: var(--text);
    font: 14px/1.5 "Segoe UI", system-ui, sans-serif;
    padding: 20px; min-height: 100vh;
  }
  header { display: flex; align-items: baseline; gap: 14px; margin-bottom: 18px; }
  header h1 { font-size: 20px; font-weight: 600; letter-spacing: 0.5px; }
  header h1 span { color: var(--accent); }
  #conn { font-size: 12px; color: var(--muted); }
  #conn.lost { color: var(--err); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 14px; }
  .panel {
    background: var(--panel); border: 1px solid var(--panel-border);
    border-radius: 10px; padding: 14px 16px; overflow: hidden;
  }
  .panel h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: 1px;
    color: var(--muted); margin-bottom: 10px; display: flex; justify-content: space-between;
  }
  .panel h2 .count { color: var(--accent); }
  .panel.wide { grid-column: 1 / -1; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--muted); font-weight: 500; padding: 3px 8px 3px 0; }
  td { padding: 3px 8px 3px 0; border-top: 1px solid var(--panel-border); vertical-align: top; }
  td.mono, .mono { font-family: Consolas, monospace; font-size: 12px; }
  .muted { color: var(--muted); }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .dot.running { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
  .dot.idle { background: var(--idle); }
  .dot.other { background: var(--warn); }
  .badge {
    display: inline-block; padding: 1px 8px; border-radius: 10px;
    font-size: 11px; background: #1e2436; color: var(--accent);
  }
  .empty, .error { color: var(--muted); font-style: italic; padding: 6px 0; }
  .error { color: var(--err); }
  .ellipsis { max-width: 340px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  details summary { cursor: pointer; color: var(--accent); font-size: 13px; padding: 4px 0; list-style: none; }
  details summary::before { content: "▸ "; }
  details[open] summary::before { content: "▾ "; }
  details table { margin: 4px 0 8px 14px; width: calc(100% - 14px); }
</style>
</head>
<body>
<header>
  <h1>Agentic <span>OS</span></h1>
  <div id="conn">verbinden…</div>
</header>
<div class="grid">
  <div class="panel" id="p-sessions"><h2>Actieve sessies &amp; terminals <span class="count"></span></h2><div class="body"></div></div>
  <div class="panel" id="p-running-agents"><h2>Running agents <span class="count"></span></h2><div class="body"></div></div>
  <div class="panel" id="p-tasks"><h2>Background tasks <span class="count"></span></h2><div class="body"></div></div>
  <div class="panel" id="p-agents"><h2>Agents <span class="count"></span></h2><div class="body"></div></div>
  <div class="panel" id="p-hooks"><h2>Hooks <span class="count"></span></h2><div class="body"></div></div>
  <div class="panel" id="p-loops"><h2>Loops &amp; scheduled <span class="count"></span></h2><div class="body"></div></div>
  <div class="panel wide" id="p-projects"><h2>Projecten &amp; sessies <span class="count"></span></h2><div class="body"></div></div>
  <div class="panel wide" id="p-history"><h2>Recente prompts <span class="count"></span></h2><div class="body"></div></div>
</div>
<script>
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function ago(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60e3) return Math.round(d / 1e3) + 's geleden';
  if (d < 3600e3) return Math.round(d / 60e3) + 'm geleden';
  if (d < 86400e3) return Math.round(d / 3600e3) + 'u geleden';
  return Math.round(d / 86400e3) + 'd geleden';
}

function panel(id, section, render) {
  const el = document.querySelector(id);
  const body = el.querySelector('.body');
  const count = el.querySelector('.count');
  if (!section) { body.innerHTML = '<div class="empty">geen data</div>'; return; }
  if (section.error) { body.innerHTML = '<div class="error">fout: ' + esc(section.error) + '</div>'; count.textContent = ''; return; }
  const data = section.data || [];
  count.textContent = data.length || '';
  body.innerHTML = data.length ? render(data) : '<div class="empty">geen items</div>';
}

function dotFor(status) {
  if (status === 'running') return '<span class="dot running"></span>';
  if (status === 'idle') return '<span class="dot idle"></span>';
  return '<span class="dot other"></span>';
}

function renderSessions(data) {
  return '<table><tr><th></th><th>Naam</th><th>Map</th><th>Status</th><th>Actief</th></tr>' +
    data.map((s) =>
      '<tr><td>' + dotFor(s.status) + '</td><td>' + esc(s.name) +
      ' <span class="muted mono">pid ' + esc(s.pid) + '</span></td>' +
      '<td class="mono ellipsis" title="' + esc(s.cwd) + '">' + esc(s.cwd) + '</td>' +
      '<td>' + esc(s.status) + '</td><td class="muted">' + ago(s.updatedAt) + '</td></tr>'
    ).join('') + '</table>';
}

function renderRunningAgents(data) {
  return '<table><tr><th>Naam</th><th>Soort</th><th>Actief</th></tr>' +
    data.map((s) =>
      '<tr><td>' + dotFor(s.status) + esc(s.name) + '</td><td><span class="badge">' + esc(s.kind) + '</span></td>' +
      '<td class="muted">' + ago(s.updatedAt) + '</td></tr>'
    ).join('') + '</table>';
}

function renderTasks(data) {
  return '<table><tr><th>Taak</th><th>Sessie</th><th>Activiteit</th></tr>' +
    data.map((t) =>
      '<tr><td class="mono">' + esc(t.id) + '</td>' +
      '<td class="mono muted">' + esc(t.linkedSession || '—') + '</td>' +
      '<td class="muted">' + ago(t.lastActivity) + '</td></tr>'
    ).join('') + '</table>';
}

function renderAgents(data) {
  return '<table><tr><th>Naam</th><th>Scope</th></tr>' +
    data.map((a) =>
      '<tr><td><b>' + esc(a.name) + '</b><div class="muted ellipsis" title="' + esc(a.description) + '">' +
      esc(a.description) + '</div></td>' +
      '<td><span class="badge">' + esc(a.scope === 'globaal' ? 'globaal' : 'project') + '</span></td></tr>'
    ).join('') + '</table>';
}

function renderHooks(data) {
  return '<table><tr><th>Event</th><th>Commando</th><th>Bron</th></tr>' +
    data.map((h) =>
      '<tr><td><span class="badge">' + esc(h.event) + (h.matcher ? ' · ' + esc(h.matcher) : '') + '</span></td>' +
      '<td class="mono ellipsis" title="' + esc(h.command) + '">' + esc(h.command) + '</td>' +
      '<td><span class="muted">' + esc(h.source === 'globaal' ? 'globaal' : 'project') + '</span></td></tr>'
    ).join('') + '</table>';
}

function renderLoops(data) {
  return '<table><tr><th>Naam</th><th>Pad</th></tr>' +
    data.map((l) =>
      '<tr><td>' + esc(l.name) + '</td><td class="mono muted">' + esc(l.path) + '</td></tr>'
    ).join('') + '</table>';
}

function renderProjects(data) {
  return data.map((p) =>
    '<details' + (data.indexOf(p) === 0 ? ' open' : '') + '><summary>' + esc(p.path) +
    ' <span class="muted">· ' + p.sessionCount + ' sessies · ' + ago(p.lastActivity) + '</span></summary>' +
    '<table><tr><th>Sessie</th><th>Titel</th><th>Laatste activiteit</th><th>Grootte</th></tr>' +
    p.sessions.map((s) =>
      '<tr><td class="mono muted">' + esc(s.sessionId.slice(0, 8)) + '</td>' +
      '<td class="ellipsis" title="' + esc(s.title) + '">' + esc(s.title || '—') + '</td>' +
      '<td class="muted">' + ago(s.mtime) + '</td>' +
      '<td class="muted">' + Math.round(s.size / 1024) + ' kB</td></tr>'
    ).join('') + '</table></details>'
  ).join('');
}

function renderHistory(data) {
  return '<table><tr><th>Wanneer</th><th>Project</th><th>Prompt</th></tr>' +
    data.map((h) =>
      '<tr><td class="muted" style="white-space:nowrap">' + ago(h.timestamp) + '</td>' +
      '<td class="mono muted ellipsis" title="' + esc(h.project) + '">' + esc((h.project || '').split('\\').pop()) + '</td>' +
      '<td class="ellipsis" style="max-width:600px" title="' + esc(h.display) + '">' + esc(h.display) + '</td></tr>'
    ).join('') + '</table>';
}

async function refresh() {
  const conn = document.getElementById('conn');
  try {
    const res = await fetch('/api/state');
    const state = await res.json();
    conn.textContent = 'live · ' + new Date(state.generatedAt).toLocaleTimeString('nl-NL');
    conn.classList.remove('lost');
    panel('#p-sessions', state.sessions, renderSessions);
    panel('#p-running-agents', state.runningAgents, renderRunningAgents);
    panel('#p-tasks', state.tasks, renderTasks);
    panel('#p-agents', state.agents, renderAgents);
    panel('#p-hooks', state.hooks, renderHooks);
    panel('#p-loops', state.loops, renderLoops);
    panel('#p-projects', state.projects, renderProjects);
    panel('#p-history', state.history, renderHistory);
  } catch {
    conn.textContent = 'verbinding kwijt — opnieuw proberen…';
    conn.classList.add('lost');
  }
}

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>
```

- [ ] **Step 2: Run all tests**

Run: `node --test test/`
Expected: alle tests PASS

- [ ] **Step 3: Manual end-to-end verify**

1. Start: `node server.js`
2. Open `http://localhost:4545` in de browser.
3. Controleer: alle acht panelen renderen; "Actieve sessies" toont de huidige Claude Code-sessie(s) met status; "Agents" toont minstens `docs-agent` (globaal); "Hooks" toont de `Stop`-hook; "Recente prompts" toont echte history; geen zichtbare API-keys (zoek in de pagina op `sk-`).
4. Controleer live update: de tijd achter "live ·" verspringt elke ~3 s.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: dashboard-frontend met live polling"
```

---

## Verificatie tegen de spec

- Actieve sessies/terminals → Task 2 + 5 + 6 ✓
- Projecten + sessies/runs met titels → Task 3 + 6 ✓
- Background tasks → Task 4 + 6 ✓
- Agents (bestaand, globaal + project) → Task 4 + 6 ✓
- Running agents → Task 5 (`runningAgents` afgeleid van non-interactive sessies) + 6 ✓
- Hooks (globaal + project, gemaskeerd) → Task 4 + 6 ✓
- Loops & scheduled (best-effort) → Task 4 + 6 ✓
- Recente prompts → Task 4 + 6 ✓
- Alleen 127.0.0.1, read-only, foutisolatie per paneel, secrets gemaskeerd → Global Constraints + Task 5 ✓
