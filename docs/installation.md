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

Run `npm test` to verify your build (62 tests should pass).

## 2. Install the Studio plugin

```bash
node server/dist/index.js --install-plugin
```

This copies the built `.rbxmx` into your local plugins folder automatically. Manual
alternative — copy `studio-plugin/dist/RobloxStudioMCP.rbxmx` yourself:

| OS | Path |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Roblox\Plugins\` |
| macOS | `~/Documents/Roblox/Plugins/` |
| Other / custom | set `MCP_PLUGINS_DIR` before running `--install-plugin` |

Tip: in Studio, **Plugins tab → Plugins Folder** opens the right directory. Fully close
and reopen Studio after installing/updating and you should see a
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

### URL-only platforms (remote MCP)

Platforms that only accept an MCP **server URL** connect through the Streamable HTTP
transport plus a reverse tunnel:

```bash
node server/dist/index.js --transport http        # serves http://127.0.0.1:3668/mcp
cloudflared tunnel --url http://127.0.0.1:3668    # publishes it as https://…
```

Give the platform `https://<tunnel-host>/mcp` with header
`Authorization: Bearer <~/.roblox-studio-mcp/http-token>`.
Full guide: [remote-access.md](remote-access.md).

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
| `ROBLOX_MCP_TRANSPORT` | `stdio` | `http` serves Streamable HTTP MCP instead of stdio |
| `ROBLOX_MCP_HTTP_PORT` | `3668` | HTTP MCP port (`--transport http`) |
| `ROBLOX_MCP_HTTP_HOST` | `127.0.0.1` | HTTP MCP bind host (keep local; publish via tunnel) |
| `ROBLOX_MCP_HTTP_TOKEN` | auto | Bearer token for the HTTP MCP endpoint (≥ 16 chars) |
| `ROBLOX_MCP_HOME` | `~/.roblox-studio-mcp` | Token persistence directory |
| `ROBLOX_MCP_ALLOW_RUN_LUAU` | `1` | `0` disables `run_luau`, runtime evals and `analyze_scripts` |
| `ROBLOX_MCP_ALLOW_INSERT_ASSET` | `1` | `0` disables `insert_asset` |
| `ROBLOX_MCP_LOG_LEVEL` | `info` | stderr log verbosity |
| `MCP_PLUGINS_DIR` | OS default | Studio plugins folder override for `--install-plugin` |

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
