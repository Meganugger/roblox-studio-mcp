# URL-only MCP platforms (remote access)

For AI platforms that connect to an MCP **server URL** instead of spawning a local process.

## 1. Start the server in HTTP mode

```bash
node /absolute/path/to/roblox-studio-mcp/server/dist/index.js --transport http
```

The MCP endpoint is `http://127.0.0.1:3668/mcp`; the bearer token is printed on startup and
persisted at `~/.roblox-studio-mcp/http-token`.

## 2. Publish it with a reverse tunnel

```bash
# Cloudflare (free quick tunnel)
cloudflared tunnel --url http://127.0.0.1:3668

# or ngrok
ngrok http 3668

# or Tailscale Funnel
tailscale funnel 3668
```

## 3. Configure the platform

| Field | Value |
| --- | --- |
| MCP server URL | `https://<your-tunnel-host>/mcp` |
| Auth header | `Authorization: Bearer <contents of ~/.roblox-studio-mcp/http-token>` |
| Transport | Streamable HTTP |

Clients that take a JSON config with URL servers:

```json
{
  "mcpServers": {
    "roblox-studio": {
      "url": "https://<your-tunnel-host>/mcp",
      "headers": {
        "Authorization": "Bearer <http-token>"
      }
    }
  }
}
```

Security notes (token rotation, kill switches, self-hosting): see
[docs/remote-access.md](../../docs/remote-access.md).
