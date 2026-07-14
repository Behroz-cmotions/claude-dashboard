# API-key-herkenning in de Plan & limits-tegel — ontwerp (2026-07-14)

## Aanleiding

Wie Claude Code met een API-key gebruikt (of via Bedrock/Vertex) heeft geen
OAuth-token in `.credentials.json` of de macOS Keychain. De Plan & limits-tegel
toont dan de rode fout "no OAuth credentials found", terwijl er niets stuk is —
er is alleen geen abonnement met limieten om te tonen.

## Scope

- **Wel:** herkennen dát iemand met een API-key (of Bedrock/Vertex) werkt en dat
  netjes in de tegel tonen in plaats van een fout.
- **Niet (bewust buiten scope):** echte kosten/verbruik ophalen via de Anthropic
  Admin API. Dat komt pas als er later om gevraagd wordt.

## Detectie (server-side, `scanPlan`)

Als er geen OAuth-token gevonden wordt (bestand én Keychain leveren niets op),
controleert `scanPlan` in deze volgorde:

1. `<claudeDir>/settings.json`: `apiKeyHelper`, `env.ANTHROPIC_API_KEY`,
   `env.CLAUDE_CODE_USE_BEDROCK`, `env.CLAUDE_CODE_USE_VERTEX`
2. `<homeDir>/.claude.json`: `customApiKeyResponses.approved` niet leeg
3. Proces-omgeving van de dashboardserver: `ANTHROPIC_API_KEY`,
   `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`

Bij een treffer geeft `scanPlan` geen fout maar:

```json
{ "authMethod": "api-key" | "bedrock" | "vertex", "source": "<waar gevonden>", "limits": [], "spend": null }
```

Zonder treffer blijft de bestaande fout ("no OAuth credentials found") staan.
`env` en `homeDir` zijn injecteerbaar via de bestaande opties-parameter, zodat
tests deterministisch zijn (net als `platform`/`execFileSync` voor de Keychain).

## Weergave (frontend, `renderPlan`)

Bij `authMethod` toont de tegel een badge ("API key", "AWS Bedrock" of
"Google Vertex AI") met de bron erachter, plus één regel uitleg: pay-per-use,
geen abonnementslimieten; verbruik staat in de Anthropic Console. Geen knop,
geen foutkleur. UI-tekst in het Engels, conform de rest van het dashboard.

## Testen

Nieuwe tests in `test/scanners.test.js` per detectiebron, plus een test dat de
usage-API niet wordt aangeroepen bij API-key-detectie en dat zonder enige bron
de bestaande fout blijft. Bestaande "geen credentials"-test krijgt een lege
geïnjecteerde `env` en eigen `homeDir`, zodat de machine van de ontwikkelaar de
uitkomst niet beïnvloedt.
