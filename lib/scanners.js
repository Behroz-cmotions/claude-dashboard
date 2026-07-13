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

function scanUsage(claudeDir) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    throw new Error('node:sqlite niet beschikbaar (Node >= 22.5 vereist)');
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
      skills.push({ name: fm.name || name, description: fm.description || '' });
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
  add(cfg.mcpServers, 'globaal');
  for (const [projPath, proj] of Object.entries(cfg.projects || {})) {
    add(proj && proj.mcpServers, projPath);
  }
  return maskSecrets(out);
}

async function scanPlan(claudeDir, fetcher = fetch) {
  const creds = readJsonSafe(path.join(claudeDir, '.credentials.json'));
  const oauth = creds && creds.claudeAiOauth;
  if (!oauth || !oauth.accessToken) throw new Error('geen OAuth-credentials gevonden');
  const res = await fetcher('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: 'Bearer ' + oauth.accessToken,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error('usage-API gaf status ' + res.status);
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
};
