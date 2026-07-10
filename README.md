# Roblox Studio MCP

**A production Model Context Protocol (MCP) integration that lets AI agents control Roblox Studio and autonomously build, test, and debug Roblox games.**

With this project connected, an AI assistant (Claude, Cursor, Claude Code, or any MCP client) can operate like a full Roblox development team — programmer, level designer, UI developer, gameplay engineer, tester, and debugger — inside a live Studio session:

- 🌳 **Explorer control** — create, inspect, clone, move, rename, and delete instances; batch-build hundreds of objects with one undo waypoint
- 📜 **Script management** — create/read/edit/patch/search/refactor `Script`, `LocalScript`, and `ModuleScript`; compile-check the whole place
- ⚙️ **Code execution** — run arbitrary Luau in Studio (plugin security level) with captured output and serialized return values
- 🧪 **Test & debug loop** — start/stop playtests, read output logs and errors *with Luau stack traces*, fix, and retest — fully autonomously
- 🌍 **World building** — procedural terrain (Perlin-noise hills, blocks, spheres), lighting presets, catalog asset insertion, camera control
- 🧩 **Game system scaffolds** — one command installs production-grade systems: DataStore player profiles, currencies, inventory, shop, quests, progression + achievements, global leaderboards, combat, NPCs, round/matchmaking loops, settings, and a themed UI kit (HUD, menus, notifications)
- 🔐 **Security-first** — bearer-token authentication, localhost-only bridge, command validation, rate-limited remotes in generated code, script-stripping on asset inserts

## Architecture

```
AI Agent (Claude / Cursor / any MCP client)
        │  MCP over stdio
        ▼
MCP Server (Node.js + TypeScript)
        │  local HTTP bridge on 127.0.0.1 (bearer-token auth)
        ▼  long-polling (plugins can only make outbound requests)
Roblox Studio Plugin (Luau)
        │  command executors + ChangeHistory waypoints
        ▼
Roblox Studio (your open place)
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

Copy the built plugin into your local Studio plugins folder:

- **Windows:** `%LOCALAPPDATA%\Roblox\Plugins\RobloxStudioMCP.rbxmx`
- **macOS:** `~/Documents/Roblox/Plugins/RobloxStudioMCP.rbxmx`

(or in Studio: *Plugins Folder* → drop the file in, then restart Studio).

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

The agent will lay out the map with `generate_terrain` + `create_instances_batch`, install data
profiles/currency/shop/quests/UI with `install_scaffold`, write game-specific scripts, then loop
`analyze_scripts → start_playtest → get_errors → fix → retest` until everything runs clean.
A full walkthrough lives in [`examples/simulator-game.md`](examples/simulator-game.md).

## Tool suite (39 tools)

| Category | Tools |
| --- | --- |
| Connection | `get_studio_status`, `ping_studio` |
| Explorer | `get_instance_tree`, `get_instance`, `get_instance_children`, `search_instances`, `create_instance`, `create_instances_batch`, `set_instance_properties`, `rename_instance`, `move_instance`, `clone_instance`, `delete_instance`, `get_selection`, `set_selection` |
| Scripts | `create_script`, `get_script_source`, `set_script_source`, `patch_script_source`, `search_script_source`, `list_scripts`, `analyze_scripts` |
| Code execution | `run_luau` |
| Project | `get_project_info`, `save_project`, `export_project_snapshot` |
| Test & debug | `start_playtest`, `stop_playtest`, `get_playtest_state`, `get_output_logs`, `get_errors`, `clear_output_logs` |
| World | `generate_terrain`, `clear_terrain`, `set_lighting`, `insert_asset`, `set_camera` |
| Game systems | `list_scaffolds`, `install_scaffold` |

Full reference with parameters and examples: [docs/tools.md](docs/tools.md).

## Configuration

Environment variables read by the server:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ROBLOX_MCP_PORT` | `3667` | Local bridge port (127.0.0.1 only) |
| `ROBLOX_MCP_TOKEN` | auto-generated | Shared secret (≥ 16 chars) between server and plugin |
| `ROBLOX_MCP_HOME` | `~/.roblox-studio-mcp` | Where the generated token is persisted |
| `ROBLOX_MCP_ALLOW_RUN_LUAU` | `1` | Set `0` to disable arbitrary code execution |
| `ROBLOX_MCP_ALLOW_INSERT_ASSET` | `1` | Set `0` to disable catalog asset insertion |
| `ROBLOX_MCP_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

## Repository layout

```
server/         MCP server: tools, HTTP bridge, auth, scaffold library (TypeScript)
studio-plugin/  Roblox Studio plugin: bridge loop, executors, UI (Luau, Rojo-compatible)
shared/         Wire protocol, command names, property encoding (TypeScript)
scripts/        Plugin packer (source tree → .rbxmx)
tests/          Vitest suite incl. full-stack MCP + bridge integration tests
docs/           Installation, usage, tool reference, troubleshooting
examples/       Client configs, prompt playbooks, simulator-game walkthrough
```

## Development

```bash
npm run typecheck   # strict TS across workspaces
npm test            # 38 tests: unit + HTTP bridge + in-memory MCP client integration
npm run build       # server + shared + plugin artifact
```

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
Roblox Studio's outbound-only HTTP constraint. This implementation is written from scratch and
extends the pattern with token authentication, atomic batch building, a script patch/refactor
toolchain, an autonomous test/debug loop, and a production gameplay scaffold library.

## License

[MIT](LICENSE)
