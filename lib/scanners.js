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
      path: path.join(dir, file),
    });
  }
  return agents;
}

function scanAgents(claudeDir, projectPaths = []) {
  const agents = scanAgentDir(path.join(claudeDir, 'agents'), 'global');
  for (const p of projectPaths) {
    agents.push(...scanAgentDir(path.join(p, '.claude', 'agents'), p));
  }
  return agents;
}

function flattenHooks(settings, source, sourcePath = '') {
  const out = [];
  if (!settings || !settings.hooks) return out;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((g, gi) => {
      (g.hooks || []).forEach((h, hi) => {
        out.push({
          event,
          matcher: g.matcher || '',
          command: h.command || h.type || '',
          source,
          settingsPath: sourcePath,
          // index-gebaseerd: het commando gaat gemaskeerd naar de browser en
          // is daarom geen betrouwbare sleutel om op te verwijderen
          groupIndex: gi,
          hookIndex: hi,
        });
      });
    });
  }
  return out;
}

function scanHooks(claudeDir, projectPaths = []) {
  const globalPath = path.join(claudeDir, 'settings.json');
  let hooks = flattenHooks(readJsonSafe(globalPath), 'global', globalPath);
  for (const p of projectPaths) {
    for (const f of ['settings.json', 'settings.local.json']) {
      const sp = path.join(p, '.claude', f);
      hooks = hooks.concat(flattenHooks(readJsonSafe(sp), p, sp));
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

function scanUsage(claudeDir) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    throw new Error('node:sqlite not available (Node >= 22.5 required)');
  }
  const empty = { days: [], models: [], tools: [], today: { tokens: 0, turns: 0 } };
  const dbPath = path.join(claudeDir, 'usage.db');
  if (!fs.existsSync(dbPath)) return empty;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // laatste 14 dagen wáárop data bestaat (de db kan achterlopen)
    const days = db.prepare(
      'SELECT * FROM (SELECT date(timestamp) AS day, SUM(input_tokens + output_tokens) AS tokens, COUNT(*) AS turns ' +
      'FROM turns GROUP BY day ORDER BY day DESC LIMIT 14) ORDER BY day'
    ).all();
    const models = db.prepare(
      'SELECT model, SUM(input_tokens + output_tokens) AS tokens, COUNT(*) AS turns ' +
      'FROM turns GROUP BY model ORDER BY tokens DESC'
    ).all();
    const tools = db.prepare(
      "SELECT tool_name AS tool, COUNT(*) AS uses FROM turns " +
      "WHERE tool_name IS NOT NULL AND tool_name != '' " +
      'GROUP BY tool_name ORDER BY uses DESC LIMIT 10'
    ).all();
    const today = db.prepare(
      "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens, COUNT(*) AS turns " +
      "FROM turns WHERE date(timestamp) = date('now')"
    ).get();
    return { days, models, tools, today };
  } finally {
    db.close();
  }
}

function findTranscript(claudeDir, sessionId) {
  const dir = path.join(claudeDir, 'projects');
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir)) {
    const candidate = path.join(dir, entry, sessionId + '.jsonl');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function scanActivity(claudeDir, sessions) {
  const out = [];
  for (const s of sessions) {
    if (!s.sessionId) continue;
    const file = findTranscript(claudeDir, s.sessionId);
    if (!file) continue;
    let lastTool = '';
    let lastText = '';
    let timestamp = '';
    const lines = readTailLines(file, 131072);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.type !== 'assistant' || !line.message || !Array.isArray(line.message.content)) continue;
      for (const item of line.message.content) {
        if (!lastTool && item.type === 'tool_use') {
          lastTool = item.name || '';
          timestamp = timestamp || line.timestamp || '';
        }
        if (!lastText && item.type === 'text' && item.text && item.text.trim()) {
          lastText = item.text.trim().slice(0, 200);
          timestamp = timestamp || line.timestamp || '';
        }
      }
      if (lastTool && lastText) break;
    }
    out.push({
      sessionId: s.sessionId,
      name: s.name,
      status: s.status,
      lastTool,
      lastText,
      timestamp,
    });
  }
  return out;
}

function scanSkills(claudeDir) {
  const skills = [];
  const skillsDir = path.join(claudeDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const name of fs.readdirSync(skillsDir)) {
      // statSync volgt symlinks/junctions (marketplace-skills zijn vaak gelinkt)
      let isDir = false;
      try {
        isDir = fs.statSync(path.join(skillsDir, name)).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      let fm = {};
      try {
        fm = parseFrontmatter(fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8'));
      } catch {
        // geen of onleesbare SKILL.md: alleen de mapnaam tonen
      }
      skills.push({
        name: fm.name || name,
        description: fm.description || '',
        path: path.join(skillsDir, name),
        skillFile: path.join(skillsDir, name, 'SKILL.md'),
      });
    }
  }
  const settings = readJsonSafe(path.join(claudeDir, 'settings.json'));
  const plugins = Object.entries((settings && settings.enabledPlugins) || {}).map(([name, enabled]) => ({
    name,
    enabled: !!enabled,
  }));
  return { skills, plugins };
}

function describeMcpServer(cfg) {
  if (!cfg || typeof cfg !== 'object') return '';
  if (cfg.url) return String(cfg.url);
  const parts = [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])].filter(Boolean);
  return parts.join(' ');
}

