# HTTP mode quickstart

A start-to-finish setup for driving Roblox Studio from an AI over the **Streamable HTTP**
transport, plus what you can actually ask for once it works.

Use this guide when your AI platform connects to an MCP **server URL**. If your client can spawn
a local process instead (Claude Desktop, Claude Code, Cursor, Codex), plain stdio is simpler and
has a smaller attack surface — see [installation.md](installation.md) and skip this page.

## The one thing that trips everyone up

**There are two connections and two different tokens.** The AI connects to the server; the Studio
plugin *also* connects to the server. Different ports, different secrets.

| | Port | Token | Used by |
| --- | --- | --- | --- |
| MCP endpoint `POST /mcp` | `3668` | `~/.roblox-studio-mcp/http-token` | your **AI platform** |
| Plugin bridge | `3667` | `~/.roblox-studio-mcp/token` | the **Studio plugin** |

```
Your AI platform
      │  HTTPS + Authorization: Bearer <http-token>
      ▼
Reverse tunnel  (only needed if the AI is not on this machine)
      │
      ▼
MCP server   127.0.0.1:3668/mcp
      │
      │  plugin bridge on 127.0.0.1:3667
      ▲
Roblox Studio plugin   (paste <plugin token> in the MCP widget)
```

> The MCP server must run on the **same machine as Roblox Studio**. HTTP mode only changes how the
> *AI* reaches the server. Studio always talks to `127.0.0.1:3667`, and the native tools (launching
> Studio, pressing F5, screenshots) act on the machine the server runs on.

## Do you need a tunnel?

| Situation | What to do |
| --- | --- |
| The AI runs on **this machine** | Point it at `http://127.0.0.1:3668/mcp`. No tunnel. Skip step 6. |
| The AI is a **cloud platform** that only accepts a URL | Add a reverse tunnel (step 6). |
| Your client can spawn a process | You don't need HTTP mode at all. Use stdio. |

---

## 1. Prerequisites

- **Node.js ≥ 18.17** (20 or 22 LTS recommended) — check with `node -v`
- **Roblox Studio** installed, on Windows or macOS

Native host control (launching Studio, screenshots, real play sessions) has extra per-OS
prerequisites listed in [native-control.md](native-control.md); everything else works without them.

## 2. Build

```bash
git clone https://github.com/Meganugger/roblox-studio-mcp.git
cd roblox-studio-mcp
npm install
npm run build
```

Optional confidence check — `npm test` should report **222 tests** passing (the live-X11 suite
self-skips without a display).

## 3. Install the Studio plugin

```bash
node server/dist/index.js --install-plugin
```

Then **fully quit and reopen Roblox Studio**. A **Roblox Studio MCP** section with an **MCP**
button appears in the Plugins tab. Manual install paths are in [installation.md](installation.md).

## 4. Choose your own tokens (recommended)

Both tokens are generated and persisted automatically, but setting them yourself means you always
know them and they never change:

```bash
export ROBLOX_MCP_TOKEN='a-long-random-string-for-studio'
export ROBLOX_MCP_HTTP_TOKEN='a-different-long-random-string-for-the-ai'
```

Each must be **at least 16 characters**.

On Windows, the syntax differs by shell — `cmd.exe` uses `set` with no quotes around the value:

```
set ROBLOX_MCP_TOKEN=a-long-random-string-for-studio
set ROBLOX_MCP_HTTP_TOKEN=a-different-long-random-string-for-the-ai
```

PowerShell uses `$env:`:

```powershell
$env:ROBLOX_MCP_TOKEN='a-long-random-string-for-studio'
$env:ROBLOX_MCP_HTTP_TOKEN='a-different-long-random-string-for-the-ai'
```

Either way the variables only apply to that terminal window, so set them in the same one you start
the server from.

## 5. Start the server in HTTP mode

Run this **from the repository root**, so the relative path resolves:

```bash
node server/dist/index.js --transport http
```

Windows (`cmd.exe` or PowerShell):

```
node server\dist\index.js --transport http
```

The startup log (stderr) tells you everything you need:

