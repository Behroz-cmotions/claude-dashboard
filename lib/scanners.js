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

module.exports = { isPidAlive, scanSessions, buildSessionTitles, scanProjects };
