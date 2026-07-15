const childProcess = require('child_process');

// Shells die een terminal(venster of -tab) kunnen dragen. De sessie zelf hard
// killen laat de terminal in mouse-tracking-modus achter (escape-rommel bij elke
// muisbeweging); daarom killen we de hele boom vanaf de dragende shell.
const SHELLS = new Set(['pwsh', 'powershell', 'cmd', 'bash', 'zsh', 'fish', 'sh', 'nu']);

function isShell(name) {
  return SHELLS.has(String(name || '').toLowerCase().replace(/\.exe$/, ''));
}

// Regels in het formaat "pid;ppid;naam"; alles wat daar niet aan voldoet wordt genegeerd.
function parseProcessLines(text) {
  const procs = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^(\d+);(\d+);(.+)$/);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3].trim() });
  }
  return procs;
}

function listProcesses() {
  if (process.platform === 'win32') {
    const out = childProcess.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId);$($_.ParentProcessId);$($_.Name)" }'],
      { encoding: 'utf8', windowsHide: true });
    return parseProcessLines(out);
  }
  const out = childProcess.execFileSync('ps', ['-Ao', 'pid=,ppid=,comm='], { encoding: 'utf8' });
  return parseProcessLines(out.replace(/^\s*(\d+)\s+(\d+)\s+/gm, '$1;$2;'));
}

// Klimt vanaf de sessie-pid omhoog zolang de parent een shell is en geeft de
// buitenste shell terug: de proces-root van het terminalvenster. Geen shell als
// parent (bijv. gestart vanuit een IDE)? Dan gewoon de sessie-pid zelf.
function terminalRootPid(pid, processes) {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const seen = new Set([pid]);
  let root = pid;
  let current = byPid.get(pid);
  while (current) {
    const parent = byPid.get(current.ppid);
    if (!parent || !isShell(parent.name) || seen.has(parent.pid)) break;
    seen.add(parent.pid);
    root = parent.pid;
    current = parent;
  }
  return root;
}

function killTree(pid) {
  if (process.platform === 'win32') {
    childProcess.execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    process.kill(pid, 'SIGKILL');
  }
}

// Stopt een sessie inclusief de terminal die hem draait. Lukt het opvragen van
// de proceslijst niet, dan valt hij terug op alleen de sessie zelf.
function killSessionTree(pid, { list = listProcesses, kill = killTree } = {}) {
  let procs = [];
  try {
    procs = list();
  } catch {
    // zonder proceslijst: alleen de sessie zelf killen
  }
  const root = terminalRootPid(pid, procs);
  kill(root);
  return { stopped: pid, killedTree: root };
}

module.exports = { parseProcessLines, terminalRootPid, killSessionTree, listProcesses };
