# Roblox Studio MCP

**A production Model Context Protocol (MCP) integration that lets AI agents control Roblox Studio and autonomously build, test, and debug Roblox games.**

With this project connected, an AI assistant (Claude, Cursor, Claude Code, or any MCP client) can operate like a full Roblox development team — programmer, level designer, UI developer, gameplay engineer, tester, and debugger — inside a live Studio session:

- 🖥️ **Runs Studio for you** — `get_host_capabilities` reports what the machine allows, then `create_place_file` + `launch_studio` create a real `.rbxlx` project and open it, waiting until the plugin connects. No manual setup step before the agent can work
- 📸 **Sees the viewport** — `capture_studio_screenshot` returns the Studio window as an image, so the agent can visually verify geometry, lighting and UI instead of guessing
- 🎮 **Drives real play sessions** — `start_play_solo` presses F5 and waits for the playtest server/client peers, making the build → test → debug → fix loop fully autonomous; `save_project` sends the real Ctrl+S
- 🌳 **Explorer control** — create, inspect, clone, move, rename, and delete instances; batch-build hundreds of objects with one undo waypoint; bulk `mass_set_properties` across a whole map
- 📜 **Script management** — create/read/edit/patch/search/refactor `Script`, `LocalScript`, and `ModuleScript`; project-wide `find_and_replace_in_scripts` with dry-run; compile-check the whole place
- ⚙️ **Code execution** — run arbitrary Luau in Studio (plugin security level) with captured output and serialized return values
- 🐞 **Runtime debugging** — during play-solo / multiplayer tests every DataModel connects as its own peer: `eval_server_runtime` / `eval_client_runtime` inspect **live game state mid-playtest**, per-peer `get_output_logs` / `get_errors` read each side's logs (including boot-time prints), and `set_log_breakpoint` instruments code without pausing
- 🧪 **Test & debug loop** — start/stop playtests, read output logs and errors *with Luau stack traces*, fix, and retest — fully autonomously
- 📚 **Official API docs** — `get_roblox_docs` fetches real Roblox engine reference (classes, datatypes, enums) so the agent checks `ProximityPrompt` or `CFrame` semantics instead of hallucinating them
- 🚀 **Ships to Roblox** — `publish_place` uploads the saved place to your experience through Open Cloud (safe `Saved` default, explicit `Published` to release), plus `update_place_config`, `restart_universe_servers` and MessagingService live-ops. Off by default and gated behind your own API key ([docs/publishing.md](docs/publishing.md))
- 🌍 **World building** — procedural terrain (Perlin-noise hills, blocks, spheres), lighting presets, catalog asset insertion, camera control
- 🧩 **Game system scaffolds** — one command installs production-grade systems: DataStore player profiles, currencies, inventory, shop, quests, progression + achievements, global leaderboards, combat, NPCs, round/matchmaking loops, settings, and a themed UI kit (HUD, menus, notifications)
- 🌐 **Every MCP client** — stdio for local clients (Claude Code, Claude Desktop, Cursor, Codex, Gemini) **plus a Streamable HTTP transport (`--transport http`) for AI platforms that only accept a server URL**, publishable through Cloudflare Tunnel / ngrok / Tailscale ([docs/remote-access.md](docs/remote-access.md))
- 🔐 **Security-first** — bearer-token authentication on both the plugin bridge and the HTTP MCP endpoint, localhost-only binds by default, command validation, rate-limited remotes in generated code, script-stripping on asset inserts

## Architecture

```
AI Agent (Claude / Cursor / URL-only platforms / any MCP client)
        │  MCP over stdio  — or —  Streamable HTTP at /mcp (bearer token)
        ▼
MCP Server (Node.js + TypeScript)
        ├──────────────── native host layer ────────────────┐
        │  local HTTP bridge on 127.0.0.1                   │  launch/close Studio, focus window,
        │  (bearer-token auth)                              │  allowlisted shortcuts, screenshots,
        ▼  long-polling (plugins only make outbound calls)  │  .rbxlx place files
Roblox Studio Plugin (Luau) — one peer per DataModel:       │  (Windows / macOS / Linux backends)
   ├─ edit session            (building + Run-mode simulation)
   ├─ playtest server         (eval_server_runtime, server logs)
   └─ playtest client(s)      (eval_client_runtime, client logs)
        │  command executors + ChangeHistory waypoints      │
        ▼                                                   ▼
Roblox Studio (your open place) ◄───── OS window, process, keyboard, screen
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design, protocol, data flow, and security model.

## Quick start

### 1. Requirements

- [Node.js](https://nodejs.org) ≥ 18.17
- Roblox Studio
- An MCP client (Claude Desktop, Claude Code, Cursor, …)

### 2. Install & build

```bash
git clone https://github.com/Meganugger/roblox-studio-mcp.git
cd roblox-studio-mcp
npm install
npm run build
```

This builds the server, the shared package, and the Studio plugin artifact at
`studio-plugin/dist/RobloxStudioMCP.rbxmx`.

### 3. Install the Studio plugin

One command:

```bash
node server/dist/index.js --install-plugin
```

This copies the built plugin into your local Studio plugins folder
(**Windows:** `%LOCALAPPDATA%\Roblox\Plugins`, **macOS:** `~/Documents/Roblox/Plugins`;
override with `MCP_PLUGINS_DIR`). Fully close and reopen Studio afterwards.
Manual alternative: drop `studio-plugin/dist/RobloxStudioMCP.rbxmx` into the same folder.

### 4. Connect your AI client

Add the server to your MCP client config. **Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "roblox-studio": {
      "command": "node",
      "args": ["/absolute/path/to/roblox-studio-mcp/server/dist/index.js"]
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add roblox-studio -- node /absolute/path/to/roblox-studio-mcp/server/dist/index.js
```

