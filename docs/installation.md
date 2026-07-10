# Installation

## Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | ≥ 18.17 | 20 LTS or 22 recommended |
| Roblox Studio | current | any platform Studio supports |
| MCP client | — | Claude Desktop, Claude Code, Cursor, or any MCP-compatible agent |

## 1. Build the project

```bash
git clone https://github.com/Meganugger/roblox-studio-mcp.git
cd roblox-studio-mcp
npm install
npm run build
```

Outputs:

- `server/dist/index.js` — the MCP server entrypoint
- `studio-plugin/dist/RobloxStudioMCP.rbxmx` — the ready-to-install Studio plugin

Run `npm test` to verify your build (38 tests should pass).

## 2. Install the Studio plugin

Copy `studio-plugin/dist/RobloxStudioMCP.rbxmx` into your local plugins folder:

| OS | Path |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Roblox\Plugins\` |
| macOS | `~/Documents/Roblox/Plugins/` |

Tip: in Studio, **Plugins tab → Plugins Folder** opens the right directory. Restart
Studio (or use *Plugins → Manage Plugins → refresh*) and you should see a
**Roblox Studio MCP** toolbar section with an **MCP** button.

### Building the plugin with Rojo (optional)

The plugin source is a standard Rojo project:

```bash
rojo build studio-plugin -o RobloxStudioMCP.rbxmx
```

`npm run build:plugin` produces an equivalent artifact without needing Rojo.

## 3. Register the MCP server with your AI client

### Claude Desktop

Edit `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

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

### Claude Code

```bash
claude mcp add roblox-studio -- node /absolute/path/to/roblox-studio-mcp/server/dist/index.js
```

### Cursor

Settings → MCP → Add server, or `.cursor/mcp.json`:

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

Ready-made files live in [`examples/client-configs/`](../examples/client-configs/).

## 4. Pair the plugin with the server

1. Restart your MCP client so it launches the server. The server logs (stderr) print:

   ```
   Bridge: http://127.0.0.1:3667 | Plugin auth token: <token>
   ```

   The token is also persisted at `~/.roblox-studio-mcp/token`, so it stays stable
   across restarts.
2. In Studio, open a place → click the **MCP** toolbar button → paste the token →
   **Connect**. Status turns **Connected ✓**.
3. Studio may need *Allow HTTP Requests* (Game Settings → Security). The plugin
   attempts to enable it automatically and tells you if it can't.
4. The plugin remembers the token and auto-connects in future sessions.

## 5. Verify end to end

Ask your agent: *“Ping Roblox Studio and give me the project info.”*
It should call `ping_studio` (round-trip latency) and `get_project_info` (place stats).

## Configuration reference

| Env var | Default | Purpose |
| --- | --- | --- |
| `ROBLOX_MCP_PORT` | `3667` | Bridge port. Change it in both the server env and the plugin widget |
| `ROBLOX_MCP_TOKEN` | auto | Provide your own shared secret (≥ 16 chars) |
| `ROBLOX_MCP_HOME` | `~/.roblox-studio-mcp` | Token persistence directory |
| `ROBLOX_MCP_ALLOW_RUN_LUAU` | `1` | `0` disables `run_luau` and `analyze_scripts` |
| `ROBLOX_MCP_ALLOW_INSERT_ASSET` | `1` | `0` disables `insert_asset` |
| `ROBLOX_MCP_LOG_LEVEL` | `info` | stderr log verbosity |

Set env vars in the MCP client config, e.g.:

```json
{
  "mcpServers": {
    "roblox-studio": {
      "command": "node",
      "args": ["/path/to/server/dist/index.js"],
      "env": { "ROBLOX_MCP_PORT": "4100", "ROBLOX_MCP_LOG_LEVEL": "debug" }
    }
  }
}
```
