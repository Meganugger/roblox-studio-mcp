# Roblox Studio MCP — Studio plugin

The Luau half of the system: connects Roblox Studio to the local MCP server, executes
commands, captures output, and reports results.

## Install (prebuilt)

`npm run build:plugin` at the repo root produces `dist/RobloxStudioMCP.rbxmx`, then:

```bash
node server/dist/index.js --install-plugin
```

copies it into your Studio plugins folder automatically (Windows:
`%LOCALAPPDATA%\Roblox\Plugins\`, macOS: `~/Documents/Roblox/Plugins/`, override with
`MCP_PLUGINS_DIR`). Fully close and reopen Studio afterwards.

## Build with Rojo (optional)

```bash
rojo build . -o RobloxStudioMCP.rbxmx
```

`default.project.json` maps `src/` to the plugin tree; both build paths produce
equivalent artifacts.

## Module map

| Module | Purpose |
| --- | --- |
| `Main.server.luau` | Entry: full UI in edit mode; headless auto-connect inside playtest DataModels |
| `Bridge.luau` | Session identity + context detection, handshake, long-poll loop, backoff reconnect, result delivery |
| `Executors/` | Command handlers (instances, scripts, run-code, project, playtest, breakpoints, world) |
| `Serialization.luau` | Property value encode/decode (mirror of `shared/src/properties.ts`) |
| `PathResolver.luau` | `game.Workspace.Foo` paths ⇆ instances, `Name[n]` disambiguation |
| `OutputCapture.luau` | LogService/ScriptContext ring buffer for logs and stack traces |
| `UI.luau` | Toolbar button + dock widget (status, token, port, notifications) |
| `Config.luau` / `Logger.luau` | Constants and prefixed logging |

## Behavior notes

- During play-solo / multiplayer tests, Studio runs the plugin in every DataModel; each
  instance auto-connects with the saved token as an independent `server` / `client` peer
  (no UI), enabling live runtime evaluation and per-peer log capture.
- All mutations record ChangeHistory waypoints (`MCP: …`) so users can undo agent work.
- Protected containers (game, core services) refuse deletion/renaming.
- The bridge only talks to `127.0.0.1` and sends the bearer token on every request.
- The plugin persists token/port via `plugin:SetSetting` and reconnects automatically
  with exponential backoff (1 s → 15 s).
- Keep `PROTOCOL_VERSION` in `Config.luau` in sync with `shared/src/protocol.ts`;
  the server rejects mismatched plugins at handshake.
