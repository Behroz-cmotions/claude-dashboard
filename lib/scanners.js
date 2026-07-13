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
