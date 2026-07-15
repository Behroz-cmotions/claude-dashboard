# Reference copy/move + filter-dropdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De scope-filterbalk wordt een dropdown, en agents, skills en hooks krijgen een copy-knop waarmee ze via een dialoog gekopieerd of verplaatst worden naar globaal of een ander project.

**Architecture:** Herbruikbare primitieven (`copyPath`, `readHook`) komen in `lib/actions.js` met tests; de per-type compositie (`transferItem`) komt als route `/api/item/transfer` in `server.js`, naast het bestaande `createItem`-patroon. De frontend krijgt een transfer-dialoog naar het model van de create-dialoog.

**Tech Stack:** Node.js (geen dependencies), `node --test`, vanilla-JS-frontend in één `public/index.html`.

Dit plan dekt spec-secties 3 en 4 van
`docs/superpowers/specs/2026-07-15-reference-filter-copy-move-design.md`,
plus de gebruikerswens dat het scopefilter een dropdown wordt.

## Global Constraints

- Geen npm-dependencies; alleen Node-built-ins. Tests draaien met `node --test`.
- Commentaar in de code is Nederlands; UI-teksten zijn Engels (bestaande stijl).
- Alle muterende routes lopen via de `ACTIONS`-tabel (actietoken + allowed-roots).
- Naamconflict in het doel blokkeert; er wordt nooit overschreven.
- Symlink-skills (marketplace): kopiëren mag, verplaatsen geblokkeerd.
- Scope-waarden: `'global'` of het absolute projectpad.

---

### Task 1: Scopefilter als dropdown

**Files:**
- Modify: `public/index.html` — functie `renderRefFilter`, de click-handler-regel voor `refscope`, en CSS bij `.refbar`

**Interfaces:**
- Consumes: bestaand `refScope`, `refScopes(state)`, `esc()`.
- Produces: `<select id="ref-scope-sel">` met values `all | global | <projectpad>`; verder ongewijzigd gedrag (localStorage, refresh).

- [ ] **Step 1: Vervang de knoppenrij door een select**

Vervang de volledige functie `renderRefFilter` door:

```js
let refFilterSig = '';
function renderRefFilter(state) {
  const scopes = refScopes(state);
  // verdwenen project (bv. opgeruimd): val terug op 'all'
  if (refScope !== 'all' && refScope !== 'global' && !scopes.includes(refScope)) refScope = 'all';
  const el = document.getElementById('ref-filter');
  // niet herbouwen als er niets wijzigde of de gebruiker het menu vasthoudt
  const sig = refScope + '|' + scopes.join(';');
  if (sig === refFilterSig || el.contains(document.activeElement)) return;
  refFilterSig = sig;
  const opt = (val, label) =>
    '<option value="' + esc(val) + '"' + (refScope === val ? ' selected' : '') + '>' + esc(label) + '</option>';
  el.innerHTML = '<label class="dim" style="font-size:12px" for="ref-scope-sel">scope</label>' +
    '<select id="ref-scope-sel">' + opt('all', 'all') + opt('global', 'global (~/.claude)') +
    scopes.map((p) => opt(p, p.split('\\').pop())).join('') + '</select>';
}
```

Vervang in de click-handler de regel

```js
  else if (d.act === 'refscope') { refScope = d.val; localStorage.setItem('dash.refscope', refScope); refresh(); }
```

door een change-listener direct na de click-handler:

```js
document.addEventListener('change', (e) => {
  if (e.target.id === 'ref-scope-sel') {
    refScope = e.target.value;
    localStorage.setItem('dash.refscope', refScope);
    refFilterSig = '';
    refresh();
  }
});
```

Voeg CSS toe na de bestaande `.refbar:empty`-regel:

```css
  .refbar select { font: 400 12px var(--mono); color: var(--ink); background: var(--inset); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; }
```

- [ ] **Step 2: Controleer en commit**

Run: `node --test` → 61 pass (regressie; frontend heeft geen unit-tests).

