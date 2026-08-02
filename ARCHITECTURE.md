# Architecture

## System overview

```
┌────────────────────┐  stdio ── or ── Streamable HTTP /mcp  ┌──────────────────────────┐
│  AI Agent           │◄──────────────────────────────────────►│  MCP Server (Node.js)     │
│  Claude / Cursor /  │        (bearer token in HTTP mode)     │  ┌────────────────────┐  │
│  URL-only platforms │                                        │  │ Tool layer (68)    │  │
└────────────────────┘                                        │  │ zod validation     │  │
                                                               │  └─────────┬──────────┘  │
                                                               │            ▼             │
                                                               │  ┌────────────────────┐  │
                                                               │  │ SessionRegistry    │  │
                                                               │  │ 1 CommandQueue per │  │
                                                               │  │ peer (FIFO+timeout)│  │
                                                               │  └─────────┬──────────┘  │
                                                               │            ▼             │
                                                               │  ┌────────────────────┐  │
                                                               │  │ HTTP bridge        │  │
                                                               │  │ 127.0.0.1:3667     │  │
                                                               │  │ Bearer-token auth  │  │
                                                               │  └─────────▲──────────┘  │
                                                               └────────────┼─────────────┘
                                       long-poll GET /plugin/poll?session=…│POST /plugin/result?session=…
                                              ┌─────────────────────────────┼─────────────────────────────┐
                                              │                             │                             │
                                   ┌──────────┴─────────┐       ┌──────────┴─────────┐       ┌──────────┴─────────┐
                                   │ Plugin peer: edit  │       │ Plugin peer: server│       │ Plugin peer: client│
                                   │ UI + build tools   │       │ (playtest DM,      │       │ (playtest DM,      │
                                   │ + Run-mode sim     │       │  headless connect) │       │  headless connect) │
                                   └──────────┬─────────┘       └──────────┬─────────┘       └──────────┬─────────┘
                                              ▼                             ▼                             ▼
                                      edit DataModel              play-server DataModel          play-client DataModel

           ┌──────────────────────────────────────────────────────────────────────────────────┐
           │ Native host layer (same MCP server process, no plugin involved)                   │
           │   Windows: PowerShell + user32.dll + SendKeys + GDI+                              │
           │   macOS:   open + AppleScript/System Events + screencapture + sips                │
           │   Linux:   xdotool + ImageMagick (dev/test host; Studio has no Linux build)        │
           │   → launch/close Studio · focus window · allowlisted shortcuts (F5/Shift+F5/⌘S…)  │
           │     · window & screen capture (PNG → MCP image) · .rbxlx place file generation     │
           └──────────────────────────────────────────────────────────────────────────────────┘

           ┌──────────────────────────────────────────────────────────────────────────────────┐
           │ Open Cloud layer (same process; outbound HTTPS to apis.roblox.com)                │
           │   publish a place version (Saved / Published) · universe & place config           │
           │   restart live servers · MessagingService publish                                 │
           │   → gated off by default; user-supplied API key; universe allowlist                │
           └──────────────────────────────────────────────────────────────────────────────────┘
```

### Multi-peer sessions (protocol v2)

When the user starts a play-solo or multiplayer test, Studio boots additional DataModels
(one server, one per client) and runs the plugin in each. Every plugin instance generates a
unique `sessionId` at load time, detects its context (`edit` / `server` / `client` via
`RunService`), and connects as its own **peer**: playtest peers skip the UI and auto-connect
with the token saved from the edit session. The `SessionRegistry` keeps an independent
command queue per peer, and every tool that supports it takes a `peer` selector — this is
what powers `eval_server_runtime`, `eval_client_runtime`, per-peer logs, and multiplayer
debugging. Run-mode simulations (`start_playtest`) run inside the edit DataModel, so they
stay on the edit peer.

### Why long polling?

Roblox Studio plugins can only make **outbound** HTTP requests — they cannot host a
server or accept inbound connections. The proven pattern (used by Roblox's official MCP
server and other mature implementations) is therefore:

1. The MCP server embeds a small HTTP server bound to `127.0.0.1`.
2. The plugin long-polls `GET /plugin/poll`; the bridge holds the request open
   (up to 15 s) until a command is queued, then returns it.
