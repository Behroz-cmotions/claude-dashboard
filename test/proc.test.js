const test = require('node:test');
const assert = require('node:assert');
const { parseProcessLines, terminalRootPid, killSessionTree } = require('../lib/proc');

test('parseProcessLines parses pid;ppid;name lines and skips garbage', () => {
  const text = '100;1;pwsh.exe\r\n200;100;claude.exe\r\n\r\nkapotte regel\r\n;;;\r\n';
  assert.deepStrictEqual(parseProcessLines(text), [
    { pid: 100, ppid: 1, name: 'pwsh.exe' },
    { pid: 200, ppid: 100, name: 'claude.exe' },
  ]);
});

test('terminalRootPid climbs to the shell hosting the session', () => {
  const procs = [
    { pid: 10, ppid: 1, name: 'WindowsTerminal.exe' },
    { pid: 20, ppid: 10, name: 'pwsh.exe' },
    { pid: 30, ppid: 20, name: 'claude.exe' },
  ];
  assert.strictEqual(terminalRootPid(30, procs), 20);
});

test('terminalRootPid climbs through nested shells to the outermost shell', () => {
  const procs = [
    { pid: 10, ppid: 1, name: 'explorer.exe' },
    { pid: 20, ppid: 10, name: 'cmd.exe' },
    { pid: 25, ppid: 20, name: 'powershell.exe' },
    { pid: 30, ppid: 25, name: 'node.exe' },
  ];
  assert.strictEqual(terminalRootPid(30, procs), 20);
});

test('terminalRootPid returns the pid itself when the parent is not a shell', () => {
  const procs = [
    { pid: 10, ppid: 1, name: 'code.exe' },
    { pid: 30, ppid: 10, name: 'claude.exe' },
  ];
  assert.strictEqual(terminalRootPid(30, procs), 30);
});

test('terminalRootPid returns the pid itself when the parent is unknown', () => {
  assert.strictEqual(terminalRootPid(30, []), 30);
});

test('terminalRootPid does not hang on a cycle in the process table', () => {
  const procs = [
    { pid: 20, ppid: 30, name: 'pwsh.exe' },
    { pid: 30, ppid: 20, name: 'pwsh.exe' },
  ];
  assert.strictEqual(terminalRootPid(30, procs), 20);
});

test('killSessionTree kills the tree rooted at the hosting shell', () => {
  const procs = [
    { pid: 10, ppid: 1, name: 'WindowsTerminal.exe' },
    { pid: 20, ppid: 10, name: 'pwsh.exe' },
    { pid: 30, ppid: 20, name: 'claude.exe' },
  ];
  const killed = [];
  const result = killSessionTree(30, { list: () => procs, kill: (pid) => killed.push(pid) });
  assert.deepStrictEqual(killed, [20]);
  assert.deepStrictEqual(result, { stopped: 30, killedTree: 20 });
});

test('killSessionTree falls back to the session pid when listing processes fails', () => {
  const killed = [];
  const result = killSessionTree(30, { list: () => { throw new Error('geen wmic'); }, kill: (pid) => killed.push(pid) });
  assert.deepStrictEqual(killed, [30]);
  assert.deepStrictEqual(result, { stopped: 30, killedTree: 30 });
});
