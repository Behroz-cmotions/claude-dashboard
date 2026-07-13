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
