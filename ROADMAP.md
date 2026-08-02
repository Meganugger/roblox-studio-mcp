# Roadmap & implementation status

This file is the honest, verifiable record of what is implemented and what is not.

## Shipped

### v1.0.0 — MCP core (39 tools)

- MCP server (Node + TypeScript) with stdio transport.
- Local HTTP bridge on `127.0.0.1` with constant-time bearer-token auth, long polling
  (Studio plugins can only make outbound requests), protocol-version pinning.
- Roblox Studio plugin (Luau): dock widget, persisted token/port, auto-reconnect with
  backoff, command executors, undo waypoints, protected-container guards.
- Explorer control, script management (create/read/replace/patch/grep/list/compile-analyze),
  `run_luau`, project inspection/export, playtest control, output/error capture with Luau
  stack traces, terrain/lighting/asset/camera tools.
- Scaffold library: 13 production Luau game systems installed in one dependency-resolved,
  idempotent command.

### v2.0.0 — Runtime debugging & remote access (48 tools)

- Protocol v2 multi-peer sessions: every DataModel (edit, playtest server, each playtest
  client) connects as its own peer with an independent command queue and log buffer.
- `get_connected_peers`, `eval_server_runtime`, `eval_client_runtime`, per-peer
  `get_output_logs` / `get_errors` / `get_playtest_state` / `ping_studio` / `run_luau`.
- Log breakpoints (non-pausing instrumentation), bulk editing (`mass_set_properties`,
  `find_and_replace_in_scripts`), official Roblox docs lookup (`get_roblox_docs`).
- Streamable HTTP MCP transport (`--transport http`) for URL-only AI platforms, plus
  `--install-plugin`, `--print-token`, `--help`.

### v3.0.0 — Native host control (61 tools) — **this release**

Everything v2.0.0 explicitly deferred as "requires native OS integration":

| Deferred item (v2.0.0 report) | Status in v3.0.0 |
| --- | --- |
| Viewport screenshots | `capture_studio_screenshot` — captures the Studio window (or full screen) to PNG and returns it as an MCP **image** block so the agent can *see* the viewport. Downscaled server-side. |
| OS-level input simulation | `send_studio_shortcut` — allowlisted Studio shortcuts (play / run / stop / save / save-as / undo / redo / escape / confirm) delivered to the verified Studio window only. |
| Managed Studio window launching | `launch_studio`, `close_studio`, `focus_studio_window`, `get_studio_processes` — discover the Studio executable, launch it (optionally with a place file or `placeId`), wait for the plugin peer to connect, close it gracefully. |
| "open project" / "create project" (original spec, Project Control) | `open_place_file`, `create_place_file` (generates real `.rbxlx` places from `baseplate` / `flat` / `empty` templates), `list_place_files`. |
| Autonomous *player* testing (previously required the user to press F5) | `start_play_solo` / `stop_play_solo` — drive a real play session natively and wait for the playtest server/client peers, which unlocks `eval_server_runtime` / `eval_client_runtime` without any human action. |
| Native save (plugins cannot save silently) | `save_project` now sends the real Ctrl+S / ⌘S to Studio when native input is available and falls back to the in-Studio notification. |
| Reproducible dependency install (lockfile was untracked) | `package-lock.json` is committed; CI uses `npm ci`. |
| CI red on a fresh clone (`typecheck` ran before `shared` was built) | Fixed: `npm run typecheck` builds the `shared` declarations first. |

Supporting work: `get_host_capabilities` and `get_studio_processes` (honest per-OS capability
report with fix hints), `list_place_templates`, Windows / macOS / Linux backends behind one
injectable interface, security gates (`ROBLOX_MCP_ALLOW_NATIVE`,
`ROBLOX_MCP_ALLOW_NATIVE_INPUT`), place-path sandboxing (`ROBLOX_MCP_PLACES_ROOT`), and 88 new
tests (62 → 150) covering every backend's exact command lines, the shortcut allowlist,
place-file generation and XML structure, path sandboxing, and a live-X11 suite that verifies
window control, keystroke delivery and PNG capture against a real display. CI now runs on
Ubuntu + Windows + macOS and adds a smoke test of the built server.

## Not implemented (and why)

- **Free-form keyboard/mouse injection.** Deliberately excluded. Only the named shortcut
  allowlist is exposed, and only after the target window is verified to be Roblox Studio.
  Arbitrary input injection would turn the MCP server into a remote-control trojan for the
  whole desktop; the Luau/instance tools already cover legitimate authoring needs.
- **Reading Studio's internal UI state (dialogs, docked panels, ribbon).** Roblox exposes no
  API for it and OCR-on-screenshot is unreliable. The agent uses `capture_studio_screenshot`
  and reasons about the image instead.
- **Silent place saving without user consent from inside the plugin.** Roblox intentionally
  forbids it. v3.0.0 works around this with a real OS keystroke (`save_project`), which is
  the same action a human performs.
- **Publishing to Roblox (Publish to Roblox / place management API).** Requires the user's
  Open Cloud API key and publishing permissions; out of scope for a local Studio bridge and
  a security decision that belongs to the user. `save_project` covers local persistence.
- **Running Roblox Studio on Linux.** Studio has no Linux build. The Linux backend exists so
  the server can be developed, tested and hosted on Linux (and drive a Wine/Proton install via
  `ROBLOX_MCP_STUDIO_PATH`), but Roblox does not ship a native Linux Studio.

## Verification boundary

CI runs on GitHub's Ubuntu, Windows and macOS runners — none of which has Roblox Studio
installed. What is verified, and what is not:

**Verified automatically (150 tests + a smoke test, on all three OSes):**

- Every backend's exact command construction — Studio discovery (including the Windows registry
  fallback), launch task arguments, key translation for every allowlisted shortcut, capture and
  downscale invocations, close/force-close — through injected process/file-system ports, so the
  Windows and macOS command lines are asserted even when the tests run on Linux.
- Both security gates, the shortcut allowlist, window-title refusal, place-path sandbox escapes,
  extension rules and overwrite protection.
- Generated `.rbxlx` places, parsed with a real XML parser and asserted structurally.
- The whole MCP surface through a real MCP client (in-memory and over real TCP to the Streamable
  HTTP endpoint) with a byte-accurate simulated plugin, including the launch → wait-for-peer,
  play-solo → wait-for-peers, screenshot-as-image and native-save flows.
- **Live OS verification on Linux:** under Xvfb, the real process runner drives a real X11 window
  titled like Studio — window discovery, activation (including the no-window-manager fallback),
  real keystroke delivery, and real PNG capture/downscale verified by PNG signature.

**Not verifiable here (needs a machine with Studio installed):**

- That a real Roblox Studio window responds to the synthesized shortcuts (F5/Shift+F5/Ctrl+S).
- That the generated `.rbxlx` opens cleanly in a real Studio.
- macOS Accessibility / Screen Recording permission prompts.

[docs/native-control.md](docs/native-control.md) contains a 10-step manual acceptance checklist
that covers exactly these points.