3. The plugin executes the command and posts the outcome to `POST /plugin/result`.
4. The bridge resolves the pending MCP tool call with that result.

This yields low-latency, bidirectional-feeling communication with zero inbound
connectivity requirements and no websocket dependency inside Studio.

## Components

### `shared/` — protocol package (`@roblox-studio-mcp/shared`)

Single source of truth for:

- **Endpoints & envelopes** (`protocol.ts`): `BridgeCommand {id, name, payload, timeoutMs}`,
  `BridgeResult {id, ok, result | error{message, stack}}`, handshake types, timing constants,
  `PROTOCOL_VERSION` (mismatches are rejected at handshake with HTTP 409).
- **Command names** (`commands.ts`): the canonical list mirrored 1:1 by the plugin dispatcher.
- **Property encoding** (`properties.ts`): JSON encoding for Roblox values (below).

### `server/` — MCP server

| Module | Responsibility |
| --- | --- |
| `index.ts` | Entrypoint + CLI (`--transport`, `--install-plugin`, `--print-token`); graceful shutdown |
| `config.ts` | Env config; secret resolution (env → persisted file → generated) for both tokens; Open Cloud key resolution (env → persisted file → **absent**, never generated) |
| `bridge/auth.ts` | Constant-time bearer-token verification |
| `bridge/command-queue.ts` | FIFO queue bridging async tool calls to a polling peer; per-command timeouts; shutdown rejection |
| `bridge/sessions.ts` | SessionRegistry: peer lifecycle, selector resolution (`edit`/`server`/`client`/sessionId), pruning |
| `bridge/http-bridge.ts` | `/health`, `/plugin/hello`, `/plugin/poll`, `/plugin/result` with per-session routing; body-size limits |
| `transport/http-mcp.ts` | Streamable HTTP MCP endpoint (`/mcp`, stateless, bearer auth) for URL-only clients |
| `install-plugin.ts` | OS-aware Studio plugin installer (`--install-plugin`, `MCP_PLUGINS_DIR`) |
| `mcp/server.ts` | McpServer assembly + agent-facing usage instructions |
| `mcp/tools/*` | 68 tools grouped by domain; zod input schemas; readable error surfaces; `docs.ts` fetches official engine reference; `native.ts`/`places.ts` expose the native host layer; `publish.ts` exposes the Open Cloud layer |
| `scaffolds/*` | Production Luau gameplay templates + dependency-resolved install planner |
| `native/host.ts` | `NativeHost` facade: security gates, shortcut allowlist, screenshot storage/inlining, capability report |
| `native/backends/*` | One `NativeBackend` per OS (`windows.ts`, `macos.ts`, `linux.ts`) |
| `native/runner.ts` | `execFile`-based process runner (never a shell) + the small file-system port both are injectable for tests |
| `native/places.ts` | `.rbxlx` place generation from templates, place inspection, path sandboxing |
| `native/shortcuts.ts` | The closed allowlist of Studio shortcuts, translated per platform |
| `cloud/open-cloud.ts` | `OpenCloudClient` facade: publishing gate, API-key handling/redaction, universe allowlist, upload validation, HTTP-status → fix-hint mapping |
| `cloud/http.ts` | `fetch`-based HTTPS transport behind the injectable `CloudHttpClient` port |

**Tool call lifecycle:** MCP call → zod validation → connectivity check (fast, readable
failure if Studio is offline) → `queue.dispatch(name, payload, timeout)` → command delivered
to plugin poll → executed in Studio → result posted back → promise resolves → JSON returned
to the agent. Studio-side errors come back with the Luau stack trace attached so the agent
can debug what happened.

### `studio-plugin/` — Luau plugin (Rojo-compatible)

