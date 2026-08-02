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

## Native host control problems

Native tools (`launch_studio`, `capture_studio_screenshot`, `send_studio_shortcut`,
`start_play_solo`, native `save_project`) touch the OS, so their failures are host-specific.
**Always run `get_host_capabilities` first** — it reports each capability with the exact fix.

| Message | Fix |
| --- | --- |
| `Native host control is disabled … ROBLOX_MCP_ALLOW_NATIVE=1` | The kill switch is off; set it to `1` and restart the server |
| `Input simulation is disabled … ROBLOX_MCP_ALLOW_NATIVE_INPUT=0` | Shortcuts/play/native-save are blocked by config |
| `Roblox Studio was not found on this machine` | Set `ROBLOX_MCP_STUDIO_PATH` to the Studio executable (Windows) or `.app` (macOS) |
| `No Roblox Studio window was found` | Studio is closed or minimized; run `launch_studio` or restore the window |
| `Refusing to send input: the focused window is "…"` | Another window has focus, or a non-Studio window matched; retry (each attempt re-focuses Studio) |
| `macOS blocked the automation request` | Grant **Accessibility** (keystrokes) / **Screen Recording** (screenshots) to the process running the server |
| Windows: `inputSimulation.available: false` | PowerShell 7 without .NET Windows Desktop; use `powershell.exe` (5.1) or install the runtime |
| Linux: `xdotool is not installed` / `No screenshot tool found` | `apt install xdotool imagemagick`; an X display is required (Wayland needs XWayland) |
| `Refusing to touch … outside the allowed place directory` | The path escapes `ROBLOX_MCP_PLACES_ROOT`; use a path inside it or widen the sandbox |

### Studio launches but no peer connects

`launch_studio` reports `pluginConnected: false`. In order:

1. Is the plugin installed? `node server/dist/index.js --install-plugin`, then fully restart Studio.
2. Has the plugin ever been connected? Playtest DataModels and freshly launched Studios
   auto-connect using the **saved** token — connect once from the MCP widget in edit mode.
3. Did the place finish loading? Large places exceed the default wait; raise `timeoutMs`.
4. Is a dialog blocking Studio? `capture_studio_screenshot { fullScreen: true }`, then
   `send_studio_shortcut escape`.

### `save_project` says Studio stopped responding

Ctrl+S on a place that has never been saved opens Studio's **Save As** dialog, which blocks the
plugin. `send_studio_shortcut escape` cancels it. Create places with `create_place_file` (they
already have a file, so saving is silent), or have the user save once manually.

### `start_play_solo` returns `running: false`

Studio never entered play mode. Check for a modal dialog (screenshot with `fullScreen: true`),
confirm `inputSimulation` is available, and make sure the plugin has a saved token so the
playtest DataModels can auto-connect.

## Where do errors show up?

| Layer | Where to look |
| --- | --- |
| MCP tool errors | Returned directly to the agent (marked `isError`) with actionable text |
| Studio-side failures | Same, including Luau stack traces |
| Server internals | stderr (`ROBLOX_MCP_LOG_LEVEL=debug` for verbose) |
| Plugin internals | Studio Output window, prefixed `[RobloxStudioMCP]` |

## Resetting to a clean state

1. Disconnect in the widget; close Studio (`close_studio`, or force if it is wedged).
2. Delete `~/.roblox-studio-mcp/` (forces a fresh token; also clears saved screenshots).
3. Restart the MCP client, copy the new token into the widget, reconnect.
