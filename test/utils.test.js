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