| Module | Responsibility |
| --- | --- |
| `Main.server.luau` | Context-aware wiring: full UI in edit mode; headless auto-connect in playtest DataModels |
| `Bridge.luau` | Session identity (GUID) + context detection, handshake, long-poll loop with `?session=`, exponential backoff reconnect (1→15 s), 409 re-handshake, result delivery with retries, status events |
| `Executors/init.luau` | Command dispatcher (merges per-domain handler tables; rejects unknown commands) |
| `Executors/Instances.luau` | Tree/read/search/create/batch/set/mass-set/rename/move/clone/delete/selection; protected-container guard; undo waypoints |
| `Executors/Scripts.luau` | Script CRUD, exact-match patch edits (atomic), project-wide find/replace with dry-run, source search, compile analysis via `loadstring` |
| `Executors/Breakpoints.luau` | Marker-tagged log breakpoints: insert / list / clear non-pausing instrumentation |
| `Executors/RunCode.luau` | Sandboxed `loadstring` execution: print/warn capture, timeout + `task.cancel`, serialized return values |
| `Executors/Project.luau` | Status, project info, save request notification, bounded project snapshot export |
| `Executors/Playtest.luau` | `RunService:Run()/Stop()` control + log retrieval |
| `Executors/World.luau` | Terrain (block/ball/Perlin hills with responsiveness yields), lighting presets, `InsertService` with script stripping, camera |
| `Serialization.luau` | Mirror of the shared property encoding; script source via `ScriptEditorService` |
| `PathResolver.luau` | Path ⇆ instance translation with `Name[n]` disambiguation and helpful not-found errors |
| `OutputCapture.luau` | `LogService.MessageOut` + `ScriptContext.Error` ring buffer (5000 entries, monotonic `seq`) |
| `UI.luau` | Toolbar button + dock widget: status, token/port inputs (persisted via plugin settings), connect toggle, save-request notifications |

### `server/src/native/` — native host layer

The plugin bridge can do everything *inside* an open place, but it cannot open Studio, press
Play, save the file, or show the agent what the viewport looks like: Roblox intentionally gives
plugins no access to the OS. The native layer covers exactly that gap, from the server process.

```
NativeHost (gates, allowlist, screenshot storage, capability report)
   └── NativeBackend  ── WindowsBackend | MacBackend | LinuxBackend
          ├── CommandRunner   (execFile, argv arrays, no shell)
          └── HostFileSystem  (exists/readDir/stat/read/write/mkdirp)
```

Design decisions:

- **Ports, not globals.** Backends receive `CommandRunner`, `HostFileSystem` and an `env` map,
  so tests assert the exact program + argv each platform would run — on any OS. This is why the
  Windows and macOS backends are fully covered by tests executed on Linux.
- **Fixed scripts, data in the environment.** The Windows backend runs one PowerShell toolkit
  passed as `-EncodedCommand` (base64/UTF-16LE) with a `MCP_MODE` switch; the destination path,
  keystroke and flags arrive as environment variables. No agent-supplied string is ever
  interpolated into a script or command line.
- **Keystrokes are named actions.** `native/shortcuts.ts` defines a closed set with a
  platform-independent `primary` modifier (Ctrl on Windows/Linux, Command on macOS). There is no
  API for arbitrary keys or text.
- **Graceful degradation.** Capabilities are probed rather than assumed: missing PowerShell
  assemblies, missing `xdotool`, headless hosts, Wayland-without-XWayland and unsupported
  platforms each yield an unavailable capability with a fix hint instead of a crash — and
  `get_host_capabilities` never throws.
- **Places are generated, not templated from binaries.** `.rbxlx` is Roblox's XML place format,
  so `native/places.ts` emits it directly (service `<Item>`s, `CoordinateFrame`, `size`,
  `Color3uint8`, `Material` tokens). Studio creates any omitted service on load, which keeps
  templates small and diff-friendly.

### `server/src/cloud/` — Open Cloud layer

The native layer ends at the local machine: it can save a place file, but only Roblox can turn
that file into something players load. This layer covers that last step, and is the only part of
the server that sends anything off-box.

```
OpenCloudClient (gate, key resolution + redaction, universe allowlist, upload limits, error mapping)
   └── CloudHttpClient  ── NodeCloudHttpClient (fetch) | FakeCloudHttpClient (tests)
```

Design decisions:

- **One port, like the native layer.** Every request goes through `CloudHttpClient`, so tests
  assert the exact method, URL, headers and body that would reach Roblox with no network access
  and no credentials.
- **Off by default, and a credential that is never generated.** Both tokens elsewhere in this
  server auto-generate when missing; an Open Cloud API key deliberately does not. It is a real
  Roblox credential that only the user can mint, so absence is a reported state (`status()` never
  throws) rather than a silent fallback.