More client configs in [`examples/client-configs/`](examples/client-configs/).

### 5. Pair Studio with the server

1. Start your MCP client — the server prints its **auth token** to stderr on startup
   (also saved at `~/.roblox-studio-mcp/token`).
2. In Roblox Studio, open your place and click the **MCP** toolbar button.
3. Paste the token into the widget and press **Connect**.
   (The plugin needs *Allow HTTP Requests*; it enables it for you when possible.)
4. Ask your AI: *"Check the Roblox Studio connection"* → it calls `get_studio_status`. ✅

### 6. Build a game

Try the acceptance prompt:

> **"Create a polished Roblox simulator game."**

If Studio is not even open, the agent starts by itself: `get_host_capabilities` →
`create_place_file` → `launch_studio` (see [docs/native-control.md](docs/native-control.md)).
Then it will lay out the map with `generate_terrain` + `create_instances_batch`, install data
profiles/currency/shop/quests/UI with `install_scaffold`, write game-specific scripts, then loop
`analyze_scripts → start_playtest → get_errors → fix → retest` until everything runs clean.
A full walkthrough lives in [`examples/simulator-game.md`](examples/simulator-game.md).

## Tool suite (68 tools)

| Category | Tools |
| --- | --- |
| Connection | `get_studio_status`, `get_connected_peers`, `ping_studio` |
| Explorer | `get_instance_tree`, `get_instance`, `get_instance_children`, `search_instances`, `create_instance`, `create_instances_batch`, `set_instance_properties`, `mass_set_properties`, `rename_instance`, `move_instance`, `clone_instance`, `delete_instance`, `get_selection`, `set_selection` |
| Scripts | `create_script`, `get_script_source`, `set_script_source`, `patch_script_source`, `search_script_source`, `find_and_replace_in_scripts`, `list_scripts`, `analyze_scripts` |
| Code execution | `run_luau`, `eval_server_runtime`, `eval_client_runtime` |
| Project | `get_project_info`, `save_project`, `export_project_snapshot` |
| Test & debug | `start_playtest`, `stop_playtest`, `get_playtest_state`, `get_output_logs`, `get_errors`, `clear_output_logs`, `set_log_breakpoint`, `list_log_breakpoints`, `clear_log_breakpoints` |
| World | `generate_terrain`, `clear_terrain`, `set_lighting`, `insert_asset`, `set_camera` |
| Game systems | `list_scaffolds`, `install_scaffold` |
| Reference | `get_roblox_docs` |
| Native host | `get_host_capabilities`, `get_studio_processes`, `launch_studio`, `close_studio`, `focus_studio_window`, `send_studio_shortcut`, `capture_studio_screenshot`, `start_play_solo`, `stop_play_solo` |
| Place files | `list_place_templates`, `create_place_file`, `open_place_file`, `list_place_files` |
| Publishing (Open Cloud) | `get_publish_capabilities`, `publish_place`, `get_universe_info`, `get_place_info`, `update_place_config`, `restart_universe_servers`, `publish_universe_message` |

Full reference with parameters and examples: [docs/tools.md](docs/tools.md).

## Runtime debugging (per-peer)

When the user starts a play-solo or multiplayer playtest (F5 / Test tab), Studio runs the plugin
inside **every** DataModel. Each auto-connects with the saved token as its own peer, so the agent can:

```
get_connected_peers                → edit + server + client:Player1 (+ client:Player2 …)
eval_server_runtime  code=…        → inspect live server state (e.g. MatchService round data)
eval_client_runtime  code=…        → inspect a client's PlayerGui / camera / character
get_output_logs      peer=server   → server-side logs incl. boot-time prints
get_errors           peer=client   → client-side errors with Luau stack traces
set_log_breakpoint   path=… line=… → instrument code without pausing, reproduce, read logs
```