```powershell
git add public/index.html; git commit -m @'
feat: scopefilter als dropdown i.p.v. knoppenrij

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 2: `copyPath` en `readHook` in lib/actions.js (TDD)

**Files:**
- Modify: `lib/actions.js` (na `createFile`; exports uitbreiden)
- Test: `test/actions.test.js`

**Interfaces:**
- Consumes: bestaand `assertAllowed(target, roots)`; bestaande test-helper `tmpRoot()` in `test/actions.test.js:8`.
- Produces:
  - `copyPath(src, dest, roots)` → gekopieerd pad; recursief, volgt symlinks (`dereference`), weigert bestaand doel en paden buiten de roots.
  - `readHook(settingsPath, event, groupIndex, hookIndex, roots)` → `{ event, matcher, command }`; leest de échte hook (ongemaskeerd) uit een settings.json.

- [ ] **Step 1: Schrijf de falende tests** (achteraan `test/actions.test.js`)

Breid eerst de import op regel 6 uit met de nieuwe functies:

```js
const { isAllowedPath, removeHook, deletePath, saveFile, createFile, addHook, copyPath, readHook } = require('../lib/actions');
```

```js
test('copyPath copies a file and a directory recursively inside the root', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'skills', 'demo', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'demo', 'SKILL.md'), 'inhoud');
  fs.writeFileSync(path.join(root, 'skills', 'demo', 'sub', 'extra.md'), 'extra');
  fs.writeFileSync(path.join(root, 'agent.md'), 'agent');

  const dirDest = copyPath(path.join(root, 'skills', 'demo'), path.join(root, 'skills2', 'demo'), [root]);
  assert.strictEqual(fs.readFileSync(path.join(dirDest, 'SKILL.md'), 'utf8'), 'inhoud');
  assert.strictEqual(fs.readFileSync(path.join(dirDest, 'sub', 'extra.md'), 'utf8'), 'extra');
  // bron blijft staan: kopiëren is niet verplaatsen
  assert.ok(fs.existsSync(path.join(root, 'skills', 'demo', 'SKILL.md')));

  const fileDest = copyPath(path.join(root, 'agent.md'), path.join(root, 'agents', 'agent.md'), [root]);
  assert.strictEqual(fs.readFileSync(fileDest, 'utf8'), 'agent');
});

test('copyPath refuses an existing destination and paths outside the root', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'a.md'), 'a');
  fs.writeFileSync(path.join(root, 'b.md'), 'b');
  assert.throws(() => copyPath(path.join(root, 'a.md'), path.join(root, 'b.md'), [root]), /already exists/);
  assert.throws(() => copyPath(path.join(root, 'a.md'), path.join(os.tmpdir(), 'buiten.md'), [root]), /outside the allowed/);
  assert.throws(() => copyPath(path.join(root, 'bestaat-niet.md'), path.join(root, 'c.md'), [root]), /source not found/);
});

