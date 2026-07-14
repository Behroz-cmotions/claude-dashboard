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

## Remote machines (VM / SSH)

The dashboard reads the `~/.claude` folder on the machine where **it** runs. If you use Claude Code on a remote machine (a VM you SSH into, also from VS Code Remote), your sessions, token usage and OAuth token live **there** — a locally started dashboard will show an empty or broken "Plan & limits" tile ("no OAuth credentials found").

Run the dashboard on that remote machine and open it through an SSH tunnel:

```bash
# on the remote machine
node server.js

# on your own machine
ssh -L 4545:localhost:4545 <user>@<remote-host>
```

Then open **http://localhost:4545** locally. The server still binds to 127.0.0.1 on the remote machine, so nothing is exposed to the network.

Copying `.credentials.json` from the remote machine to your local one works temporarily, but the access token expires and is only refreshed on the machine where Claude Code actually runs — so the tile will break again later.

## macOS

On macOS, Claude Code stores the OAuth token in the **Keychain** instead of `~/.claude/.credentials.json`. The dashboard reads it from there automatically; the first time, macOS may ask whether "node" is allowed to access the item "Claude Code-credentials" — click **Allow**.

To check that the token is present, run:

```bash
security find-generic-password -s "Claude Code-credentials" -w
```

If that prints JSON, the Plan & limits tile will work. If it prints nothing, log in again with Claude Code (`/login`) — or you are in the remote-machine situation above.

## Security

- The server binds to **127.0.0.1 only**, so it is not reachable from the network. Keep it that way: the dashboard talks to your Claude OAuth token server-side and can edit files and stop sessions.
- Mutating actions require a per-start generated token in a custom header, so websites you visit cannot perform actions (the CORS preflight is never answered).
- Your OAuth token never ends up in API responses or cache files.

## Tests

```bash
node --test
```