Ask things like: *"Start reading the server logs, reproduce the hit, and tell me why the damage
function never fires"* — the agent sets a log breakpoint, reads per-peer logs, and fixes the code.

## Native host control (autonomous sessions)

The server can also operate Studio itself, so a session needs no human setup:

```
get_host_capabilities                              → what this OS allows, and how to fix gaps
create_place_file  name="PetSim" template=baseplate → a real .rbxlx on disk
launch_studio      placeFilePath="PetSim.rbxlx"     → Studio boots; plugin peer connects
…build with the Explorer / script / scaffold tools…
start_play_solo                                    → presses F5, waits for server+client peers
get_errors peer="server" · eval_server_runtime      → debug the live game
stop_play_solo · set_camera · capture_studio_screenshot → look at the result
save_project                                       → real Ctrl+S into the file
```

Security: two independent gates (`ROBLOX_MCP_ALLOW_NATIVE`, `ROBLOX_MCP_ALLOW_NATIVE_INPUT`), a
closed shortcut allowlist (no arbitrary key/text injection), window-title verification before
every keystroke, and place paths sandboxed to `ROBLOX_MCP_PLACES_ROOT`. Prerequisites per OS
(macOS Accessibility/Screen-Recording permissions, Linux `xdotool` + ImageMagick), the exact
commands each backend runs, and a manual acceptance checklist are in
[docs/native-control.md](docs/native-control.md).

## Publishing to Roblox (Open Cloud)

The agent can also ship the result, so the loop ends on the platform instead of on disk:

```
get_publish_capabilities                            → gate on? key loaded? right universe?
save_project                                        → real Ctrl+S writes the .rbxlx
publish_place  path="PetSim.rbxlx"                  → uploads a Saved version; players unaffected
publish_place  path="PetSim.rbxlx" versionType="Published"  → new servers get the build
restart_universe_servers                            → moves current players onto it
update_place_config  description="…"                → listing details
publish_universe_message topic="liveops" message="…" → MessagingService live-ops
```

Security: this is the only capability that reaches real players, so it is **disabled by default**.
It needs `ROBLOX_MCP_ALLOW_PUBLISH=1` plus an Open Cloud API key that you mint yourself — the
server never generates one, never prints it back (only a `sha256:` fingerprint), scrubs it from
error bodies, defaults to the non-releasing `Saved` version type, and honours a universe allowlist
(`ROBLOX_MCP_ALLOWED_UNIVERSES`) that bounds a broad key. Key creation, the required API-key
permissions, the rollout workflow and a manual acceptance checklist are in
[docs/publishing.md](docs/publishing.md).

## Remote URL access (URL-only AI platforms)

New to this? [docs/http-mode-quickstart.md](docs/http-mode-quickstart.md) is a start-to-finish
walkthrough: the two-ports/two-tokens model, setup, verification, and what to ask the agent for.

Some AI platforms can't spawn a local process and only accept an MCP **server URL**. Run:

```bash
node server/dist/index.js --transport http
```

This serves the full tool suite over Streamable HTTP at `http://127.0.0.1:3668/mcp`, protected by a
bearer token (printed on startup; persisted at `~/.roblox-studio-mcp/http-token`). Publish it with a
reverse tunnel — no inbound firewall holes, TLS terminated by the tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:3668     # or ngrok http 3668 / tailscale funnel 3668
```

Then give the platform `https://<your-tunnel-host>/mcp` with header
`Authorization: Bearer <http-token>`. Full guide, security model and provider comparison:
[docs/remote-access.md](docs/remote-access.md).

## Configuration