```
[INFO] [bridge]   HTTP bridge listening on http://127.0.0.1:3667
[INFO] [http-mcp] Streamable HTTP MCP endpoint: http://127.0.0.1:3668/mcp
[INFO] [main]     MCP bearer token: <http token>
[INFO] [main]     Roblox Studio MCP server v4.0.0 ready (transport: http).
[INFO] [main]     Bridge: http://127.0.0.1:3667 | Plugin auth token: <plugin token>
[INFO] [main]     Native host control: enabled (input simulation: enabled, platform: win32)
[INFO] [main]     Roblox publishing: disabled (ROBLOX_MCP_ALLOW_PUBLISH=1 to enable)
```

To read the tokens back later:

```bash
cat ~/.roblox-studio-mcp/http-token     # for the AI platform
node server/dist/index.js --print-token # for the Studio plugin (also in ~/.roblox-studio-mcp/token)
```

Leave this process running: it *is* the MCP server.

## 6. Publish the endpoint with a reverse tunnel (cloud AI only)

In a second terminal, pick one provider:

```bash
cloudflared tunnel --url http://127.0.0.1:3668   # free, no account needed
ngrok http 3668
tailscale funnel 3668                            # or `tailscale serve` to stay inside your tailnet
```

Each prints an `https://…` hostname. Your MCP URL is that hostname **plus `/mcp`**.

The server never listens on a public interface — the tunnel makes an *outbound* connection from
your machine, so there is no port forwarding and no inbound firewall hole. Quick tunnels get a new
hostname every restart; use a named tunnel for a stable one. Details and a VPS/reverse-proxy
variant: [remote-access.md](remote-access.md).

## 7. Connect the AI platform

| Field | Value |
| --- | --- |
| URL | `https://<tunnel-host>/mcp` — or `http://127.0.0.1:3668/mcp` when local |
| Header | `Authorization: Bearer <http token>` |
| Transport | Streamable HTTP |

The transport is **stateless**: any number of concurrent clients can connect and no session
affinity is required behind a proxy or tunnel.

## 8. Pair Studio with the server

1. Open any place in Studio.
2. Click the **MCP** toolbar button.
3. Paste the **plugin token** — not the http one — leave the port at `3667`, click **Connect**.
4. Status turns **Connected ✓**.
5. If prompted, allow **HTTP Requests** (Game Settings → Security). The plugin tries to enable
   this itself and tells you if it cannot.

The plugin remembers the token and auto-connects in future sessions, including the extra
DataModels Studio creates during a playtest.

---

## Verify it end to end

Two liveness endpoints, neither of which exposes data:

```bash
curl -s http://127.0.0.1:3668/healthz   # MCP transport  -> {"ok":true}
curl -s http://127.0.0.1:3667/health    # plugin bridge  -> {"ok":true,...}
```

List the tool suite through the real MCP endpoint:

