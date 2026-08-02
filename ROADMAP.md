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

### v3.0.0 — Native host control (61 tools)

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

### v4.0.0 — Publishing to Roblox (68 tools) — **this release**

The one item v3.0.0 listed as not implemented that was a capability gap rather than a hard
blocker:

| Deferred item (v3.0.0 report) | Status in v4.0.0 |
| --- | --- |
| Publishing to Roblox (Publish to Roblox / place management API) | Implemented behind an opt-in gate. `publish_place` uploads a local `.rbxlx`/`.rbxl` as a new place version through Open Cloud; `get_universe_info` / `get_place_info` / `update_place_config` read and change the experience's configuration; `restart_universe_servers` rolls a build out to live players; `publish_universe_message` sends MessagingService live-ops messages. `get_publish_capabilities` reports the gate, the key (fingerprint only), the defaults, the allowlist and the exact API-key permission each tool needs. |

The v3.0.0 report called this "a security decision that belongs to the user". That is still the
position — it is now expressed as configuration instead of absence:

- **Off by default.** `ROBLOX_MCP_ALLOW_PUBLISH` must be `1`. This is the only gate in the project
  that defaults to off, because it is the only capability whose effects reach people other than the
  operator.
- **The user's own credential, never generated.** Both bridge tokens auto-generate when missing; an
  Open Cloud API key deliberately does not. It is read from `ROBLOX_MCP_OPEN_CLOUD_KEY` or
  `~/.roblox-studio-mcp/open-cloud-key` and absence is a reported state, not an error.
- **The key never leaves the process.** Tool results, logs and error messages carry at most a
  `sha256:` fingerprint; Roblox response bodies are scrubbed of the key before being surfaced.
- **Safe default release mode.** `publish_place` defaults to `versionType: "Saved"`, which uploads
  without releasing. Releasing (`Published`) and disrupting live players
  (`restart_universe_servers`) are separate, explicit steps.
- **Bounded blast radius.** `ROBLOX_MCP_ALLOWED_UNIVERSES` refuses any other universe even when the
  API key could reach it; uploads reuse the place-path sandbox and are format- and size-checked
  before a byte is sent.

Supporting work: a `cloud/` layer built like the native one — one injectable `CloudHttpClient` port,
so every URL, header and body is asserted in tests with no network and no credentials — HTTP-status
mapping that turns 401/403/404/429 into the actual fix (revoked key, missing permission *or* the
key's IP allowlist, wrong universe id, per-universe rate limit with its `Retry-After`), the first
tests for `config.ts`, and 72 new tests (150 → 222) covering the wire format of every endpoint, the
gate, the allowlist, key redaction, upload validation and the full tool surface. The smoke test now
also proves that a default install really cannot publish.

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
- **Publishing without the user's consent.** Implemented in v4.0.0, but deliberately not enabled by
  installing this server: it needs `ROBLOX_MCP_ALLOW_PUBLISH=1` and an API key the user mints
  themselves. See the v4.0.0 notes above.
- **Rolling back a published version.** Roblox place versions are immutable and Open Cloud exposes
  no "revert to version N" call, so the only real rollback is publishing the older content forward.
  A tool that pretended otherwise would be lying about what happened.
- **Reading live DataStore contents, analytics or moderation APIs.** Open Cloud offers these, but
  they are unrelated to building a game in Studio and each one widens the API key's required
  permissions. `eval_server_runtime` already inspects live state during a playtest.
- **Uploading assets (models, images, audio) via Open Cloud.** The asset-upload API needs its own
  permissions and moderation handling, and the agent's authoring path is
  `create_instances_batch` / `insert_asset`, not the asset library. Not needed for the build loop.
- **Running Roblox Studio on Linux.** Studio has no Linux build. The Linux backend exists so
  the server can be developed, tested and hosted on Linux (and drive a Wine/Proton install via
  `ROBLOX_MCP_STUDIO_PATH`), but Roblox does not ship a native Linux Studio.

## Verification boundary

CI runs on GitHub's Ubuntu, Windows and macOS runners — none of which has Roblox Studio
installed. What is verified, and what is not:

**Verified automatically (222 tests + a smoke test, on all three OSes):**

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
- Every Open Cloud request the server would send: exact method, URL, headers and body for
  publishing (both `versionType`s, XML vs binary content types), universe/place reads, the
  `updateMask` PATCH, `:restartServers` and `:publishMessage` — through the injected transport, so
  no network access or real credential is involved. Plus the publishing gate, the universe
  allowlist, upload format/size validation, the mapping of every documented failure status to its
  fix, and that the API key never appears in a status report, log line or error body.
- That a default install cannot publish: the smoke test boots the built server with no publishing
  configuration and asserts the gate is off, no key was invented, and `publish_place` refuses.
- **Live transport verification:** the real `fetch`-based Open Cloud transport runs over real TCP
  against a local HTTP server - headers actually arriving, a binary place body surviving
  byte-for-byte, response status/header parsing, timeouts and unreachable hosts.
- **Live OS verification on Linux:** under Xvfb, the real process runner drives a real X11 window
  titled like Studio — window discovery, activation (including the no-window-manager fallback),
  real keystroke delivery, and real PNG capture/downscale verified by PNG signature.

**Not verifiable here (needs a machine with Studio installed):**

- That a real Roblox Studio window responds to the synthesized shortcuts (F5/Shift+F5/Ctrl+S).
- That the generated `.rbxlx` opens cleanly in a real Studio.
- macOS Accessibility / Screen Recording permission prompts.

**Not verifiable here (needs a Roblox account, an experience and an Open Cloud API key):**

- That Roblox accepts a generated `.rbxlx` through the publish endpoint and the version appears in
  the Creator Dashboard.
- That a `Published` version is what new servers load, and that `restart_universe_servers` moves
  live players onto it.
- That a real API key with the documented permissions is accepted (and that a key missing one, or
  used from outside its IP allowlist, produces the 403 the error text describes).

CI has no Roblox account, so these are covered by manual checklists instead:
[docs/native-control.md](docs/native-control.md) has a 10-step checklist for the native layer, and
[docs/publishing.md](docs/publishing.md) a 10-step one for publishing.