function scanMcpServers(homeDir) {
  const cfg = readJsonSafe(path.join(homeDir, '.claude.json'));
  if (!cfg) return [];
  const out = [];
  const add = (servers, scope) => {
    for (const [name, server] of Object.entries(servers || {})) {
      out.push({
        name,
        scope,
        type: (server && server.type) || 'stdio',
        detail: describeMcpServer(server),
      });
    }
  };
  add(cfg.mcpServers, 'global');
  for (const [projPath, proj] of Object.entries(cfg.projects || {})) {
    add(proj && proj.mcpServers, projPath);
  }
  return maskSecrets(out);
}

const EDIT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);

// Recent door Claude geschreven bestanden, uit de Write/Edit-tool-calls in de
// recentste transcripts. file-history is geen bruikbare bron: die slaat
// inhoud-snapshots op onder gehashte namen, zonder het originele pad.
function scanRecentFiles(claudeDir, limit = 20) {
  const dir = path.join(claudeDir, 'projects');
  if (!fs.existsSync(dir)) return [];

  const transcripts = [];
  for (const proj of fs.readdirSync(dir)) {
    const projDir = path.join(dir, proj);
    let files;
    try {
      files = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        transcripts.push({ file: path.join(projDir, f), mtime: fs.statSync(path.join(projDir, f)).mtimeMs });
      } catch {
        // onleesbaar transcript overslaan
      }
    }
  }
  transcripts.sort((a, b) => b.mtime - a.mtime);

  const byPath = new Map();
  for (const t of transcripts.slice(0, 12)) {
    for (const line of readTailLines(t.file, 262144)) {
      if (line.type !== 'assistant' || !line.message || !Array.isArray(line.message.content)) continue;
      for (const item of line.message.content) {
        if (item.type !== 'tool_use' || !EDIT_TOOLS.has(item.name)) continue;
        const filePath = item.input && (item.input.file_path || item.input.notebook_path);
        if (!filePath) continue;
        const at = Date.parse(line.timestamp || '') || 0;
        const prev = byPath.get(filePath);
        if (!prev || at >= prev.at) {
          byPath.set(filePath, { path: filePath, tool: item.name, at });
        }
      }
    }
  }

  return [...byPath.values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((f) => ({ ...f, exists: fs.existsSync(f.path) }));
}

// Sessies die op de gebruiker wachten, met de openstaande vraag uit het transcript.
function scanWaiting(claudeDir, sessions) {
  const out = [];
  for (const s of sessions) {
    if (s.status !== 'waiting' || !s.sessionId) continue;
    const file = findTranscript(claudeDir, s.sessionId);
    let question = '';
    let options = [];
    if (file) {
      const lines = readTailLines(file, 131072);
      for (let i = lines.length - 1; i >= 0 && !question; i--) {
        const line = lines[i];
        if (line.type !== 'assistant' || !line.message || !Array.isArray(line.message.content)) continue;
        for (const item of line.message.content) {
          if (item.type === 'tool_use' && item.name === 'AskUserQuestion') {
            const q = ((item.input && item.input.questions) || [])[0];
            if (q) {
              question = q.question || '';
              options = ((q.options) || []).map((o) => o.label).filter(Boolean);
            }
          } else if (!question && item.type === 'text' && item.text && item.text.trim()) {
            question = item.text.trim().slice(0, 300);
          }
          if (question) break;
        }
      }
    }
    out.push({ sessionId: s.sessionId, name: s.name, pid: s.pid, question, options });
  }
  return out;
}

// Telt input+output-tokens (echte generatie, geen cache-verkeer) uit alle
// assistant-regels van een transcript. Corrupte regels worden overgeslagen.
function parseTranscriptTokens(filePath) {
  const totals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, byDay: {} };
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return totals;
  }
  for (const line of raw.split('\n')) {
    if (!line.includes('"usage"')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type !== 'assistant' || !obj.message || !obj.message.usage) continue;
      const u = obj.message.usage;
      const input = u.input_tokens || 0;
      const output = u.output_tokens || 0;
      totals.input += input;
      totals.output += output;
      totals.cacheCreate += u.cache_creation_input_tokens || 0;
      totals.cacheRead += u.cache_read_input_tokens || 0;
      const day = String(obj.timestamp || '').slice(0, 10) || 'onbekend';
      if (!totals.byDay[day]) totals.byDay[day] = { input: 0, output: 0 };
      totals.byDay[day].input += input;
      totals.byDay[day].output += output;
    } catch {
      // corrupte regel overslaan
    }
  }
  return totals;
}

