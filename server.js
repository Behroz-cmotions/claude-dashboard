const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const scanners = require('./lib/scanners');
const actions = require('./lib/actions');

const CLAUDE_DIR = process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude');
const PORT = Number(process.env.PORT) || 4545;

// Muterende routes vereisen dit token in de header X-Dashboard-Token. Een custom
// header dwingt een CORS-preflight af die we niet beantwoorden, dus geen enkele
// website die de gebruiker bezoekt kan acties op dit dashboard uitvoeren.
const ACTION_TOKEN = crypto.randomUUID();

// Wat het dashboard mag lezen/schrijven/verwijderen. Wordt per request opnieuw
// bepaald: ~/.claude plus de bekende projectmappen.
function allowedRoots() {
  const roots = [CLAUDE_DIR];
  const titles = scanners.buildSessionTitles(CLAUDE_DIR);
  for (const p of scanners.scanProjects(CLAUDE_DIR, titles)) {
    if (p.path && p.path !== p.path.replace(/[\\/]/g, '') && fs.existsSync(p.path)) roots.push(p.path);
  }
  return roots;
}

// plan/limieten: max 1 API-call per minuut, token blijft server-side.
// Bij een fout (bijv. rate limit) blijft de laatst bekende stand staan, gemarkeerd
// als verouderd — beter een cijfer van een minuut oud dan een leeg paneel.
const PLAN_CACHE_MS = 60000;
const PLAN_BACKOFF_MS = 120000;
let planCache = { at: 0, data: null, error: null, errorAt: 0 };
async function getPlanSection() {
  const now = Date.now();
  const fresh = now - planCache.at < PLAN_CACHE_MS && planCache.data;
  const backingOff = planCache.error && now - planCache.errorAt < PLAN_BACKOFF_MS;
  if (!fresh && !backingOff) {
    try {
      planCache = { at: Date.now(), data: await scanners.scanPlan(CLAUDE_DIR), error: null, errorAt: 0 };
    } catch (err) {
      planCache.error = String((err && err.message) || err);
      planCache.errorAt = Date.now();
    }
  }
  if (planCache.data) {
    return { data: { ...planCache.data, staleSince: planCache.error ? planCache.at : null } };
  }
  return { error: planCache.error || 'plan nog niet opgehaald' };
}

// per-transcript tokencache: alleen gewijzigde bestanden worden opnieuw geparset
const tokenCache = new Map();

// 'day' = vandaag, 'week' = laatste 7 dagen, 'month' = laatste 30 dagen (dag-granulariteit, UTC)
function sinceDayFor(period) {
  const daysBack = { day: 0, week: 6, month: 29 }[period];
  if (daysBack == null) return null;
  return new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);
}