test('readHook returns the real command and matcher at the given position', () => {
  const root = tmpRoot();
  const sp = path.join(root, 'settings.json');
  fs.writeFileSync(sp, JSON.stringify({
    hooks: { Stop: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node done.js' }] }] },
  }));
  assert.deepStrictEqual(readHook(sp, 'Stop', 0, 0, [root]),
    { event: 'Stop', matcher: 'Bash', command: 'node done.js' });
  assert.throws(() => readHook(sp, 'Stop', 0, 5, [root]), /hook not found/);
  assert.throws(() => readHook(sp, 'Onbekend', 0, 0, [root]), /hook not found/);
});
```

- [ ] **Step 2: Draai en zie falen** — `node --test test/actions.test.js` → FAIL (`copyPath is not a function`).

- [ ] **Step 3: Implementeer in `lib/actions.js`** (na `createFile`, vóór `addHook`)

```js
// Kopieert een bestand of map (recursief, symlinks worden gevolgd) binnen de
// roots. Weigert een bestaand doel: kopiëren mag nooit stilletjes overschrijven.
function copyPath(src, dest, roots) {
  const s = assertAllowed(src, roots);
  const d = assertAllowed(dest, roots);
  if (!fs.existsSync(s)) throw new Error('source not found: ' + s);
  if (fs.existsSync(d)) throw new Error('already exists: ' + d);
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.cpSync(s, d, { recursive: true, dereference: true });
  return d;
}

// Leest één hook (ongemaskeerd) op positie event/groupIndex/hookIndex.
// De browser kent alleen de gemaskeerde variant; transfers hebben het echte
// commando nodig en halen dat dus server-side op.
function readHook(settingsPath, event, groupIndex, hookIndex, roots) {
  const p = assertAllowed(settingsPath, roots);
  const settings = JSON.parse(fs.readFileSync(p, 'utf8'));
  const groups = settings.hooks && settings.hooks[event];
  const group = Array.isArray(groups) ? groups[groupIndex] : null;
  const hook = group && Array.isArray(group.hooks) ? group.hooks[hookIndex] : null;
  if (!hook) throw new Error('hook not found at position ' + groupIndex + '/' + hookIndex);
  return { event, matcher: group.matcher || '', command: hook.command || '' };
}
```

Exports: `copyPath` en `readHook` toevoegen aan `module.exports`.

- [ ] **Step 4: Draai alle tests** — `node --test` → PASS (64 tests).

- [ ] **Step 5: Commit**

```powershell
git add lib/actions.js test/actions.test.js; git commit -m @'
feat: copyPath en readHook als bouwstenen voor transfers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 3: `isLink` op skills (TDD)

**Files:**
- Modify: `lib/scanners.js` — `scanSkillDir`
- Test: `test/scanners.test.js`

**Interfaces:**
- Consumes: bestaand `scanSkillDir`.
- Produces: elk skill-object krijgt `isLink: boolean` (symlink/junction); Task 4 gebruikt dit om verplaatsen te blokkeren in de dialoog.

- [ ] **Step 1: Falende test** (na de scope-test van scanSkills)

```js
test('scanSkills marks symlinked skills with isLink', () => {
  const dir = makeClaudeDir();
  fs.mkdirSync(path.join(dir, 'skills', 'echt'), { recursive: true });
  const elders = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-skill-src-'));
  fs.writeFileSync(path.join(elders, 'SKILL.md'), '---\nname: gelinkt\n---\n');
  fs.symlinkSync(elders, path.join(dir, 'skills', 'gelinkt'), 'junction');
  const out = scanners.scanSkills(dir);
  assert.strictEqual(out.skills.find((s) => s.name === 'echt').isLink, false);
  assert.strictEqual(out.skills.find((s) => s.name === 'gelinkt').isLink, true);
});
```

- [ ] **Step 2: Draai en zie falen** — `node --test test/scanners.test.js` → FAIL (`isLink` is `undefined`).

- [ ] **Step 3: Implementeer** — in `scanSkillDir` de stat-regels vervangen door:

```js
    let isDir = false;
    let isLink = false;
    try {
      isDir = fs.statSync(path.join(dir, name)).isDirectory();
      isLink = fs.lstatSync(path.join(dir, name)).isSymbolicLink();
    } catch {
      continue;
    }
```

en `isLink,` toevoegen aan het gepushte object (na `scope,`).

- [ ] **Step 4: Draai alle tests** — `node --test` → PASS (65 tests).

- [ ] **Step 5: Commit**

```powershell
git add lib/scanners.js test/scanners.test.js; git commit -m @'
feat: scanSkills markeert symlink-skills met isLink

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 4: `/api/item/transfer` + copy-knop en dialoog

**Files:**
- Modify: `server.js` — functie `transferItem` naast `createItem`, route in `ACTIONS`
- Modify: `public/index.html` — transfer-dialoog (naast `#create`), copy-knoppen in `renderAgents`/`renderSkills`/`renderHooks`, dialooglogica en click-handler

**Interfaces:**
- Consumes: `actions.copyPath`, `actions.readHook`, `actions.addHook`, `actions.removeHook`, `actions.deletePath`, `actions.assertAllowed`; `s.isLink` uit Task 3; `knownProjects` en `scopeOf` uit de frontend.
- Produces: `POST /api/item/transfer` met body `{ what: 'agent'|'skill'|'hook', target: 'global'|<projectpad>, deleteSource: boolean, path?, settingsPath?, event?, groupIndex?, hookIndex? }` → `{ ok, transferred: <doelpad> }`.

- [ ] **Step 1: `transferItem` in server.js** (na `createItem`)

```js
// Kopieert of verplaatst een agent, skill of hook naar globaal of een project.
// Verplaatsen = kopiëren + bron verwijderen; een bestaand doel blokkeert altijd.
function transferItem(body, roots) {
  const what = String(body.what || '');
  const target = body.target && body.target !== 'global' ? String(body.target) : null;
  const base = target ? path.join(target, '.claude') : CLAUDE_DIR;
  const deleteSource = !!body.deleteSource;
  if (what === 'hook') {
    const h = actions.readHook(body.settingsPath, String(body.event || ''), Number(body.groupIndex), Number(body.hookIndex), roots);
    const saved = actions.addHook(path.join(base, 'settings.json'), h.event, h.matcher, h.command, roots);
    if (deleteSource) actions.removeHook(body.settingsPath, h.event, Number(body.groupIndex), Number(body.hookIndex), roots);
    return { transferred: saved };
  }
  const src = actions.assertAllowed(String(body.path || ''), roots);
  const sub = { agent: 'agents', skill: 'skills' }[what];
  if (!sub) throw new Error('unknown type: ' + what);
  if (what === 'skill' && deleteSource && fs.lstatSync(src).isSymbolicLink()) {
    throw new Error('this skill is a symlink (plugin/marketplace): copy it instead of moving');
  }
  const saved = actions.copyPath(src, path.join(base, sub, path.basename(src)), roots);
  if (deleteSource) actions.deletePath(src, roots);
  return { transferred: saved };
}
```

Route toevoegen aan `ACTIONS`:

```js
  '/api/item/transfer': (body, roots) => transferItem(body, roots),
```

- [ ] **Step 2: Transfer-dialoog in de HTML** (direct na `</dialog>` van `#create`)

```html
<dialog id="transfer">
  <div class="dlg-head"><span class="t" id="t-title">copy / move</span></div>
  <div class="dlg-body">
    <div class="form">
      <label>Target<br><select id="t-target"></select></label>
      <label id="t-move-row"><input id="t-move" type="checkbox"> delete original (move)</label>
      <div class="dim" id="t-note" style="font-size:12px" hidden>This skill is a symlink (plugin/marketplace): it can only be copied.</div>
    </div>
  </div>
  <div class="dlg-foot">
    <span class="msg" id="t-msg"></span>
    <button class="btn" id="t-cancel">Cancel</button>
    <button class="btn primary" id="t-ok">Copy</button>
  </div>
</dialog>
```

- [ ] **Step 3: Dialooglogica in het script** (na het create-blok)

```js
/* ── copy / move ───────────────────────────────────────── */
const transferDlg = document.getElementById('transfer');
let transferItemData = null;
function openTransfer(data) {
  transferItemData = data;
  document.getElementById('t-title').textContent = 'copy ' + data.what + ' · ' + data.label;
  const cur = scopeOf(data);
  const opts = ['global', ...knownProjects].filter((t) => scopeOf({ scope: t }) !== cur);
  document.getElementById('t-target').innerHTML = opts.map((t) =>
    '<option value="' + esc(t) + '">' + esc(t === 'global' ? 'global (~/.claude)' : t.split('\\').pop()) + '</option>').join('');
  const move = document.getElementById('t-move');
  move.checked = false;
  move.disabled = !!data.isLink;
  document.getElementById('t-note').hidden = !data.isLink;
  const msg = document.getElementById('t-msg');
  msg.textContent = ''; msg.className = 'msg';
  transferDlg.showModal();
}
document.getElementById('t-cancel').onclick = () => transferDlg.close();
document.getElementById('t-ok').onclick = async () => {
  const msg = document.getElementById('t-msg');
  try {
    await post('/api/item/transfer', {
      ...transferItemData,
      target: document.getElementById('t-target').value,
      deleteSource: document.getElementById('t-move').checked,
    });
    transferDlg.close();
    toast(transferItemData.what + (document.getElementById('t-move').checked ? ' moved' : ' copied'));
    refresh();
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'msg bad';
  }
};
```

In de click-handler, na de `new`-regel:

```js
  else if (d.act === 'transfer') openTransfer(JSON.parse(d.item));
```

- [ ] **Step 4: Copy-knoppen in de renderers**

Helper naast `actView`/`actDel`:

```js
function actTransfer(item) {
  return '<button class="act" data-act="transfer" data-item="' + esc(JSON.stringify(item)) + '" title="copy or move">copy</button>';
}
```

- `renderAgents`: in de acts-cel vóór `actDel`: `actTransfer({ what: 'agent', label: a.name, path: a.path, scope: a.scope })`
- `renderSkills`: idem: `actTransfer({ what: 'skill', label: s.name, path: s.path, scope: s.scope, isLink: s.isLink })`
- `renderHooks`: idem, vóór de hookdel-knop: `actTransfer({ what: 'hook', label: h.event, settingsPath: h.settingsPath, event: h.event, groupIndex: h.groupIndex, hookIndex: h.hookIndex, scope: h.source })`

- [ ] **Step 5: End-to-end-verificatie zonder browser**

Start de server op een vrije poort en oefen de route met echte HTTP-calls
tegen een wegwerp-`CLAUDE_DIR` (het actietoken staat in de geserveerde HTML):
agent kopiëren, agent verplaatsen, skill-map kopiëren, hook kopiëren,
hook verplaatsen, conflict → "already exists", symlink-move → geblokkeerd.
Controleer de bestanden op schijf na elke stap.

- [ ] **Step 6: Draai alle tests** — `node --test` → PASS (65 tests).

- [ ] **Step 7: Commit**

```powershell
git add server.js public/index.html; git commit -m @'
feat: copy/move van agents, skills en hooks via /api/item/transfer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```
