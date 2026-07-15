# Reference-scopefilter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eén filterbalk bovenaan de Reference-tab waarmee agents, hooks, skills en MCP-servers gefilterd worden op globaal of een specifiek project.

**Architecture:** De backend levert al scope-velden voor agents, hooks en MCP-servers; alleen `scanSkills` moet projectmappen erbij scannen. Het filter zelf is puur client-side in `public/index.html`: een knoppenrij gevuld uit de scopes in de data, de keuze in `localStorage`, en per paneel een filter op het scope-veld vóór het renderen.

**Tech Stack:** Node.js (geen dependencies), `node --test`, vanilla-JS-frontend in één `public/index.html`.

Dit plan dekt spec-secties 1 en 2 van
`docs/superpowers/specs/2026-07-15-reference-filter-copy-move-design.md`
(de copy/move-secties 3 en 4 volgen in een later plan).

## Global Constraints

- Geen npm-dependencies; alleen Node-built-ins. Tests draaien met `node --test`.
- Commentaar in de code is Nederlands; UI-teksten zijn Engels (bestaande stijl).
- Frontend is één bestand (`public/index.html`), geen build-stap.
- Scope-waarden: `'global'` of het absolute projectpad (bestaande conventie van `scanAgents`/`scanHooks`).
- Loops zijn altijd globaal: het Loops-paneel filtert niet mee; bij een actief projectfilter toont het "loops are always global".

---

### Task 1: `scanSkills` scant ook project-skills en geeft elke skill een scope

**Files:**
- Modify: `lib/scanners.js:322-355` (functie `scanSkills`)
- Modify: `server.js:74` (aanroep krijgt `projectPaths` mee)
- Test: `test/scanners.test.js` (na de bestaande scanSkills-test op regel 189-207)

**Interfaces:**
- Consumes: bestaand `parseFrontmatter(content)` en `readJsonSafe(path)` uit `lib/scanners.js`/`lib/utils.js`; `projectPaths` (array van absolute projectpaden) zoals `server.js` die al opbouwt voor `scanAgents`.
- Produces: `scanSkills(claudeDir, projectPaths = [])` → `{ skills, plugins }`, waarbij elke skill nu ook `scope: 'global' | <projectpad>` heeft. Task 2 en 3 lezen dit `scope`-veld.

- [ ] **Step 1: Schrijf de falende test**

In `test/scanners.test.js`, direct na de bestaande test `'scanSkills lists skill dirs with frontmatter and enabled plugins'` (regel 207):

```js
test('scanSkills merges global and project skills with a scope field', () => {
  const dir = makeClaudeDir();
  fs.mkdirSync(path.join(dir, 'skills', 'factuur'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'skills', 'factuur', 'SKILL.md'),
    '---\nname: factuur\ndescription: Globale skill\n---\n'
  );
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-proj-'));
  fs.mkdirSync(path.join(proj, '.claude', 'skills', 'deploy'), { recursive: true });
  fs.writeFileSync(
    path.join(proj, '.claude', 'skills', 'deploy', 'SKILL.md'),
    '---\nname: deploy\ndescription: Projectskill\n---\n'
  );
  const out = scanners.scanSkills(dir, [proj]);
  assert.strictEqual(out.skills.length, 2);
  const globalSkill = out.skills.find((s) => s.name === 'factuur');
  const projectSkill = out.skills.find((s) => s.name === 'deploy');
  assert.strictEqual(globalSkill.scope, 'global');
  assert.strictEqual(projectSkill.scope, proj);
  assert.strictEqual(projectSkill.skillFile, path.join(proj, '.claude', 'skills', 'deploy', 'SKILL.md'));
});
```

- [ ] **Step 2: Draai de test en zie hem falen**

Run: `node --test test/scanners.test.js`
Expected: FAIL — `out.skills.length` is 1 (projectskill wordt niet gescand) en/of `scope` is `undefined`.

- [ ] **Step 3: Implementeer de scanner-wijziging**

In `lib/scanners.js`: vervang de bestaande `scanSkills` (regel 322-355) door een
`scanSkillDir`-helper plus een samenvoegende `scanSkills`, naar het voorbeeld
van `scanAgentDir`/`scanAgents`:

