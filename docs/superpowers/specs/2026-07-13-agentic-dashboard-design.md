# Agentic OS Dashboard — Design

**Datum:** 2026-07-13
**Status:** Goedgekeurd door Behroz

## Doel

Een lokaal, read-only dashboard dat in één oogopslag de volledige Claude Code-omgeving toont: actieve sessies en open terminals, projecten, sessies/runs, background tasks, agents (bestaand en running), hooks, loops/scheduled werk en recente prompts.

## Vorm en stack

- Lokale webapp, gestart met `node server.js`, bereikbaar op `http://localhost:4545`.
- Zero dependencies: alleen Node built-ins (`http`, `fs`, `path`, `child_process`).
- Frontend: één `public/index.html` met inline CSS/JS, donker dashboard-thema.
- Verversing: frontend pollt `GET /api/state` elke 3 seconden; de server scant `~/.claude` vers per request (geen cache, geen database).
- Read-only: geen acties/knoppen die iets wijzigen.

## Architectuur

```
server.js            HTTP-server + alle scanners
public/index.html    Dashboard-UI (één bestand)
```

Routes:
- `GET /` → index.html
- `GET /api/state` → JSON met alle panelen-data

Elke scanner is een geïsoleerde functie die `{ data }` of `{ error }` teruggeeft. Eén kapotte bron (corrupt JSON, permissieprobleem) breekt nooit de hele response: het betreffende paneel toont een foutmelding, de rest werkt door.

## Panelen en databronnen

| Paneel | Bron | Inhoud |
|---|---|---|
| Actieve sessies / terminals | `~/.claude/sessions/*.json` + PID-alive-check via `tasklist` | Naam, cwd/project, status (running/idle), versie, starttijd, laatst actief. Dode PID's worden weggefilterd. |
| Projecten | `~/.claude/projects/*` (mapnaam terug-gedecodeerd naar pad) | Pad, aantal sessies, laatste activiteit; gesorteerd op recentheid. |
| Sessies & runs | `projects/<p>/*.jsonl` + `history.jsonl` | Per project: sessie-ID, titel (eerste prompt uit history.jsonl), laatste wijziging, bestandsgrootte. |
| Background tasks | `~/.claude/tasks/*` | Taak-ID, gekoppelde sessie, laatste activiteit (mtime). |
| Agents | `~/.claude/agents/*.md` + `<project>/.claude/agents/*.md` | Naam, beschrijving, tools, scope (globaal/project) — uit frontmatter. Running agents: actieve sessies met `kind` ≠ interactive + actieve tasks. |
| Hooks | `~/.claude/settings.json` + per project `.claude/settings.json` en `.claude/settings.local.json` | Event, commando, herkomst (globaal/project). |
| Loops & scheduled | Best-effort scan naar cron/schedule-bestanden onder `~/.claude` | Gevonden entries, anders "geen actieve loops". |
| Recente prompts | `history.jsonl`, laatste ~20 regels | Tijdstip, project, prompttekst. |

## Beveiliging

- Server bindt uitsluitend op `127.0.0.1`.
- Secrets worden gemaskeerd vóór verzending naar de browser: waarden in `env`-blokken van settings en alles wat op een key lijkt (`sk-…`, `token`, `key`, `secret`) wordt vervangen door `••••`.

## Foutafhandeling

- Scanner-niveau: try/catch per bron; fout → `{ error: "…" }` in de JSON, paneel toont dit.
- Corrupte JSON-regels in `.jsonl`-bestanden worden per regel overgeslagen.
- Frontend: mislukte poll → statusindicator "verbinding kwijt", pollen gaat door.

## Testen

Handmatige verificatie: dashboard openen, elk paneel vergelijken met de werkelijke data in `~/.claude`; met een tweede Claude Code-sessie open controleren dat status-wijzigingen (running/idle, nieuwe sessie) binnen enkele seconden zichtbaar worden. `/api/state` direct opvragen om de JSON-structuur te controleren.

## Bewust buiten scope

- Acties uitvoeren (sessies stoppen, terminals openen) — later toe te voegen.
- Build-stap, frameworks, externe packages.

---

# V2 — Uitbreiding (goedgekeurd 2026-07-13)

Gebaseerd op onderzoek naar vergelijkbare tools (ccusage, agents-observe, multi-agent-observability) en de beschikbare lokale data.

## Nieuwe panelen

1. **Usage & kosten** — `scanUsage(claudeDir)` leest `usage.db` read-only via het ingebouwde `node:sqlite` (Node ≥ 22.5, blijft zero-dep). Levert: tokens per dag (laatste 14 dagen), verdeling per model, top-10 tools (30 dagen), en totalen van vandaag (tokens, turns). Geen euro-kosten: modelprijzen hardcoden veroudert. Als `node:sqlite` ontbreekt toont het paneel een nette foutmelding.
2. **Live activiteit** — `scanActivity(claudeDir, sessions, sessionFileIndex)`: per actieve sessie de staart van het bijbehorende project-transcript (`readTailLines`): laatst gebruikte tool en laatste assistent-tekstsnippet.
3. **Skills & plugins** — `scanSkills(claudeDir)`: mappen in `~/.claude/skills` met naam/beschrijving uit `SKILL.md`-frontmatter, plus enabled plugins uit `settings.json` (`enabledPlugins`).
4. **MCP-servers** — `scanMcpServers(homeDir)`: parse `~/.claude.json`; globale `mcpServers` + per project. Naam, type/commando (gemaskeerd via `maskSecrets`), scope.

## Look & feel-herontwerp

