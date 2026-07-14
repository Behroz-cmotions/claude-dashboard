# Claude Dashboard

A local dashboard for [Claude Code](https://claude.com/claude-code): active sessions, agents, skills, hooks, token usage per project and session, and your plan with rate limits — live in the browser.

The dashboard reads the `~/.claude` folder of the user who starts it. Everyone sees their **own** sessions and usage; nothing is shared or sent anywhere.

## Requirements

- **Node.js 18 or newer** — check with `node --version`. There are no dependencies, so `npm install` is not needed.
- **Claude Code** installed and used at least once (otherwise there is no `~/.claude` folder with data).
- Tested on Windows 11; the scanners use platform-independent paths.

## Get it and run it

```bash
git clone https://github.com/Behroz-cmotions/claude-dashboard.git
cd claude-dashboard
node server.js
```

Then open **http://127.0.0.1:4545** in your browser.

Need a different port? Start with `PORT=8080 node server.js` (PowerShell: `$env:PORT='8080'; node server.js`).

## Security

- The server binds to **127.0.0.1 only**, so it is not reachable from the network. Keep it that way: the dashboard talks to your Claude OAuth token server-side and can edit files and stop sessions.
- Mutating actions require a per-start generated token in a custom header, so websites you visit cannot perform actions (the CORS preflight is never answered).
- Your OAuth token never ends up in API responses or cache files.

## Tests

```bash
node --test
```