```js
function scanSkillDir(dir, scope) {
  if (!fs.existsSync(dir)) return [];
  const skills = [];
  for (const name of fs.readdirSync(dir)) {
    // statSync volgt symlinks/junctions (marketplace-skills zijn vaak gelinkt)
    let isDir = false;
    try {
      isDir = fs.statSync(path.join(dir, name)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    let fm = {};
    try {
      fm = parseFrontmatter(fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8'));
    } catch {
      // geen of onleesbare SKILL.md: alleen de mapnaam tonen
    }
    skills.push({
      name: fm.name || name,
      description: fm.description || '',
      scope,
      path: path.join(dir, name),
      skillFile: path.join(dir, name, 'SKILL.md'),
    });
  }
  return skills;
}

function scanSkills(claudeDir, projectPaths = []) {
  const skills = scanSkillDir(path.join(claudeDir, 'skills'), 'global');
  for (const p of projectPaths) {
    skills.push(...scanSkillDir(path.join(p, '.claude', 'skills'), p));
  }
  const settings = readJsonSafe(path.join(claudeDir, 'settings.json'));
  const plugins = Object.entries((settings && settings.enabledPlugins) || {}).map(([name, enabled]) => ({
    name,
    enabled: !!enabled,
  }));
  return { skills, plugins };
}
```

In `server.js` regel 74, geef de al bestaande `projectPaths` mee:

```js
  wrap('skills', () => scanners.scanSkills(CLAUDE_DIR, projectPaths));
```

- [ ] **Step 4: Draai alle tests en zie ze slagen**

Run: `node --test`
Expected: PASS — 61 tests, ook de bestaande scanSkills-test (die zonder
`projectPaths` aanroept en nu skills met `scope: 'global'` krijgt).

- [ ] **Step 5: Commit**

```powershell
git add lib/scanners.js server.js test/scanners.test.js; git commit -m @'
feat: scanSkills scant ook project-skills en levert een scope-veld

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 2: Scope-kolom in het Skills-paneel

**Files:**
- Modify: `public/index.html:852-867` (functie `renderSkills`)

**Interfaces:**
- Consumes: het `scope`-veld op elke skill uit Task 1.
- Produces: Skills-tabel met dezelfde scope-tag als het Agents-paneel; Task 3 filtert op ditzelfde veld.

- [ ] **Step 1: Voeg de scope-kolom toe**

Vervang in `renderSkills` de tabelopbouw (de `let html = …`-expressie) door:

```js
  let html = '<table><tr><th>Skill</th><th>Scope</th><th></th></tr>' +
    skills.map((s) =>
      '<tr><td><span class="mono">' + esc(s.name) + '</span>' +
      (s.description ? '<div class="dim ellipsis" style="font-size:12px" title="' + esc(s.description) + '">' + esc(s.description) + '</div>' : '') +
      '</td><td><span class="tag" title="' + esc(s.scope || 'global') + '">' + esc(!s.scope || s.scope === 'global' ? 'global' : 'project') + '</span></td>' +
      '<td class="acts">' + actView(s.skillFile, 'skill') + actDel(s.path, s.name) + '</td></tr>'
    ).join('') + '</table>';
```

(Alleen de header-rij en de nieuwe `<td>` met de tag zijn nieuw; de rest is ongewijzigd.)

- [ ] **Step 2: Controleer handmatig**

Run: `node server.js`, open `http://localhost:4545`, tab **Reference**.
Expected: het Skills-paneel toont per skill een tag `global` (of `project` met het pad als tooltip zodra een project `.claude/skills` heeft).

- [ ] **Step 3: Commit**

```powershell
git add public/index.html; git commit -m @'
feat: scope-tag in het Skills-paneel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 3: Scope-filterbalk boven de Reference-tab

**Files:**
- Modify: `public/index.html:294-303` (HTML van `zone-reference`)
- Modify: `public/index.html` CSS-blok (bij de `.act`-regels rond regel 174-238)
- Modify: `public/index.html:570-584` (click-handler voor `data-act`)
- Modify: `public/index.html:1032-1036` (panel-aanroepen in `refresh()`)

**Interfaces:**
- Consumes: scope-velden — `a.scope` (agents, skills), `h.source` (hooks), `m.scope` (MCP-servers).
- Produces: globale variabele `refScope` (`'all' | 'global' | <projectpad>`), bewaard als `localStorage['dash.refscope']`; helperfuncties `scopeOf(item)`, `renderRefFilter(state)` en `scopeFilter(section, pick)`.

- [ ] **Step 1: Voeg de filterbalk-container toe aan de HTML**

In `zone-reference` (regel 294), direct boven `<div class="grid g-ref">`:

```html
    <div class="refbar" id="ref-filter"></div>
```

- [ ] **Step 2: Voeg de CSS toe**

Na de bestaande `.act.on`-regel (regel 238):

```css
  .refbar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-bottom: 12px; }
  .refbar:empty { display: none; }