- KPI-rij bovenaan: actieve sessies, running agents, background tasks, tokens vandaag.
- Sticky header met live-indicator.
- Status-pills (met pulse-animatie voor busy) i.p.v. kale tekst.
- Hiërarchie: operationele panelen (sessies, live activiteit, usage) bovenaan; naslag (agents, hooks, skills, MCP, loops) compacter daaronder.
- Tokens-per-dag als toegankelijk SVG-staafdiagram (assen, hover-tooltip, geen chartjunk).

Alles blijft read-only, 127.0.0.1, foutisolatie per paneel.

---

# V3 — Plan & limieten + rename (2026-07-13)

- Naam gewijzigd van "Agentic OS" naar **Claude Dashboard** (titel + wordmark).
- Nieuw paneel **Plan & limieten**, zoals in de Claude-app: abonnement (Max/Pro) en rate-limit-tier uit `~/.claude/.credentials.json`; sessie- (5 uur), week- en model-week-limiet met percentage, severity en reset-tijdstip, plus extra-usage-tegoed, via `GET https://api.anthropic.com/api/oauth/usage` (dezelfde endpoint als de app).
- `scanPlan(claudeDir, fetcher)` — fetcher injecteerbaar voor tests; het OAuth-token blijft strikt server-side en komt nooit in `/api/state`.
- Server cachet het API-antwoord 60 seconden (max 1 call/minuut i.p.v. elke poll).
- KPI's "sessie-limiet" en "weeklimiet" in de ops-strip.

---

# V4 — Acties, viewer/editor, waiting en recente bestanden (2026-07-13)

Op basis van `ideeen/md`. Het dashboard gaat van read-only naar **read-write met procesbeheer**. Dat vraagt een expliciet veiligheidsmodel.

## Veiligheidsmodel (nieuw, verplicht)

- **Actietoken**: de server genereert bij het starten een willekeurig token (`crypto.randomUUID`), zet het in de geserveerde HTML, en eist het op élke muterende request in de header `X-Dashboard-Token`. Een custom header dwingt een CORS-preflight af, die de server niet toestaat voor cross-origin — daarmee kan geen enkele website die de gebruiker bezoekt acties op het dashboard uitvoeren.
- **Padgrens**: alle bestandsacties (lezen, schrijven, verwijderen) worden gevalideerd met `isAllowedPath(target, roots)`: het gerealiseerde pad (`path.resolve`) moet binnen `~/.claude` of binnen een bekend projectpad liggen. Alles daarbuiten → HTTP 403. Beschermt tegen path traversal (`..`).
- **Bevestiging in de UI** vóór elke destructieve actie (sessie stoppen, item verwijderen).
- Alle muterende routes zijn `POST`; `GET` blijft read-only.

## Nieuwe routes

| Route | Doet |
|---|---|
| `POST /api/session/stop` `{pid}` | Stopt de sessie: `process.kill(pid)`. Alleen PID's die in `sessions/` voorkomen. |
| `GET /api/file?path=…` | Leest een bestand binnen de padgrens; geeft inhoud + of het schrijfbaar is. |
| `POST /api/file/save` `{path, content}` | Schrijft het bestand binnen de padgrens. |
| `POST /api/file/delete` `{path}` | Verwijdert bestand of map (recursief) binnen de padgrens. |
| `POST /api/hook/delete` `{source, event, command}` | Verwijdert één hook uit de betreffende `settings.json`; laat de rest van het bestand intact. |
| `POST /api/file/reveal` `{path}` | Opent het bestand met de standaardapplicatie van het OS (`explorer` op Windows). |

## Nieuwe/uitgebreide scanners

- `scanRecentFiles(claudeDir, projects, limit)` — recent door Claude aangemaakte/gewijzigde bestanden, uit de `Write`/`Edit`/`NotebookEdit`-tool-calls in de recentste transcripts (`message.content[].input.file_path`). `~/.claude/file-history` valt af: dat slaat inhoud-snapshots op onder gehashte namen, zonder het originele pad. Per uniek pad: pad, tool, tijdstip, of het bestand nog bestaat. Nieuwste eerst.
- `scanWaiting(claudeDir, sessions)` — sessies met status `waiting`; haalt uit het transcript de laatste openstaande vraag (`AskUserQuestion`-input of de laatste assistent-tekst) en de aangeboden opties.
- Bestaande scanners krijgen een `path`-veld (agents, skills, loops) en hooks een `source`-pad, zodat viewer/editor en verwijderen weten welk bestand ze raken. Scope (globaal/project) was er al en wordt prominenter getoond.

## Frontend

- Rij-acties: elk item in agents/skills/hooks/loops/sessies krijgt icoonknoppen (bekijk/bewerk, verwijder). Sessies krijgen "stop".
- **Bestandsviewer** als modal: toont de inhoud met een bewerkmodus en "opslaan"; toont het volledige pad en de scope.
- **Wachtend**-paneel: sessie, de vraag, de opties, en een kopieerknop voor het antwoord. Beantwoorden gebeurt in de terminal (geen keystroke-injectie: te fragiel, kan input in het verkeerde venster zetten).
- **Recente bestanden**-paneel: pad, sessie, tijdstip, met "inzien" en "openen".

## Robuustheid van het plan-paneel

De usage-API rate-limit bij te frequente calls (HTTP 429). Het paneel houdt daarom de
laatst succesvol opgehaalde stand vast en toont die met een "stand van X geleden"-markering
in plaats van een leeg paneel; na een fout wordt 2 minuten niet opnieuw geprobeerd.
