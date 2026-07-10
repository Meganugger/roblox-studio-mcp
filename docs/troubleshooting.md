# Troubleshooting

## The plugin won't connect

**Symptom:** widget stays "Connecting…" or "Disconnected".

1. **Is the server running?** Your MCP client launches it on demand — open the client
   and check its MCP logs for `Roblox Studio MCP server ready`. Or probe manually:
   `curl http://127.0.0.1:3667/health` → `{"ok":true,...}`.
2. **Port mismatch.** The widget's port must equal the server's `ROBLOX_MCP_PORT`
   (default 3667).
3. **HTTP requests disabled.** Status shows **HTTP disabled** → the plugin tried to
   enable `Allow HTTP Requests` and couldn't. Enable it manually:
   *Game Settings → Security → Allow HTTP Requests* (the place must be saved/published
   for Game Settings to open).
4. **Firewall/VPN software** intercepting localhost is rare but possible — allowlist
   `127.0.0.1:3667`.

## "Auth failed" in the widget

The token in the widget doesn't match the server's token.

- The server prints the token to stderr at startup and persists it in
  `~/.roblox-studio-mcp/token` — copy it from either place.
- If you set `ROBLOX_MCP_TOKEN` in the client config, use that exact value.
- Tokens must be ≥ 16 characters; the widget refuses shorter ones.

## Tools return "Roblox Studio plugin is not connected"

The server is fine but no plugin has polled recently (45 s window).

- Open Studio with a place, click **MCP**, and Connect.
- One server pairs with one Studio session; if two Studios connect, they will compete
  for commands — run one at a time (or run a second server on a different port).

## "Command … timed out"

- Studio was busy (modal dialog, script editor popup, heavy computation). Dismiss
  dialogs and retry.
- Very large operations: raise the caller-controlled timeout (`run_luau`), reduce batch
  size, or lower `maxNodes` on tree/snapshot calls.
- If Studio crashed, the plugin reconnects automatically once Studio is reopened.

## `EADDRINUSE` / server exits at startup

Another process owns the port (often a second MCP client instance).

- Stop the other instance, or set `ROBLOX_MCP_PORT` to a free port (and update the
  plugin widget to match).

## Playtest quirks

- `start_playtest` uses **Run mode** (`RunService:Run()`): server scripts + physics run,
  but there is no player character. Test character-dependent logic via code review and
  `run_luau` probes of the same server APIs.
- Changes made by scripts during Run mode **persist** after `stop_playtest` — the run
  happens in the edit DataModel. Undo (the plugin records waypoints) or account for the
  changes when verifying.
- DataStores are unavailable in unpublished places / when *Enable Studio Access to API
  Services* is off. Scaffold services detect this and fall back to in-memory profiles
  with a warning, so gameplay still works during development.

## No server/client peers during a playtest

- Playtest peers (`eval_server_runtime`, `peer="server"/"client"`) only appear for
  **play-solo / multiplayer tests** started from Studio's Play/Test buttons — not for
  `start_playtest` (Run mode stays on the edit peer).
- The playtest DataModels auto-connect using the token **saved by the edit-mode widget**;
  connect once from the widget first, then start the playtest.
- Studio must allow HTTP requests in the play session (same *Allow HTTP Requests* setting).
- Check `get_connected_peers`; peers appear a few seconds after the playtest starts. If a
  client is missing, make sure the plugin is installed locally (not only enabled per-place).

## Logs are empty

- Log capture starts when the plugin loads; output from before that isn't captured.
- Use the `logSeq` returned by `start_playtest` as `sinceSeq` so you only read fresh
  entries; `clear_output_logs` resets the buffer between test runs.

## Type errors from luau-analyze in CI or editors

Plugin sources use Roblox globals (`game`, `plugin`, `task`); analysis without Roblox
type definitions flags them as unknown. Compilation (`luau-compile`) is the correctness
gate used by tests/CI. For editor analysis, use
[luau-lsp](https://github.com/JohnnyMorganz/luau-lsp) with Roblox definitions.

## Where do errors show up?

| Layer | Where to look |
| --- | --- |
| MCP tool errors | Returned directly to the agent (marked `isError`) with actionable text |
| Studio-side failures | Same, including Luau stack traces |
| Server internals | stderr (`ROBLOX_MCP_LOG_LEVEL=debug` for verbose) |
| Plugin internals | Studio Output window, prefixed `[RobloxStudioMCP]` |

## Resetting to a clean state

1. Disconnect in the widget; close Studio.
2. Delete `~/.roblox-studio-mcp/` (forces a fresh token).
3. Restart the MCP client, copy the new token into the widget, reconnect.
