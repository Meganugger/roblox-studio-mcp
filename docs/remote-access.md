# Remote access: connecting URL-only AI platforms

Some AI platforms cannot spawn a local MCP process over stdio — they only accept a **server URL**
(Streamable HTTP MCP). This guide shows how to expose your local Roblox Studio MCP securely to
such platforms.

Setting this up for the first time? [http-mode-quickstart.md](http-mode-quickstart.md) walks
through the whole thing end to end (including pairing Studio and verifying it works); this page is
the reference for the tunnel and deployment options.

## How it works

```
URL-only AI platform
        │  HTTPS (Streamable HTTP MCP + bearer token)
        ▼
Reverse tunnel (Cloudflare Tunnel / ngrok / Tailscale Funnel)
        │  outbound-only connection from your machine
        ▼
Roblox Studio MCP  —  http://127.0.0.1:3668/mcp   (localhost bind)
        │  local bridge on 127.0.0.1:3667
        ▼
Roblox Studio plugin
```

The MCP server itself **never** listens on a public interface. A reverse tunnel makes an
*outbound* connection from your machine to the tunnel provider, which terminates TLS and forwards
requests to `127.0.0.1:3668`. No inbound firewall holes, no port forwarding, no exposed Studio.

## 1. Start the server in HTTP mode

```bash
node server/dist/index.js --transport http
# or: ROBLOX_MCP_TRANSPORT=http node server/dist/index.js
```

The server logs two secrets on startup (both persisted under `~/.roblox-studio-mcp/`):

- **Plugin auth token** (`token`) — paste into the Studio plugin widget, as usual.
- **MCP bearer token** (`http-token`) — required by every request to `/mcp`.

Endpoints:

| Path | Auth | Purpose |
| --- | --- | --- |
| `POST /mcp` | `Authorization: Bearer <http-token>` | Streamable HTTP MCP (JSON-RPC) |
| `GET /healthz` | none | Liveness probe (no data exposure) |

The transport runs in **stateless** mode: any number of concurrent clients can connect, and no
session affinity is needed behind proxies or tunnels.

## 2. Publish it with a reverse tunnel

Pick one provider:

### Cloudflare Tunnel (free, no account needed for quick tunnels)

```bash
cloudflared tunnel --url http://127.0.0.1:3668
```

Prints a `https://<random>.trycloudflare.com` URL. For a stable hostname, create a named tunnel
with a Cloudflare account (`cloudflared tunnel create …`).

### ngrok

```bash
ngrok http 3668
```

Prints a `https://<random>.ngrok-free.app` URL (stable domains on paid plans).

### Tailscale Funnel (great for private tailnets)

```bash
tailscale funnel 3668
```

Publishes `https://<machine>.<tailnet>.ts.net`. With plain `tailscale serve` instead of `funnel`,
the endpoint stays private to your tailnet — the most secure option when the AI platform can join
your tailnet. A cloud platform cannot: it is outside your tailnet, so it needs `funnel`.

Mount the tunnel at the **root**, as above. Mounting it on a sub-path
(`tailscale serve https:443 /mcp http://127.0.0.1:3668`) strips the prefix before forwarding, so the
server sees `/` instead of `/mcp` and answers `404` — which most clients report only as a bare
"Non-200 status code (404)".

## 3. Connect the platform

Configure the platform's MCP integration with:

- **URL:** `https://<your-tunnel-host>/mcp`
- **Header:** `Authorization: Bearer <contents of ~/.roblox-studio-mcp/http-token>`

Quick verification from any machine:

```bash
curl -s https://<your-tunnel-host>/healthz
# {"ok":true}

curl -s -X POST https://<your-tunnel-host>/mcp \
  -H "Authorization: Bearer <http-token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1,"params":{}}'
```

## Security model

- **Bearer token required** on every `/mcp` request (constant-time comparison; 401 otherwise).
  A tunnel URL alone is not enough to control your Studio.
- **Localhost bind by default.** `ROBLOX_MCP_HTTP_HOST` can override this for LAN/VPS deployments,
  but never expose the raw HTTP port to the Internet without TLS in front — prefer the tunnel.
- **TLS** is terminated by the tunnel provider, so the token never crosses the Internet in plaintext.
- **Blast-radius controls** still apply: set `ROBLOX_MCP_ALLOW_RUN_LUAU=0` and/or
  `ROBLOX_MCP_ALLOW_INSERT_ASSET=0` to disable code execution / remote asset insertion for
  remotely connected agents.
- **Rotation:** delete `~/.roblox-studio-mcp/http-token` and restart to rotate the MCP token
  (or set `ROBLOX_MCP_HTTP_TOKEN`). Quick tunnels also rotate their hostname on every start.
- Remember what this grants: anyone with the URL **and** the token can edit the open place and
  (unless disabled) execute Luau in Studio. Treat the token like a password, use per-machine
  tunnels, and shut the tunnel down when you're done.

## Self-hosted / VPS deployment

You can also run the server on a machine you control and put a TLS reverse proxy (Caddy, nginx,
Traefik) in front:

```bash
ROBLOX_MCP_TRANSPORT=http ROBLOX_MCP_HTTP_HOST=127.0.0.1 node server/dist/index.js
# proxy: https://mcp.example.com  ->  http://127.0.0.1:3668
```

Note that the **Studio plugin** must still be able to reach the *bridge* port (3667). Studio and
the MCP server normally run on the same machine; if you split them, tunnel the bridge port from
the Studio machine to the server machine (e.g. `ssh -R 3667:127.0.0.1:3667 server`), keeping it
loopback-only on both ends.