async function buildState(period) {
  const state = {};
  const wrap = (name, fn) => {
    try {
      state[name] = { data: fn() };
    } catch (err) {
      state[name] = { error: String((err && err.message) || err) };
    }
  };
  let titles = {};
  try {
    titles = scanners.buildSessionTitles(CLAUDE_DIR);
  } catch {
    // zonder titels verder
  }
  wrap('sessions', () => scanners.scanSessions(CLAUDE_DIR));
  wrap('projects', () => scanners.scanProjects(CLAUDE_DIR, titles));
  // alleen echte, bestaande paden meenemen (geen dirName-fallbacks zonder separator)
  const projectPaths = ((state.projects && state.projects.data) || [])
    .map((p) => p.path)
    .filter((p) => p && p !== p.replace(/[\\/]/g, '') && fs.existsSync(p));
  const sessions = (state.sessions && state.sessions.data) || [];
  wrap('tasks', () => scanners.scanTasks(CLAUDE_DIR));
  wrap('agents', () => scanners.scanAgents(CLAUDE_DIR, projectPaths));
  wrap('hooks', () => scanners.scanHooks(CLAUDE_DIR, projectPaths));
  wrap('loops', () => scanners.scanLoops(CLAUDE_DIR));
  wrap('history', () => scanners.scanHistory(CLAUDE_DIR));
  wrap('runningAgents', () => sessions.filter((s) => s.kind && s.kind !== 'interactive'));
  wrap('usage', () => scanners.scanUsage(CLAUDE_DIR));
  wrap('activity', () => scanners.scanActivity(CLAUDE_DIR, sessions));
  wrap('waiting', () => scanners.scanWaiting(CLAUDE_DIR, sessions));
  wrap('skills', () => scanners.scanSkills(CLAUDE_DIR));
  wrap('mcpServers', () => scanners.scanMcpServers(path.dirname(CLAUDE_DIR)));
  wrap('recentFiles', () => scanners.scanRecentFiles(CLAUDE_DIR));
  wrap('tokenUsage', () => scanners.scanTokenUsage(CLAUDE_DIR, tokenCache, titles, sinceDayFor(period)));
  state.plan = await getPlanSection();
  state.generatedAt = Date.now();
  return state;
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 5e6) reject(new Error('body te groot'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('ongeldige JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Stopt een sessie. Alleen PID's die daadwerkelijk een geregistreerde sessie zijn:
// zo kan het dashboard nooit een willekeurig proces afschieten.
function stopSession(pid) {
  const known = scanners.scanSessions(CLAUDE_DIR).some((s) => s.pid === pid);
  if (!known) throw new Error('geen bekende sessie met pid ' + pid);
  process.kill(pid);
  return { stopped: pid };
}

function revealFile(target, roots) {
  const p = actions.assertAllowed(target, roots);
  const { spawn } = require('child_process');
  if (process.platform === 'win32') {
    spawn('explorer.exe', ['/select,', p], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', ['-R', p], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [path.dirname(p)], { detached: true, stdio: 'ignore' }).unref();
  }
  return { revealed: p };
}

function agentTemplate(name) {
  return ['---', 'name: ' + name, 'description: Beschrijf wanneer deze agent gebruikt moet worden.',
    'tools: Read, Grep, Glob', '---', '', 'Je bent ' + name + '. Beschrijf hier de instructies voor deze agent.', ''].join('\n');
}
function skillTemplate(name) {
  return ['---', 'name: ' + name, 'description: Beschrijf wanneer deze skill gebruikt moet worden.',
    '---', '', '# ' + name, '', 'Beschrijf hier de stappen van deze skill.', ''].join('\n');
}

// Maakt een nieuwe agent, skill of hook aan; het pad en de template worden
// server-side bepaald zodat de browser geen paden hoeft te kennen.
function createItem(body, roots) {
  const what = String(body.what || '');
  const scope = body.scope && body.scope !== 'globaal' ? String(body.scope) : null;
  const base = scope ? path.join(scope, '.claude') : CLAUDE_DIR;
  if (what === 'hook') {
    const saved = actions.addHook(path.join(base, 'settings.json'), String(body.event || ''), String(body.matcher || ''), String(body.command || ''), roots);
    return { created: saved };
  }
  const name = String(body.name || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(name)) {
    throw new Error('naam: kleine letters, cijfers en strepen (bijv. mijn-agent)');
  }
  if (what === 'agent') {
    return { created: actions.createFile(path.join(base, 'agents', name + '.md'), agentTemplate(name), roots) };
  }
  if (what === 'skill') {
    return { created: actions.createFile(path.join(base, 'skills', name, 'SKILL.md'), skillTemplate(name), roots) };
  }
  throw new Error('onbekend type: ' + what);
}

const ACTIONS = {
  '/api/session/stop': (body) => stopSession(Number(body.pid)),
  '/api/create': (body, roots) => createItem(body, roots),
  '/api/file/save': (body, roots) => ({ saved: actions.saveFile(body.path, String(body.content ?? ''), roots) }),
  '/api/file/delete': (body, roots) => ({ deleted: actions.deletePath(body.path, roots) }),
  '/api/file/reveal': (body, roots) => revealFile(body.path, roots),
  '/api/hook/delete': (body, roots) =>
    actions.removeHook(body.settingsPath, body.event, Number(body.groupIndex), Number(body.hookIndex), roots),
};

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url || '/', 'http://localhost');
  const route = parsed.pathname;

  // muterende routes: POST + geldig actietoken
  if (ACTIONS[route]) {
    if (req.method !== 'POST') return send(res, 405, { error: 'alleen POST' });
    if (req.headers['x-dashboard-token'] !== ACTION_TOKEN) {
      return send(res, 403, { error: 'ongeldig of ontbrekend actietoken' });
    }
    try {
      const body = await readBody(req);
      return send(res, 200, { ok: true, ...ACTIONS[route](body, allowedRoots()) });
    } catch (err) {
      const msg = String((err && err.message) || err);
      return send(res, /buiten de toegestane/.test(msg) ? 403 : 400, { error: msg });
    }
  }

  if (route === '/api/state') {
    try {
      return send(res, 200, await buildState(parsed.searchParams.get('period')));
    } catch (err) {
      return send(res, 500, { error: String((err && err.message) || err) });
    }
  }

  if (route === '/api/file') {
    const target = parsed.searchParams.get('path');
    try {
      return send(res, 200, {
        path: path.resolve(target),
        content: actions.readFileSafe(target, allowedRoots()),
      });
    } catch (err) {
      const msg = String((err && err.message) || err);
      return send(res, /buiten de toegestane/.test(msg) ? 403 : 404, { error: msg });
    }
  }

  if (route === '/' || route === '/index.html') {
    try {
      let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      html = html.replace('__ACTION_TOKEN__', ACTION_TOKEN);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch {
      res.writeHead(500);
      return res.end('index.html ontbreekt');
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Claude Dashboard draait op http://localhost:${PORT}`);
});