- **The key never leaves the process.** Results, logs and errors carry at most a `sha256:`
  fingerprint, and every Roblox response body is scrubbed of the key before it is surfaced.
- **Safe default release mode.** `publish_place` defaults to `versionType: "Saved"`, which uploads
  without releasing, so the obvious call cannot surprise a live audience. Releasing (`Published`)
  and rolling out (`restart_universe_servers`) are separate, explicit steps.
- **Bounded blast radius.** `ROBLOX_MCP_ALLOWED_UNIVERSES` is enforced before any request is built,
  so a broadly scoped key cannot be pointed at the wrong experience. Uploads reuse the place-tool
  path sandbox and are format- and size-checked first.
- **Status codes become instructions.** 401/403/404/429 map to the concrete cause — revoked key,
  missing permission *or* the key's IP allowlist, wrong universe/place id, per-universe rate limit
  with its `Retry-After` — because the agent cannot fix a bare status code, and retrying a rejected
  publish in a loop is the wrong reflex.

## Wire protocol

All bridge endpoints are JSON over HTTP on `127.0.0.1`. Every `/plugin/*` request carries
`Authorization: Bearer <token>`.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | Unauthenticated liveness probe: `{ok, pluginConnected, peers}` (no sensitive data) |
| `/plugin/hello` | POST | Handshake: `sessionId` + `context` + plugin/protocol versions + place/user metadata → server version; 409 on protocol mismatch, 400 on missing session identity, 401 on bad token |
| `/plugin/poll?session=…` | GET | Long poll (≤ 15 s hold) on that peer's queue. 200 + `BridgeCommand`, 204 when idle, 409 for unknown sessions (plugin re-handshakes) |
| `/plugin/result?session=…` | POST | `BridgeResult` for a delivered command. 200, 410 if the command already timed out, 409 for unknown sessions |

A peer is considered **connected** while polls arrive within a 45 s window; sessions
unseen for 10 minutes are pruned.
Commands time out server-side from the moment they are enqueued (default 30 s;
long operations like batch creation, terrain, and snapshot export use larger budgets;
`run_luau` timeout is caller-controlled up to 180 s).

## Property value encoding

Primitives are plain JSON. Typed Roblox values are tagged objects; enums also accept a
string shorthand:

```jsonc
{
  "Size":     { "$type": "Vector3", "value": [4, 1, 2] },
  "CFrame":   { "$type": "CFrame",  "value": [0,5,0, 1,0,0, 0,1,0, 0,0,1] },
  "Color":    { "$type": "Color3",  "value": [1, 0.5, 0] },
  "Position": { "$type": "UDim2",   "value": [0.5, 0, 0.5, 0] },
  "Material": "Enum.Material.Neon",
  "@Health":  100                      // "@" prefix writes an attribute
}
```

Supported tags: `Vector3`, `Vector2`, `CFrame`, `Color3`, `BrickColor`, `UDim`, `UDim2`,
`EnumItem`, `Instance` (by path), `NumberRange`, `Rect`, `ColorSequence`, `NumberSequence`,
`Font`. The TypeScript (`shared/src/properties.ts`) and Luau (`Serialization.luau`)
implementations mirror each other exactly; responses use the same encoding, so values
round-trip.

**Instance addressing:** `game.Workspace.Map.Spawn` (`.` or `/` separators). Duplicate
sibling names use `Name[n]` (1-based). Responses always include canonical paths.

## Data flow example — autonomous debug loop

```
agent: get_host_capabilities()                                  ── native layer: what can this host do?
agent: create_place_file(name="Coins")                          ── writes a real .rbxlx
agent: launch_studio(placeFilePath=…)  → waits for the edit peer to connect
agent: create_script(ServerScriptService, "CoinSpawner", src)   ── plugin writes script
agent: analyze_scripts()                                        ── loadstring compile check
agent: start_playtest()                → returns logSeq baseline (Run mode, edit peer)
agent: get_errors(sinceSeq=logSeq)     → [{message, stack, script}]
agent: get_script_source(...)          → reads failing code
agent: patch_script_source(...)        → atomic find/replace fix
agent: stop_playtest() → start_playtest() → get_errors()        ── clean ✓
agent: start_play_solo()               → native F5; server + client peers connect
agent: eval_server_runtime(code)       → live state assertions in the real game
agent: get_errors(peer="client")       → client-side failures
agent: stop_play_solo()                → native Shift+F5
agent: set_camera(...) + capture_studio_screenshot()            ── visual verification
agent: save_project()                  → native Ctrl+S, saved into the place file
```