```

- [ ] **Step 3: Voeg filter-state en helpers toe**

In het script, direct na het `detailsState`-blok (na regel 521):

```js
/* ── reference-scopefilter ─────────────────────────────── */
let refScope = localStorage.getItem('dash.refscope') || 'all';
// agents en skills hebben `scope`, hooks `source`; ontbreekt het veld dan globaal
function scopeOf(x) { return x.scope || x.source || 'global'; }

// alle projectscopes die daadwerkelijk in de data voorkomen
function refScopes(state) {
  const scopes = new Set();
  for (const key of ['agents', 'hooks', 'mcpServers']) {
    for (const item of (state[key] && state[key].data) || []) {
      const s = scopeOf(item);
      if (s !== 'global') scopes.add(s);
    }
  }
  for (const s of (((state.skills && state.skills.data) || {}).skills) || []) {
    if (s.scope && s.scope !== 'global') scopes.add(s.scope);
  }
  return [...scopes].sort();
}

function renderRefFilter(state) {
  const scopes = refScopes(state);
  // verdwenen project (bv. opgeruimd): val terug op 'all'
  if (refScope !== 'all' && refScope !== 'global' && !scopes.includes(refScope)) refScope = 'all';
  const btn = (val, label, title) =>
    '<button class="act' + (refScope === val ? ' on' : '') + '" data-act="refscope" data-val="' + esc(val) + '"' +
    (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(label) + '</button>';
  document.getElementById('ref-filter').innerHTML =
    '<span class="dim" style="font-size:12px;margin-right:4px">scope</span>' +
    btn('all', 'all') + btn('global', 'global') +
    scopes.map((p) => btn(p, p.split('\\').pop(), p)).join('');
}

// filtert de data van een sectie op de gekozen scope; errors blijven zichtbaar
function scopeFilter(section, pick) {
  if (refScope === 'all' || !section || !section.data) return section;
  return { ...section, data: pick(section.data) };
}
```

- [ ] **Step 4: Verwerk kliks op de filterknoppen**

In de click-handler (regel 570-584), na de `period`-regel:

```js
  else if (d.act === 'refscope') { refScope = d.val; localStorage.setItem('dash.refscope', refScope); refresh(); }
```

- [ ] **Step 5: Filter de panelen in `refresh()`**

Vervang in `refresh()` de vijf reference-panelaanroepen (regel 1032-1036) door:

```js
    renderRefFilter(state);
    const bySc = (arr) => (arr || []).filter((x) => scopeOf(x) === refScope);
    panel('#p-agents', scopeFilter(state.agents, bySc), renderAgents);
    panel('#p-hooks', scopeFilter(state.hooks, bySc), renderHooks);
    panel('#p-skills', scopeFilter(state.skills, (d) => ({
      skills: bySc(d.skills),
      // plugins zijn per definitie globaal: alleen tonen bij 'all' of 'global'
      plugins: refScope === 'global' ? d.plugins : [],
    })), renderSkills);
    panel('#p-mcp', scopeFilter(state.mcpServers, bySc), renderMcp);
    panel('#p-loops', state.loops, renderLoops);
    if (refScope !== 'all' && refScope !== 'global') {
      document.querySelector('#p-loops .body').innerHTML = '<div class="empty">loops are always global</div>';
    }
```

Let op: het Skills-paneel toont bij een lege gefilterde lijst geen "no items"
(de data is een object, geen array) — `renderSkills` rendert dan een lege
tabel plus eventueel de plugins. Dat is acceptabel; het `panel()`-contract
blijft ongewijzigd.

- [ ] **Step 6: Controleer handmatig**

Run: `node server.js`, open `http://localhost:4545`, tab **Reference**. Controleer:
1. De filterbalk toont **scope · all · global · [projectnamen]**; projecten alleen als er project-agents/hooks/skills/MCP-servers bestaan.
2. **global** verbergt project-items in alle vier de panelen; een projectknop toont alléén dat project en het Loops-paneel meldt "loops are always global".
3. Herlaad de pagina: de gekozen filter blijft actief (`localStorage`).
4. Klik daarna weer op **all**: alle items zijn weer zichtbaar en de plugins verschijnen weer onder Skills.

- [ ] **Step 7: Draai alle tests (regressie)**

Run: `node --test`
Expected: PASS — 61 tests.

- [ ] **Step 8: Commit**

```powershell
git add public/index.html; git commit -m @'
feat: scope-filterbalk op de Reference-tab (all/global/project)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```
