# Architecture

## System overview

```
┌────────────────────┐   MCP (JSON-RPC over stdio)   ┌──────────────────────────┐
│  AI Agent           │◄─────────────────────────────►│  MCP Server (Node.js)     │
│  Claude / Cursor /  │                                │  ┌────────────────────┐  │
│  Claude Code / ...  │                                │  │ Tool layer (39)    │  │
└────────────────────┘                                │  │ zod validation     │  │
                                                       │  └─────────┬──────────┘  │
                                                       │            ▼             │
                                                       │  ┌────────────────────┐  │
                                                       │  │ CommandQueue       │  │
                                                       │  │ (FIFO + timeouts)  │  │
                                                       │  └─────────┬──────────┘  │
                                                       │            ▼             │
                                                       │  ┌────────────────────┐  │
                                                       │  │ HTTP bridge        │  │
                                                       │  │ 127.0.0.1:3667     │  │
                                                       │  │ Bearer-token auth  │  │
                                                       │  └─────────▲──────────┘  │
                                                       └────────────┼─────────────┘
                                          long-poll GET /plugin/poll│POST /plugin/result
                                                       ┌────────────┴─────────────┐
                                                       │  Studio Plugin (Luau)    │
                                                       │  Bridge loop + backoff   │
                                                       │  Executors (commands)    │
                                                       │  Serialization           │
                                                       │  OutputCapture (logs)    │
                                                       │  UI widget (token/port)  │
                                                       └────────────┬─────────────┘
                                                                    ▼
                                                       ┌──────────────────────────┐
                                                       │  Roblox Studio DataModel │
                                                       └──────────────────────────┘
```

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
| `index.ts` | Entrypoint: starts the stdio MCP transport + HTTP bridge; graceful shutdown |
| `config.ts` | Env config; token resolution (env → persisted file → generated) |
| `bridge/auth.ts` | Constant-time bearer-token verification |
| `bridge/command-queue.ts` | FIFO queue bridging async tool calls to the polling plugin; per-command timeouts; shutdown rejection |
| `bridge/http-bridge.ts` | `/health`, `/plugin/hello`, `/plugin/poll`, `/plugin/result`; body-size limits; connection tracking |
| `mcp/server.ts` | McpServer assembly + agent-facing usage instructions |
| `mcp/tools/*` | 39 tools grouped by domain; zod input schemas; readable error surfaces |
| `scaffolds/*` | Production Luau gameplay templates + dependency-resolved install planner |

**Tool call lifecycle:** MCP call → zod validation → connectivity check (fast, readable
failure if Studio is offline) → `queue.dispatch(name, payload, timeout)` → command delivered
to plugin poll → executed in Studio → result posted back → promise resolves → JSON returned
to the agent. Studio-side errors come back with the Luau stack trace attached so the agent
can debug what happened.

### `studio-plugin/` — Luau plugin (Rojo-compatible)

| Module | Responsibility |
| --- | --- |
| `Main.server.luau` | Wiring: output capture, UI, bridge, auto-connect with saved token |
| `Bridge.luau` | Handshake, long-poll loop, exponential backoff reconnect (1→15 s), result delivery with retries, status events |
| `Executors/init.luau` | Command dispatcher (merges per-domain handler tables; rejects unknown commands) |
| `Executors/Instances.luau` | Tree/read/search/create/batch/set/rename/move/clone/delete/selection; protected-container guard; undo waypoints |
| `Executors/Scripts.luau` | Script CRUD, exact-match patch edits (atomic), source search, compile analysis via `loadstring` |
| `Executors/RunCode.luau` | Sandboxed `loadstring` execution: print/warn capture, timeout + `task.cancel`, serialized return values |
| `Executors/Project.luau` | Status, project info, save request notification, bounded project snapshot export |
| `Executors/Playtest.luau` | `RunService:Run()/Stop()` control + log retrieval |
| `Executors/World.luau` | Terrain (block/ball/Perlin hills with responsiveness yields), lighting presets, `InsertService` with script stripping, camera |
| `Serialization.luau` | Mirror of the shared property encoding; script source via `ScriptEditorService` |
| `PathResolver.luau` | Path ⇆ instance translation with `Name[n]` disambiguation and helpful not-found errors |
| `OutputCapture.luau` | `LogService.MessageOut` + `ScriptContext.Error` ring buffer (5000 entries, monotonic `seq`) |
| `UI.luau` | Toolbar button + dock widget: status, token/port inputs (persisted via plugin settings), connect toggle, save-request notifications |

## Wire protocol

All bridge endpoints are JSON over HTTP on `127.0.0.1`. Every `/plugin/*` request carries
`Authorization: Bearer <token>`.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | Unauthenticated liveness probe: `{ok, pluginConnected}` (no sensitive data) |
| `/plugin/hello` | POST | Handshake: plugin/protocol versions + place metadata → server version; 409 on protocol mismatch, 401 on bad token |
| `/plugin/poll` | GET | Long poll (≤ 15 s hold). 200 + `BridgeCommand`, or 204 when idle |
| `/plugin/result` | POST | `BridgeResult` for a delivered command. 200, or 410 if the command already timed out |

The plugin is considered **connected** while polls arrive within a 45 s window.
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
agent: create_script(ServerScriptService, "CoinSpawner", src)   ── plugin writes script
agent: analyze_scripts()                                        ── loadstring compile check
agent: start_playtest()                → returns logSeq baseline
agent: get_errors(sinceSeq=logSeq)     → [{message, stack, script}]
agent: get_script_source(...)          → reads failing code
agent: patch_script_source(...)        → atomic find/replace fix
agent: stop_playtest() → start_playtest() → get_errors()        ── clean ✓
agent: save_project()                  → user notified to Ctrl+S
```

## Security model

Layered defenses, each independent:

1. **Network boundary** — the bridge binds to `127.0.0.1` only; nothing is reachable
   from the network. `/health` exposes no sensitive data and no mutation.
2. **Authentication** — every `/plugin/*` request requires a bearer token (≥ 128-bit,
   auto-generated, stored `0600`), compared in constant time. Protocol-version pinning
   prevents skew between plugin and server.
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

**Trust model:** the MCP client is trusted (it is the operator's own AI agent); Studio
content is semi-trusted (catalog assets may be malicious → scripts stripped); the network
is untrusted (hence localhost + token). `run_luau` is intentionally powerful — it is the
escape hatch that makes full autonomy possible — and is governed by the kill-switch env
flag plus Studio's own plugin sandbox (plugin security level, no filesystem/OS access).

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

- **Unit:** command queue (FIFO, park/flush, timeout, shutdown), auth (constant-time
  matching cases), shared encoders/validators.
- **Integration:** real HTTP bridge + simulated plugin client (handshake, auth rejection,
  protocol mismatch, round-trip, error propagation, ordering, timeout `410`).
- **Full-stack:** real MCP client over an in-memory transport → server → bridge →
  fake plugin, asserting the complete tool list, argument validation, disabled-tool
  behavior, and scaffold install payloads.
- **Luau:** every plugin file and every scaffold template is compiled with the official
  `luau-compile` (test auto-skips where the binary is unavailable, CI installs it).
- **Artifact:** the `.rbxmx` packer output is validated for structure and XML safety.