Steps 1-3 and the `start_play_solo` / screenshot / save steps go through the native host layer;
everything else goes through the plugin bridge. Without native control the same loop works, but
the user opens Studio and presses F5 themselves.

## Security model

Layered defenses, each independent:

1. **Network boundary** — the bridge binds to `127.0.0.1` only; nothing is reachable
   from the network. `/health` exposes no sensitive data and no mutation. The optional
   Streamable HTTP MCP endpoint also binds locally by default and is designed to be
   published through a reverse tunnel with TLS (see `docs/remote-access.md`), never by
   opening the raw port to the Internet.
2. **Authentication** — every `/plugin/*` request requires a bearer token (≥ 128-bit,
   auto-generated, stored `0600`), compared in constant time; the HTTP MCP endpoint
   requires its own independent bearer token. Protocol-version pinning prevents skew
   between plugin and server.
3. **Server-side validation** — every tool input is zod-validated (paths, class names,
   sizes, counts, timeouts) before anything reaches Studio. Oversized bodies are rejected.
4. **Studio-side guards** — protected containers (`game`, core services) cannot be
   deleted/renamed; instance names that would break path addressing are rejected;
   batch items validate individually with precise error attribution; every mutation
   records a ChangeHistory waypoint so the user can undo anything.
5. **Content safety** — `insert_asset` strips all scripts from inserted catalog content
   unless explicitly allowed; `run_luau` and `insert_asset` can be disabled entirely via
   environment flags for locked-down setups.
6. **Generated-code security** — scaffold code follows Roblox best practices:
   server-authoritative currency/purchases, schema-validated remotes, per-player
   rate limiting (token buckets), and no trust of client input anywhere.
7. **Native host boundary** — the layer that touches the OS is the most powerful, so it is
   fenced separately: two independent kill switches (`ROBLOX_MCP_ALLOW_NATIVE`,
   `ROBLOX_MCP_ALLOW_NATIVE_INPUT`) that refuse before anything executes; a closed shortcut
   allowlist instead of arbitrary key/text injection; window-title verification so keystrokes
   can only land in Roblox Studio; `execFile`-only process spawning (no shell) with fixed
   scripts and data passed through the environment; place paths resolved and confined to
   `ROBLOX_MCP_PLACES_ROOT` with an extension whitelist; no overwrite without an explicit flag;
   and screenshots written only under `ROBLOX_MCP_SCREENSHOT_DIR`. Details in
   `docs/native-control.md`.
8. **Publishing boundary** — the only capability whose effects reach people other than the
   operator, so it is fenced hardest: disabled unless `ROBLOX_MCP_ALLOW_PUBLISH=1`; requires an
   API key the server will never mint, only read (env or a `0600` file); the key is never returned,
   logged or echoed in an error (fingerprint only, response bodies scrubbed); `versionType` defaults
   to the non-releasing `Saved`; `ROBLOX_MCP_ALLOWED_UNIVERSES` bounds which experiences can be
   touched; uploads are confined to the place sandbox, validated as real places and size-capped;
   and `publish_universe_message` can only deliver a string to a topic the game already subscribes
   to, never execute remote code. Details in `docs/publishing.md`.

