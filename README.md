# Claude Dashboard

Een lokaal dashboard voor [Claude Code](https://claude.com/claude-code): actieve sessies, agents, skills, hooks, tokengebruik per project en sessie, en je abonnement met rate-limits — live in de browser.

Het dashboard leest de `~/.claude`-map van de gebruiker die het start. Iedereen ziet dus zijn **eigen** sessies en usage; er wordt niets gedeeld of naar buiten gestuurd.

## Wat heb je nodig

- **Node.js 18 of nieuwer** — controleer met `node --version`. Er zijn geen dependencies, dus `npm install` is niet nodig.
- **Claude Code** geïnstalleerd en minstens één keer gebruikt (anders is er geen `~/.claude`-map met data).
- Getest op Windows 11; de scanners gebruiken platformonafhankelijke paden.

## Ophalen en starten

```bash
git clone https://github.com/Behroz-cmotions/claude-dashboard.git
cd claude-dashboard
node server.js
```

Open daarna **http://127.0.0.1:4545** in je browser.

Andere poort nodig? Start met `PORT=8080 node server.js` (PowerShell: `$env:PORT='8080'; node server.js`).

> Privérepo: vraag de eigenaar je GitHub-account als collaborator toe te voegen en log eenmalig in met `gh auth login` (of laat Git Credential Manager het loginvenster tonen bij het clonen).

## Veiligheid

- De server bindt **alleen op 127.0.0.1** en is dus niet bereikbaar vanaf het netwerk. Zo houden: het dashboard praat server-side met je Claude OAuth-token en kan bestanden bewerken en sessies stoppen.
- Muterende acties vereisen een per-start gegenereerd token in een custom header, zodat websites die je bezoekt geen acties kunnen uitvoeren (CORS-preflight wordt niet beantwoord).
- Je OAuth-token komt nooit in de API-responses of in cachebestanden terecht.

## Tests

```bash
node --test
```