```bash
curl -s -X POST http://127.0.0.1:3668/mcp \
  -H "Authorization: Bearer $ROBLOX_MCP_HTTP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

That returns **68 tools**. Without the header you get
`401 Unauthorized: missing or invalid bearer token` — a tunnel URL alone is not enough to control
your Studio.

Finally, ask the AI:

> "Ping Roblox Studio and give me the project info."

If Studio is not paired yet, the answer is a precise diagnosis rather than a failure:

```json
{ "connected": false, "peers": [],
  "hint": "Open Roblox Studio, install/enable the Roblox Studio MCP plugin, set the auth token in
           the plugin widget, and make sure it points at port 3667." }
```

---

## What you can ask for

Prompts below are copy-pasteable. A longer playbook lives in
[`examples/prompts.md`](../examples/prompts.md), and a full transcript-style build in
[`examples/simulator-game.md`](../examples/simulator-game.md).

### Start a session from nothing

The agent can open Studio itself, so there is no manual setup step.

- "Check what you can do on this machine, then create a new baseplate place called PetSimulator and open it in Studio."
- "List my local place files and open the most recent one."

### Understand an existing project

- "Summarise this project: services, scripts, and what's in the map."
- "Export a snapshot with all script sources and review the code for problems."

### Build the world

- "Generate a 400×400 hills terrain map with seed 7, add a stone spawn plaza with a SpawnLocation, and set sunset lighting."
- "Build a lobby — floor, four walls, ceiling lights, entrance archway — as one batch so it's a single undo step."
- "Scatter 30 glowing gold coin parts across the map at ground level."

### Install whole game systems

`install_scaffold` installs production Luau systems in one dependency-resolved, idempotent step:

| id | What you get |
| --- | --- |
| `core` | Bootstrap + networking framework the others build on |
| `data-profiles` | DataStore-backed player profiles that survive rejoins |
| `currency` · `inventory` · `shop` | Server-authoritative money, items and purchasing |
| `quests` · `progression` · `leaderboard` | Quests, XP/levels/achievements, global leaderboards |
| `combat` · `npc` · `matchmaking` | Combat, NPC AI, round-based match loops |
| `settings` · `ui-kit` | Player settings; themed HUD, menus and notifications |

- "Install player data saving, currency, shop and quests, then customise the shop catalog for a mining game: three pickaxes with increasing power and price."
- "Add a rebirth system: at 10,000 coins players can rebirth, resetting coins but gaining a permanent 2× multiplier. Persist it and show it in leaderstats."

### Write and refactor code

- "Extend the HUD with a shop button that opens a panel listing the catalog, wired to the Shop:Buy remote. Match the UIKit theme."
- "Search every script for deprecated APIs (`wait`, `spawn`, `delay`) and refactor them to `task.*`."
- "Check the real ProximityPrompt API before writing this" — it reads the official Roblox reference instead of guessing.

### Test and debug

This is the strongest part of the suite. The agent starts a real play session itself and inspects
the running game; during a playtest each DataModel connects as its own peer, so server and client
state are read independently.

- "Run a full verification pass: compile-check all scripts, playtest, report every error with its stack trace, fix them, and prove it's clean."
- "Start a real play session yourself, reproduce the shop purchase, read the server and client errors separately, fix the cause, and re-test until both are clean."
- "The coin spawner errors on startup — find it, read the stack trace, fix the root cause, and retest."
- "Instrument the damage function with a log breakpoint, reproduce the hit, and tell me why it never fires."

### Look at the result

- "Frame the camera on the lobby and show me a screenshot. If the lighting looks flat, fix it and show me the difference."
- "Studio is showing a dialog I can't get past — take a full-screen screenshot and tell me what it says."

### Whole games

- "Create a round-based sword-fighting arena: lobby and arena map, matchmaking, combat, kill rewards, leaderboards, and a HUD showing round state."
- "Create an obby with 10 stages, checkpoints that persist between sessions, stage leaderstats, and a celebration screen at the finish."

### Ship it (opt-in)

Publishing is disabled until you configure it, because it is the only capability that reaches real
players. Setup is in [publishing.md](publishing.md); once enabled:

> "Save the project and publish it — but only as a saved version, don't release it yet."

Uploads default to `Saved`, which does not affect anyone playing. Releasing (`Published`) and
restarting live servers are separate, explicit steps.

---

## What it cannot do

| Not possible | Why |
| --- | --- |
| Arbitrary mouse/keyboard control of your desktop | Deliberately excluded. Only a closed allowlist of Studio shortcuts, delivered only after the target window is verified to be Roblox Studio. |
| Reading Studio's dialogs, panels or ribbon as data | Roblox exposes no API for it; the agent screenshots and reasons about the image. |
| Rolling back a published place version | Roblox versions are immutable and Open Cloud has no revert call. The only real rollback is publishing older content forward. |
| Saving silently | Roblox forbids it, so `save_project` sends a genuine Ctrl+S — the same action a human performs. |
| Running Studio on Linux | Roblox ships no Linux Studio build. The server runs on Linux; Studio does not. |

---

## Security: what an HTTP endpoint grants

Anyone holding **the URL *and* the token** can edit the open place and — unless you disable it —
execute Luau inside Studio. Treat the token like a password, prefer per-machine tunnels, and shut
the tunnel down when you are finished.

Independent kill switches; set any to `0` and restart:

| Variable | Disables |
| --- | --- |
| `ROBLOX_MCP_ALLOW_RUN_LUAU=0` | Arbitrary code execution, runtime eval and `analyze_scripts` — the one to consider first for a remote agent |
| `ROBLOX_MCP_ALLOW_INSERT_ASSET=0` | Catalog asset insertion |
| `ROBLOX_MCP_ALLOW_NATIVE=0` | All machine control: launching Studio, window focus, shortcuts, screenshots |
| `ROBLOX_MCP_ALLOW_NATIVE_INPUT=0` | Keystroke simulation only; launching and screenshots keep working |
| `ROBLOX_MCP_PLACES_ROOT=<dir>` | Narrows which directories the place tools may touch (defaults to your home directory) |

Publishing (`ROBLOX_MCP_ALLOW_PUBLISH`) is already off by default and needs an API key you mint
yourself. To rotate the AI's token, delete `~/.roblox-studio-mcp/http-token` and restart, or set
`ROBLOX_MCP_HTTP_TOKEN`. The full configuration table is in
[installation.md](installation.md#configuration-reference).

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Error: Cannot find module '…\server\dist\index.js'` (`MODULE_NOT_FOUND`) | Either you have not run `npm run build` yet, or you are not in the repository root. Check with `dir server\dist\index.js` (Windows) / `ls server/dist/index.js`. If you copied a command containing `/absolute/path/to/…`, that was a placeholder — from the repo root the path is just `server/dist/index.js`. |
| `401 Unauthorized: missing or invalid bearer token` | Wrong token — most often the **plugin** token was sent instead of the **http** one. They are different secrets. |
| `404 not found: <method> <path>; the MCP endpoint is POST /mcp` | The request never reached `/mcp`. The server log names the exact path it received — compare it with your URL. Usual causes: the `/mcp` suffix is missing, or the tunnel is mounted on a sub-path and strips it (use `tailscale funnel 3668`, not `tailscale serve https:443 /mcp …`). A trailing slash (`/mcp/`) is accepted. |
| `Failed to connect MCP server: SSE error: Non-200 status code (404)` | Same root cause as above — the platform's client (or its legacy HTTP+SSE fallback) is requesting a path this server does not serve. First run `curl -s https://<tunnel-host>/healthz`: `{"ok":true}` means the tunnel is fine and the URL path is wrong; a 404 there means the tunnel is not pointing at port 3668. Then check the server log for the `404 for …` line, which prints exactly what the platform asked for. This server speaks Streamable HTTP only; there is no `/sse` endpoint. |
| `405 Method not allowed` | `/mcp` is POST-only in stateless mode; the client should not GET it. |
| `Not Acceptable: Client must accept both application/json and text/event-stream` | The request is missing that `Accept` header. Streamable HTTP requires both media types; a client stuck on the older SSE transport will also fail here. |
| "No edit-mode Studio session is connected" | Studio is not paired. Redo step 8; confirm the widget shows **Connected ✓** and the port matches the server's bridge port. |
| Plugin will not connect | Enable **Allow HTTP Requests** (Game Settings → Security) and re-check the token against the startup log. |
| No **MCP** button in Studio | Re-run `--install-plugin`, then fully quit and reopen Studio. |
| `Could not start the HTTP bridge on port 3667` | Another instance is already running. Stop it, or set `ROBLOX_MCP_PORT` and enter the same port in the plugin widget. |
| The tunnel URL stopped working | Quick tunnels rotate their hostname on every restart. Update the platform, or create a named tunnel. |
| Screenshots / F5 unavailable | Ask for `get_host_capabilities`: it names the exact fix (macOS Accessibility and Screen Recording permissions, missing Linux tooling, or a disabled gate). |
| `start_play_solo` returns `running: false` | Studio did not enter play mode — check for a modal dialog with a full-screen screenshot — or the plugin has no saved token for playtest DataModels, so connect once in edit mode first. |

More: [troubleshooting.md](troubleshooting.md) · [remote-access.md](remote-access.md) ·
[native-control.md](native-control.md) · [tools.md](tools.md) (all 68 tools with parameters)