**Trust model:** the MCP client is trusted (it is the operator's own AI agent); Studio
content is semi-trusted (catalog assets may be malicious → scripts stripped); the network
is untrusted (hence localhost + token). `run_luau` is intentionally powerful — it is the
escape hatch that makes full autonomy possible — and is governed by the kill-switch env
flag plus Studio's own plugin sandbox (plugin security level, no filesystem/OS access).
The native layer deliberately steps outside that sandbox — it can affect the machine rather than
just the open place — which is why it has two kill switches, an action allowlist and a path
sandbox. The Open Cloud layer reaches further still, to people who never consented to the agent
at all, so it is the only capability that ships disabled and additionally requires a credential
the operator must create by hand.

## Scaffold library design

Scaffolds are complete Luau systems (not snippets) installed via one atomic batch:

- **Convention:** `ServerScriptService/Server/Services/*` ModuleScript services with an
  `Init(services)/Start()` lifecycle run by a `Bootstrap` script; shared modules and remote
  definitions in `ReplicatedStorage/Shared`; client code under
  `StarterPlayer/StarterPlayerScripts/Client`.
- **Dependency resolution:** `install_scaffold` topologically orders requested ids plus
  transitive dependencies (e.g. `shop` → `core`, `data-profiles`, `currency`, `inventory`).
- **Idempotent installs:** folders are reused; existing scripts are skipped (default) or
  updated in place (`overwrite=true`) — never duplicated, so agent re-runs are safe and
  user edits survive.
- **Integration points:** services discover each other through the Bootstrap service map,
  so optional integrations (quests → progression XP) degrade gracefully when absent.

## Testing strategy

- **Unit:** command queue (FIFO, park/flush, timeout, shutdown), session registry
  (selectors, ambiguity, pruning), auth (constant-time matching cases), shared
  encoders/validators, docs YAML condenser.
- **Integration:** real HTTP bridge + simulated plugin peers (handshake, auth rejection,
  protocol mismatch, round-trip, error propagation, ordering, timeout `410`, multi-peer
  routing between edit/server/client sessions, sessionId disambiguation).
- **Full-stack:** real MCP client over an in-memory transport → server → bridge →
  fake plugin, asserting the complete tool list, argument validation, per-peer runtime
  routing, disabled-tool behavior, and scaffold install payloads. A second suite connects
  a real MCP client over actual TCP to the Streamable HTTP endpoint (auth, tools,
  end-to-end calls, concurrent stateless clients).
- **Native (per-OS, host-independent):** every backend is driven through injected
  `CommandRunner`/`HostFileSystem` doubles, asserting the exact program + argv for Windows,
  macOS and Linux (Studio discovery incl. registry fallback, launch task arguments, SendKeys /
  AppleScript / xdotool key translation for every allowlisted shortcut, capture + downscale
  invocations, window-title refusal, permission and missing-window error mapping), plus the
  `NativeHost` gates, screenshot inlining limits and capability report.
- **Native (live):** `tests/native-live-x11.test.ts` runs the *real* runner against a real X
  display and a real window titled like Studio — discovery, activation (including the
  no-window-manager fallback), keystroke delivery, and PNG capture/downscale verified by PNG
  signature. It self-skips without a display; CI runs it under Xvfb.
- **Open Cloud:** the client is driven through an injected transport, asserting the exact method,
  URL, headers and body of every endpoint (publish `versionType`, XML vs binary content type,
  `updateMask` built only from supplied fields, the `:restartServers` / `:publishMessage` custom
  methods), the gate, the universe allowlist, upload validation, status-to-fix-hint mapping for
  400/401/403/404/409/429/5xx, and that the API key never appears in a status report, error body or
  log. A full-stack suite drives the publish tools through a real MCP client with real place files
  on disk, covering the `Saved` default, sandbox and file-format refusals, byte-for-byte upload
  fidelity, and the gate/allowlist refusals. Config tests cover key resolution (env, file,
  truncated, absent — never generated) and the env parsing of the gate, ids, allowlist and limits.
- **Open Cloud (live):** `tests/cloud-live-http.test.ts` drives the *real* `fetch` transport over
  real TCP against a local HTTP server — headers arriving, a binary place body surviving
  byte-for-byte, response status/header parsing, timeout and unreachable-host handling.
- **Places:** generated `.rbxlx` is parsed with a real XML parser and asserted structurally
  (services, instance properties, unique referents), plus path-sandbox escapes, extension
  rules, overwrite protection, inspection of xml/binary/corrupt files and listing/pagination.
- **Luau:** every plugin file and every scaffold template is compiled with the official
  `luau-compile` (test auto-skips where the binary is unavailable, CI installs it).
- **Artifact:** the `.rbxmx` packer output is validated for structure and XML safety.
- **Smoke:** `npm run smoke` boots the *built* server over the real Streamable HTTP transport
  and checks auth rejection, the full tool list, host-capability reporting, real place-file
  creation, sandbox refusal and stdout cleanliness, and asserts that publishing really is disabled
  in a default install (gate off, no key invented, `publish_place` refuses). CI runs it on Ubuntu,
  Windows and macOS.
