# Tabs en tegel-scroll — ontwerp

Datum: 2026-07-14
Status: goedgekeurd

## Doel

Het dashboard staat nu volledig op één pagina met vier zones onder elkaar. Drukke
panelen zoals Live activiteit duwen de rest van de pagina ver naar beneden. Het
dashboard krijgt daarom tabbladen per zone en een interne scroll per tegel.

## Besluiten

- **Tabindeling**: de vier bestaande zones worden de vier tabs: Nu, Verbruik,
  Naslag, Archief.
- **"Wacht op jou"** verhuist uit de Nu-grid naar een banner tussen tabbalk en
  tabinhoud. Die is op elke tab zichtbaar zodra een sessie op de gebruiker wacht,
  en blijft verborgen als er niets wacht.
- **Tegel-scroll**: elke paneel-body krijgt een vaste max-hoogte (ca. 420px) met
  `overflow-y: auto`. De paneelkop (titel + telling) staat buiten het
  scrollgebied en blijft altijd zichtbaar. Korte inhoud merkt niets van de
  max-hoogte.

## Aanpak

Client-side tabs; alle zones blijven in de DOM en worden met een class
getoond/verborgen. De bestaande `refresh()` blijft alle panelen elke 3 s
bijwerken, zodat KPI's en tab-badges ook voor verborgen tabs kloppen. Geen
serverwijzigingen; alles in `public/index.html`.

Afgewezen alternatieven: hash-routing (bookmarkbaar maar onnodig voor een lokaal
dashboard) en alleen de actieve tab renderen (maakt `refresh()` complexer voor
verwaarloosbare winst).

## Onderdelen

1. **Tabbalk** direct onder de sticky ops-strip, zelf ook sticky. Stijl volgt de
   bestaande zone-labels (mono, uppercase, letter-spacing); de actieve tab krijgt
   accentkleur en een onderstreping.
2. **Badges per tabknop**: klein aantal-label (Nu: actieve sessies; Verbruik:
   geen badge; Naslag: geen badge; Archief: geen badge). Op "Nu" een
   attentie-stip in signaalkleur wanneer er een wachtende sessie is én een andere
   tab actief is. (De banner maakt de stip deels redundant, maar hij markeert de
   tab waar de context staat.)
3. **Tabkeuze onthouden** in `localStorage` (`dash.tab`); onbekende of ontbrekende
   waarde valt terug op "Nu".
4. **Scroll per tegel**: `.panel .body { max-height: 420px; overflow-y: auto; }`
   met een smalle scrollbar in themakleuren. Uitzondering: het plan-paneel en de
   grafiek hebben dit niet nodig maar krijgen het toch — het is een max, geen
   vaste hoogte, dus het heeft geen visueel effect zolang de inhoud past.

## Toegankelijkheid

Tabbalk als `role="tablist"` met `role="tab"`, `aria-selected` en
`aria-controls`; zones krijgen `role="tabpanel"`. Pijltjestoetsen zijn niet
nodig voor deze omvang; focus-stijlen volgen de bestaande `focus-visible`-regel.

## Testen

De UI is één statisch HTML-bestand zonder testharnas; verificatie gebeurt
handmatig in de browser: tabs wisselen, badge-gedrag, wacht-banner op andere
tabs, scroll in Live activiteit, en tabkeuze na herladen.
