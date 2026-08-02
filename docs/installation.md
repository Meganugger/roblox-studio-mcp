# Installation

## Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | ≥ 18.17 | 20 LTS or 22 recommended |
| Roblox Studio | current | any platform Studio supports |
| MCP client | — | Claude Desktop, Claude Code, Cursor, or any MCP-compatible agent |

Optional, for [native host control](native-control.md) (launching Studio, screenshots, real play
sessions, native saving):

| Platform | Requirement |
| --- | --- |
| Windows | Nothing extra. Windows PowerShell 5.1 (`powershell.exe`) is preferred; with PowerShell 7 only, install the .NET Windows Desktop runtime for input/screenshots |
| macOS | Grant the process running the server **Accessibility** (keystrokes) and **Screen Recording** (screenshots) in System Settings → Privacy & Security |
| Linux | `xdotool` + ImageMagick and an X display. Roblox ships no Linux Studio build, so this is for development/testing (or a Wine install via `ROBLOX_MCP_STUDIO_PATH`) |

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

Run `npm test` to verify your build (222 tests should pass; the live-X11 native suite
self-skips when no display is available). `npm run smoke` additionally boots the built server
and exercises the tool surface over real HTTP.

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

Then verify native control: *“Check the host capabilities and take a screenshot of Studio.”*
`get_host_capabilities` should report your platform with a Studio path, and
`capture_studio_screenshot` should return an image of the Studio window. Anything unavailable is
reported with the exact fix — see [native-control.md](native-control.md).

Publishing to Roblox is a separate, opt-in step and is disabled until you configure it:
[publishing.md](publishing.md).

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
| `ROBLOX_MCP_ALLOW_NATIVE` | `1` | `0` disables all native host control (Studio launching, window focus, shortcuts, screenshots) |
| `ROBLOX_MCP_ALLOW_NATIVE_INPUT` | `1` | `0` disables keyboard-shortcut simulation only (launching and screenshots still work) |
| `ROBLOX_MCP_STUDIO_PATH` | auto | Explicit Studio executable/app path when auto-detection fails |
| `ROBLOX_MCP_PLACES_DIR` | `~/RobloxStudioMCP/places` | Where `create_place_file` writes new places |
| `ROBLOX_MCP_PLACES_ROOT` | home dir | Sandbox root; place tools refuse any path outside it |
| `ROBLOX_MCP_SCREENSHOT_DIR` | `~/.roblox-studio-mcp/screenshots` | Where screenshots are saved |
| `ROBLOX_MCP_ALLOW_PUBLISH` | `0` | `1` enables the Open Cloud publish tools. Off by default: they reach live players |
| `ROBLOX_MCP_OPEN_CLOUD_KEY` | none | Open Cloud API key, or write it to `~/.roblox-studio-mcp/open-cloud-key` (`chmod 600`). Never generated, never printed back |
| `ROBLOX_MCP_UNIVERSE_ID` | none | Default universe (experience) id for the publish tools |
| `ROBLOX_MCP_PLACE_ID` | none | Default place id for the publish tools |
| `ROBLOX_MCP_ALLOWED_UNIVERSES` | any | Comma-separated universe allowlist; others are refused even if the key can reach them |
| `ROBLOX_MCP_MAX_PLACE_UPLOAD_BYTES` | `104857600` | Upload size cap for `publish_place` |
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
