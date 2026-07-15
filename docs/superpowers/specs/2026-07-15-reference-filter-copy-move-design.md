# Reference-tab: scope-filter en copy/move voor agents, skills en hooks

Datum: 2026-07-15
Status: goedgekeurd

## Doel

De Reference-tab toont agents, hooks, skills, MCP-servers en loops uit alle
scopes door elkaar. De gebruiker wil (1) kunnen filteren op globaal of een
specifiek project, en (2) een agent, skill of hook vanuit het dashboard
kunnen kopiëren of verplaatsen tussen globaal en projecten.

## Besluiten

- Eén filterbalk bovenaan de Reference-tab die alle panelen tegelijk filtert
  (geen filter per paneel).
- Eén knop "copy" per rij die een dialoog opent; verplaatsen is daarin een
  vinkje "origineel verwijderen".
- Naamconflict in het doel blokkeert de actie met een foutmelding; er wordt
  nooit overschreven.
- Loops blijven buiten beschouwing: die zijn per definitie globaal
  (schedule-/cronbestanden in `~/.claude`), dus niet te filteren op project
  en niet te verplaatsen.

## 1. Scope-filterbalk

Bovenaan `zone-reference` komt een knoppenrij: **Alles · Globaal ·
[projectnaam] …**. De projectlijst wordt gevuld uit de scopes die
daadwerkelijk in de data voorkomen (agents, hooks, skills, MCP-servers).
De keuze:

- filtert de panelen Agents, Hooks, Skills en MCP-servers client-side op hun
  scope-veld;
- wordt onthouden in `localStorage` (zoals `dash.tab`);
- laat het Loops-paneel ongemoeid; bij een actief projectfilter toont dat
  paneel de regel "loops zijn altijd globaal".

## 2. Project-skills scannen (backend)

`scanSkills(claudeDir)` wordt `scanSkills(claudeDir, projectPaths)`, naar het
voorbeeld van `scanAgents`:

- scant naast `~/.claude/skills` ook `<project>/.claude/skills`;
- elke skill krijgt een `scope`-veld (`'global'` of het projectpad);
- de Skills-tabel in de UI toont dezelfde scope-tag als bij agents.

Dit is nodig voor het filter én voor copy/move, en maakt project-skills
voor het eerst zichtbaar in het dashboard.

## 3. Copy/move-dialoog (frontend)

Naast *edit* en *del* komt bij agents, skills en hooks één knop **copy**.
De dialoog toont:

- naam/omschrijving van het item;
- een doel-dropdown: globaal + bekende projecten, minus de huidige scope;
- een vinkje "origineel verwijderen (verplaatsen)";
- bij een symlink-skill: melding dat alleen kopiëren kan.

Na succes: toast, dialoog dicht, refresh.

## 4. Server-endpoint `POST /api/item/transfer`

Nieuwe route in de bestaande `ACTIONS`-tabel (dus met actietoken en
allowed-roots-controle). Body: `{ what, source…, target, deleteSource }`,
waarbij `target` `'global'` of een projectpad is.

Per type:

- **Agent** — kopieer het `.md`-bestand naar `<doel>/agents/`; bij
  `deleteSource` daarna de bron verwijderen.
- **Skill** — kopieer de map recursief naar `<doel>/skills/<naam>/`.
  Als de bron een symlink/junction is (marketplace-skill): kopiëren volgt de
  inhoud, maar verplaatsen wordt geblokkeerd met een duidelijke fout —
  anders raakt de plugin-installatie beschadigd.
- **Hook** — de browser stuurt `settingsPath`, `event`, `groupIndex` en
  `hookIndex` (het commando gaat gemaskeerd naar de browser en is dus geen
  betrouwbare sleutel). De server leest het échte commando en de matcher uit
  de bron-settings, voegt de hook toe aan de doel-`settings.json` via het
  bestaande `addHook`, en verwijdert bij `deleteSource` de bron via
  `removeHook`.
- **Conflict** — bestaat het doel al (agent-bestand, skill-map), dan faalt
  de actie met "already exists" en blijft alles onaangeroerd. Voor hooks
  geldt geen conflictcontrole: dubbele hooks zijn toegestaan in settings.json.

Foutafhandeling volgt het bestaande patroon: 403 bij een pad buiten de
allowed roots, anders 400 met de foutmelding.

## 5. Tests

- `scanSkills` met projectpaden: globale + project-skills, scope-veld.
- Transfer-actie: agent kopiëren, agent verplaatsen, skill-map recursief
  kopiëren, symlink-skill verplaatsen geblokkeerd, hook kopiëren en
  verplaatsen, conflictgeval blokkeert.

## Buiten scope

- Loops filteren of verplaatsen.
- Overschrijven bij naamconflict.
- MCP-servers kopiëren of verplaatsen.
