# Pace-projectie op de limietmeters — ontwerp (2026-07-14)

## Aanleiding

Wie tegen zijn sessielimiet aan zit, tuurt naar het percentage ("99%...") zonder
te weten of hij de reset gaat halen. Gewenst: live zien hoe snel een limiet
volloopt bij de huidige werkwijze, en of 100% vóór of ná de reset valt.

## Aanpak

Het percentageverloop dat de server toch al elke minuut ophaalt is de bron; we
schatten niets op basis van lokale token-tellingen (quotumomvang is onbekend).

### Server (`lib/scanners.js`)

- `createPlanSection` bewaart per limiet (sleutel: `kind + ':' + scope`) een
  rolling history van `{ at, percent }`, maximaal 2 uur, ook in de
  schijf-snapshot (`dashboard-plan-cache.json`) zodat een herstart de meting
  niet wist. Daalt het percentage (reset gedetecteerd), dan begint de history
  voor die limiet opnieuw.
- `computePace(history, now, resetsAt)` (geëxporteerd, puur, testbaar) rekent
  over een venster van 30 minuten: minimaal 2 metingen en 10 minuten spreiding,
  alleen bij stijgend verbruik. Resultaat per limiet op het veld `pace`:

  ```json
  { "perHour": 62.4, "fullAt": 1760000000000, "makesReset": false }
  ```

  `makesReset` = haalt de reset (fullAt op of ná resetsAt); `null` zonder
  resetsAt. Geen betrouwbare meting → `pace` is `null`/afwezig.

### Frontend (`public/index.html`)

- Onder elke meter met `pace` een regel `.mpace`:
  `+62%/h · full ~14:32 · resets 14:59 ✓` — rood (`--err`) als de limiet vóór
  de reset vol raakt, amber (`--signal`) als de marge onder de 15 minuten zit,
  anders gedimd.
- Het KPI-blokje "session limit" bovenin toont naast het percentage de
  verwachte 100%-tijd: `87% · full ~14:32` (alleen als er een pace is).

## Testen

Unit-tests voor `computePace` (te weinig data, te korte spreiding, vlak
verbruik, correcte perHour/fullAt/makesReset) en een integratietest die via een
geseede snapshot-history controleert dat `createPlanSection` de limieten met
`pace` decoreert en de history bijhoudt.