// Drill-down: tokens per project en per sessie, plus een sessionId→tokens-map.
// De cache (mtime+size per transcript) maakt herhaalde scans goedkoop: alleen
// gewijzigde bestanden worden opnieuw geparset.
function scanTokenUsage(claudeDir, cache = new Map(), titles = {}, sinceDay = null) {
  const dir = path.join(claudeDir, 'projects');
  const empty = { total: 0, projects: [], bySession: {} };
  if (!fs.existsSync(dir)) return empty;

  // zonder filter: alles; met filter: som van de dag-buckets vanaf sinceDay
  const tokensFor = (totals) => {
    if (!sinceDay) return totals.input + totals.output;
    let t = 0;
    for (const [day, v] of Object.entries(totals.byDay || {})) {
      if (day >= sinceDay) t += v.input + v.output;
    }
    return t;
  };

  const projects = [];
  const bySession = {};
  let total = 0;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projDir = path.join(dir, entry.name);
    let files;
    try {
      files = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    let projTokens = 0;
    const sessions = [];
    for (const f of files) {
      const filePath = path.join(projDir, f);
      let st;
      try {
        st = fs.statSync(filePath);
      } catch {
        continue;
      }
      let cached = cache.get(filePath);
      if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
        cached = { mtimeMs: st.mtimeMs, size: st.size, totals: parseTranscriptTokens(filePath) };
        cache.set(filePath, cached);
      }
      const tokens = tokensFor(cached.totals);
      const sessionId = f.replace(/\.jsonl$/, '');
      bySession[sessionId] = tokens;
      if (!tokens) continue;
      projTokens += tokens;
      sessions.push({
        sessionId,
        tokens,
        title: titles[sessionId] ? titles[sessionId].display : '',
        mtime: st.mtimeMs,
      });
    }
    if (!projTokens) continue;
    total += projTokens;
    projects.push({
      dirName: entry.name,
      tokens: projTokens,
      sessions: sessions.sort((a, b) => b.tokens - a.tokens).slice(0, 8),
    });
  }

  const pct = (n) => (total ? Math.round((n / total) * 1000) / 10 : 0);
  for (const p of projects) {
    p.pct = pct(p.tokens);
    for (const s of p.sessions) s.pct = pct(s.tokens);
  }
  return {
    total,
    projects: projects.sort((a, b) => b.tokens - a.tokens).slice(0, 12),
    bySession,
  };
}

async function scanPlan(claudeDir, fetcher = fetch) {
  const creds = readJsonSafe(path.join(claudeDir, '.credentials.json'));
  const oauth = creds && creds.claudeAiOauth;
  if (!oauth || !oauth.accessToken) throw new Error('no OAuth credentials found');
  const res = await fetcher('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: 'Bearer ' + oauth.accessToken,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error('usage API returned status ' + res.status);
  const body = await res.json();
  const limits = (body.limits || []).map((l) => ({
    kind: l.kind,
    percent: l.percent,
    severity: l.severity,
    resetsAt: l.resets_at,
    isActive: !!l.is_active,
    scope: (l.scope && l.scope.model && l.scope.model.display_name) || null,
  }));
  const spend = body.spend && body.spend.enabled
    ? {
        usedMinor: (body.spend.used && body.spend.used.amount_minor) || 0,
        limitMinor: (body.spend.limit && body.spend.limit.amount_minor) || 0,
        percent: body.spend.percent || 0,
        currency: body.spend.currency || (body.spend.used && body.spend.used.currency) || 'EUR',
      }
    : null;
  return {
    plan: oauth.subscriptionType || 'onbekend',
    tier: oauth.rateLimitTier || '',
    limits,
    spend,
  };
}

// Plan-sectie met cache (max 1 API-call per minuut), backoff (2 minuten na een
// fout) en een schijf-snapshot: de laatst gelukte stand — zonder token — staat in
// <claudeDir>/dashboard-plan-cache.json, zodat een 429 direct na een serverherstart
// niet tot een leeg paneel leidt maar tot "stand van X geleden".
const PLAN_CACHE_MS = 60000;
const PLAN_BACKOFF_MS = 120000;
function createPlanSection(claudeDir, fetcher = fetch) {
  const snapPath = path.join(claudeDir, 'dashboard-plan-cache.json');
  const snap = readJsonSafe(snapPath);
  let cache = { at: (snap && snap.at) || 0, data: (snap && snap.data) || null, error: null, errorAt: 0 };
  return async function getPlanSection() {
    const now = Date.now();
    const fresh = now - cache.at < PLAN_CACHE_MS && cache.data;
    const backingOff = cache.error && now - cache.errorAt < PLAN_BACKOFF_MS;
    if (!fresh && !backingOff) {
      try {
        cache = { at: Date.now(), data: await scanPlan(claudeDir, fetcher), error: null, errorAt: 0 };
        try {
          fs.writeFileSync(snapPath, JSON.stringify({ at: cache.at, data: cache.data }));
        } catch {
          // een schijffout mag het paneel niet breken
        }
      } catch (err) {
        cache.error = String((err && err.message) || err);
        cache.errorAt = Date.now();
      }
    }
    if (cache.data) {
      return { data: { ...cache.data, staleSince: cache.error ? cache.at : null } };
    }
    return { error: cache.error || 'plan not fetched yet' };
  };
}

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
  scanUsage,
  scanActivity,
  scanSkills,
  scanMcpServers,
  scanPlan,
  createPlanSection,
  scanRecentFiles,
  scanWaiting,
  scanTokenUsage,
};