Environment variables read by the server:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ROBLOX_MCP_PORT` | `3667` | Local bridge port (127.0.0.1 only) |
| `ROBLOX_MCP_TOKEN` | auto-generated | Shared secret (≥ 16 chars) between server and plugin |
| `ROBLOX_MCP_TRANSPORT` | `stdio` | `stdio` \| `http` (same as `--transport`) |
| `ROBLOX_MCP_HTTP_PORT` | `3668` | Streamable HTTP MCP port (`--transport http`) |
| `ROBLOX_MCP_HTTP_HOST` | `127.0.0.1` | HTTP MCP bind host (keep local; use a tunnel to publish) |
| `ROBLOX_MCP_HTTP_TOKEN` | auto-generated | Bearer token for the HTTP MCP endpoint |
| `ROBLOX_MCP_HOME` | `~/.roblox-studio-mcp` | Where generated tokens are persisted |
| `ROBLOX_MCP_ALLOW_RUN_LUAU` | `1` | Set `0` to disable arbitrary code execution |
| `ROBLOX_MCP_ALLOW_INSERT_ASSET` | `1` | Set `0` to disable catalog asset insertion |
| `ROBLOX_MCP_ALLOW_NATIVE` | `1` | Set `0` to disable all native host control (launch/close Studio, window focus, shortcuts, screenshots) |
| `ROBLOX_MCP_ALLOW_NATIVE_INPUT` | `1` | Set `0` to disable keyboard-shortcut simulation only |
| `ROBLOX_MCP_STUDIO_PATH` | auto-detected | Explicit Roblox Studio executable path |
| `ROBLOX_MCP_PLACES_DIR` | `~/RobloxStudioMCP/places` | Where `create_place_file` writes new places |
| `ROBLOX_MCP_PLACES_ROOT` | home directory | Sandbox root: place tools refuse paths outside it |
| `ROBLOX_MCP_SCREENSHOT_DIR` | `~/.roblox-studio-mcp/screenshots` | Where screenshots are written |
| `ROBLOX_MCP_ALLOW_PUBLISH` | `0` | Set `1` to enable the Open Cloud publish tools (they reach live players) |
| `ROBLOX_MCP_OPEN_CLOUD_KEY` | *(none)* | Open Cloud API key; or write it to `~/.roblox-studio-mcp/open-cloud-key`. Never generated, never printed back |
| `ROBLOX_MCP_UNIVERSE_ID` | *(none)* | Default universe (experience) id for the publish tools |
| `ROBLOX_MCP_PLACE_ID` | *(none)* | Default place id for the publish tools |
| `ROBLOX_MCP_ALLOWED_UNIVERSES` | *(any)* | Comma-separated universe allowlist; other universes are refused even if the key can reach them |
| `ROBLOX_MCP_MAX_PLACE_UPLOAD_BYTES` | `104857600` | Upload size limit for `publish_place` |
| `ROBLOX_MCP_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `MCP_PLUGINS_DIR` | OS default | Override Studio plugins folder for `--install-plugin` |

## Repository layout

```
server/         MCP server: tools, HTTP bridge, auth, scaffold library, native host + Open Cloud layers (TypeScript)
studio-plugin/  Roblox Studio plugin: bridge loop, executors, UI (Luau, Rojo-compatible)
shared/         Wire protocol, command names, property encoding (TypeScript)
scripts/        Plugin packer (source tree → .rbxmx)
tests/          Vitest suite incl. full-stack MCP + bridge integration tests
docs/           Installation, HTTP-mode quickstart, usage, tool reference, native control, publishing, troubleshooting
examples/       Client configs, prompt playbooks, simulator-game walkthrough
```

## Development

```bash
npm run typecheck   # strict TS across workspaces
npm test            # 222 tests: unit, native backends (per-OS argv), Open Cloud wire format,
                    # multi-peer bridge, HTTP transport, full-stack MCP client, live X11
npm run build       # server + shared + plugin artifact
npm run smoke       # boot the built server over real HTTP and exercise the tool surface
```

CI runs the whole suite on **Ubuntu, Windows and macOS**; the Linux job runs under Xvfb so the
native window/input/screenshot code is exercised against a real X display instead of being
skipped.

The plugin sources are Rojo-compatible (`studio-plugin/default.project.json`), so
`rojo build studio-plugin -o RobloxStudioMCP.rbxmx` produces an equivalent artifact if you
prefer the Rojo toolchain. Every Luau file (plugin + all generated scaffold code) compiles
clean with the official Luau compiler; the test suite verifies this when `luau-compile`
is available.

## Troubleshooting

Common issues (plugin won't connect, HTTP disabled, token mismatch, port conflicts,
playtest caveats) are covered in [docs/troubleshooting.md](docs/troubleshooting.md).

## Prior art & attribution

This project builds on the architecture proven by
[Roblox/studio-rust-mcp-server](https://github.com/Roblox/studio-rust-mcp-server) (official, Rust)
and [boshyxd/robloxstudio-mcp](https://github.com/boshyxd/robloxstudio-mcp) (TypeScript) —
in particular the stdio-MCP + local-HTTP-bridge + long-polling-plugin pattern that works within
Roblox Studio's outbound-only HTTP constraint. The per-peer runtime-debugging model (one plugin
peer per playtest DataModel) was pioneered by
[Chrrxs/robloxstudio-mcp](https://github.com/Chrrxs/robloxstudio-mcp). This implementation is
written from scratch and combines those ideas with token authentication, atomic batch building,
a script patch/refactor toolchain, an autonomous test/debug loop, log breakpoints, official-docs
lookup, a Streamable HTTP transport for URL-only platforms, a production gameplay scaffold
library, and a native host layer (Studio launching, window control, screenshots, real play
sessions) that makes a session fully autonomous.

Implementation status, including what is deliberately *not* implemented, is tracked in
[ROADMAP.md](ROADMAP.md).

## License

[MIT](LICENSE)
