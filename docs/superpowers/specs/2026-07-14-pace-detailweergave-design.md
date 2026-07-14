# Pace-detailweergave per limietmeter — ontwerp (2026-07-14)

## Aanleiding

De pace-projectie (spec 2026-07-14-limiet-pace-projectie) is één regel per
meter. Gewenst: meer inzicht — het verloop zien, de trend, en hoeveel ruimte er
nog is.

## Aanpak

Elke limietmeter in de Plan & limits-tegel wordt uitklapbaar (zelfde
`<details>`-patroon als elders in het dashboard, open-status onthouden). De
uitklap toont een mini-grafiek plus statistiekregels. Geldt voor de sessie- én
de weeklimieten.

### Server (`lib/scanners.js`)

- `trackPace` hangt naast `pace` ook de gemeten history aan elke limiet:
  `l.history = [{ at, percent }]` (max 2 uur, zat al in de snapshot — geen
  gevoelige data).
- `computePace` wordt uitgebreid met:
  - `perHour10` — pace over de laatste 10 minuten (trend t.o.v. de
    30-minuten-pace: versnelt/vertraagt); `null` bij minder dan 2 punten of
    minder dan 5 minuten spreiding in dat venster.
  - `sustainablePerHour` — maximaal houdbare pace om de reset te halen:
    resterend percentage gedeeld door de resterende tijd tot reset; `null`
    zonder toekomstige resetsAt.

### Frontend (`public/index.html`)

- De meter wordt de `<summary>`; uitgeklapt verschijnt:
  - **Mini-grafiek (SVG)**: gemeten verloop (laatste 2 uur) als lijn,
    gestippelde extrapolatie van het laatste punt naar 100% (op `fullAt`),
    verticale markering op het reset-moment, gridlijn op 100%. Kleur van de
    extrapolatie volgt het oordeel (rood = loopt leeg vóór de reset, amber =
    krap, anders neutraal). Tijd-as van (nu − 2 uur) tot max(reset, fullAt).
  - **Statistiekregels**: pace 30 min en 10 min (met trendpijl), resterend
    percentage, tijd tot reset, geprojecteerd 100%-moment met marge, en
    maximaal houdbare pace ("you can afford +X%/h").
- Zonder pace-meting toont de uitklap de regel "collecting data (~10 min)…"
  zodat duidelijk is waarom er nog niets staat.

## Testen

Unit-tests voor de nieuwe `computePace`-velden (perHour10-venster,
sustainablePerHour met/zonder resetsAt) en een test dat `createPlanSection`
`history` aan de limieten hangt. Frontend-renderfunctie wordt zoals eerder
gesmoke-test via een VM-context (grafiek aanwezig bij history, nette
fallback zonder meting).
