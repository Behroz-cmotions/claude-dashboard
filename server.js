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
  // alleen echte, bestaande paden meenemen (geen dirName-fallbacks zonder separator)
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
  wrap('usage', () => scanners.scanUsage(CLAUDE_DIR));
  wrap('activity', () => scanners.scanActivity(CLAUDE_DIR, (state.sessions && state.sessions.data) || []));
  wrap('skills', () => scanners.scanSkills(CLAUDE_DIR));
  wrap('mcpServers', () => scanners.scanMcpServers(path.dirname(CLAUDE_DIR)));
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
