const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isAllowedPath, removeHook, deletePath, saveFile } = require('../lib/actions');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aos-act-'));
}

test('isAllowedPath accepts paths inside a root and rejects everything else', () => {
  const root = tmpRoot();
  const inside = path.join(root, 'sub', 'file.md');
  assert.strictEqual(isAllowedPath(inside, [root]), true);
  assert.strictEqual(isAllowedPath(root, [root]), true);
  assert.strictEqual(isAllowedPath(path.join(os.tmpdir(), 'elders.txt'), [root]), false);
  assert.strictEqual(isAllowedPath('', [root]), false);
});

test('isAllowedPath blocks path traversal out of the root', () => {
  const root = tmpRoot();
  const escape = path.join(root, '..', '..', 'Windows', 'system32', 'evil.txt');
  assert.strictEqual(isAllowedPath(escape, [root]), false);
});

test('isAllowedPath does not accept a sibling dir with the same prefix', () => {
  const base = tmpRoot();
  const root = path.join(base, 'claude');
  fs.mkdirSync(root);
  assert.strictEqual(isAllowedPath(path.join(base, 'claude-evil', 'x.txt'), [root]), false);
});

test('saveFile writes inside the root and refuses outside it', () => {
  const root = tmpRoot();
  const target = path.join(root, 'a.md');
  saveFile(target, '# hallo', [root]);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), '# hallo');
  assert.throws(() => saveFile(path.join(os.tmpdir(), 'nope.md'), 'x', [root]), /buiten/i);
});

test('deletePath removes a file and a directory, but refuses outside the root', () => {
  const root = tmpRoot();
  const file = path.join(root, 'weg.md');
  fs.writeFileSync(file, 'x');
  deletePath(file, [root]);
  assert.strictEqual(fs.existsSync(file), false);

  const dir = path.join(root, 'map');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'in.md'), 'x');
  deletePath(dir, [root]);
  assert.strictEqual(fs.existsSync(dir), false);

  const outside = path.join(os.tmpdir(), 'aos-niet-verwijderen.txt');
  fs.writeFileSync(outside, 'x');
  assert.throws(() => deletePath(outside, [root]), /buiten/i);
  assert.strictEqual(fs.existsSync(outside), true, 'bestand buiten de root blijft bestaan');
});

test('removeHook deletes only the indexed hook and keeps the rest of settings intact', () => {
  const root = tmpRoot();
  const settingsPath = path.join(root, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    model: 'claude-fable-5',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'weg.py' }, { type: 'command', command: 'blijft.py' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check.sh' }] }],
    },
  }, null, 2));

  const res = removeHook(settingsPath, 'Stop', 0, 0, [root]);
  assert.strictEqual(res.command, 'weg.py', 'geeft terug wat er verwijderd is');
  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.strictEqual(after.model, 'claude-fable-5', 'andere settings blijven staan');
  assert.deepStrictEqual(after.hooks.Stop[0].hooks.map((h) => h.command), ['blijft.py']);
  assert.strictEqual(after.hooks.PreToolUse[0].hooks.length, 1, 'andere events blijven staan');
});

test('removeHook drops an event key once its last hook is gone', () => {
  const root = tmpRoot();
  const settingsPath = path.join(root, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'enige.py' }] }] },
  }));
  removeHook(settingsPath, 'Stop', 0, 0, [root]);
  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.deepStrictEqual(after.hooks, {}, 'leeg event wordt opgeruimd');
});

test('removeHook rejects an out-of-range index instead of deleting the wrong hook', () => {
  const root = tmpRoot();
  const settingsPath = path.join(root, 'settings.json');
  const original = { hooks: { Stop: [{ hooks: [{ command: 'a' }] }] } };
  fs.writeFileSync(settingsPath, JSON.stringify(original));
  assert.throws(() => removeHook(settingsPath, 'Stop', 0, 5, [root]), /niet gevonden/i);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), original, 'bestand ongewijzigd');
});

test('removeHook refuses a settings file outside the root', () => {
  const root = tmpRoot();
  const outside = path.join(os.tmpdir(), 'aos-buiten-settings.json');
  fs.writeFileSync(outside, JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'x' }] }] } }));
  assert.throws(() => removeHook(outside, 'Stop', 0, 0, [root]), /buiten/i);
});
