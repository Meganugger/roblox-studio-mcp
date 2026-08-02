# Publishing to Roblox (Open Cloud)

v4.0.0 closes the last gap in the loop. Everything before it operates a local Studio session;
these tools put the result on Roblox.

| Without publishing | With publishing |
| --- | --- |
| The agent builds and saves locally; a human has to open Studio and press *Publish to Roblox* | `publish_place` uploads the saved file as a new place version |
| Listing details (name, description, server size) are changed by hand in the Creator Dashboard | `get_place_info` / `update_place_config` |
| Rolling a build out to players is manual | `restart_universe_servers` |
| Live-ops triggers require a redeploy | `publish_universe_message` (MessagingService) |

Everything else in this project works over the local plugin bridge and needs none of this.

## Why it is off by default

Every other capability in this server is bounded by the user's own machine: the worst case is a
broken local place, which `undo` or a discarded save fixes. Publishing is different — it changes
what **real players** see, and `restart_universe_servers` disconnects everyone currently playing.

So publishing is the one feature that stays off until you opt in, and it needs a credential the
server will never create for you:

1. `ROBLOX_MCP_ALLOW_PUBLISH=1` — the gate. Absent or `0`, every publish tool refuses and says so.
2. An Open Cloud API key that **you** mint, scoped to **your** experience.

`get_publish_capabilities` never fails, so the agent can always discover which of these is missing
and report the exact fix instead of retrying.

## 1. Create an Open Cloud API key

1. Open <https://create.roblox.com/dashboard/credentials> → **API Keys** → **Create API Key**.
2. Name it (e.g. `roblox-studio-mcp`).
3. Add the systems and permissions for the tools you intend to use:

   | Tool | Permission to add |
   | --- | --- |
   | `publish_place` | **Place Publishing API** → write, for the specific place (`universe-places:write`) |
   | `get_universe_info` | `universe:read` |
   | `get_place_info` | `universe.place:read` |
   | `update_place_config` | `universe.place:write` |
   | `restart_universe_servers` | `universe:write` |
   | `publish_universe_message` | **Messaging Service** → publish (`universe-messaging-service:publish`) |

   Add only what you need. `get_publish_capabilities` reprints this table with the exact strings.
4. Under **Security**, set the **IP allowlist**. Open Cloud rejects keys used from any address
   outside it — this is the single most common cause of a `403`. Use your machine's public address,
   or `0.0.0.0/0` to allow any (less safe).
5. Set an expiry, then **Save & Generate key**. Copy it now; Roblox will not show it again.

## 2. Give the server the key

Either an environment variable:

```bash
export ROBLOX_MCP_ALLOW_PUBLISH=1
export ROBLOX_MCP_OPEN_CLOUD_KEY='<your key>'
```

…or a file, which keeps the secret out of your shell history and process environment:

```bash
mkdir -p ~/.roblox-studio-mcp
printf '%s\n' '<your key>' > ~/.roblox-studio-mcp/open-cloud-key
chmod 600 ~/.roblox-studio-mcp/open-cloud-key
```

The environment variable wins when both exist. The key is **never** returned by a tool, written to
a log, or included in an error message: only a short, non-reversible `sha256:` fingerprint is ever
exposed, so you can confirm *which* key is loaded without revealing it.

## 3. Point it at your experience

```bash
export ROBLOX_MCP_UNIVERSE_ID=1234567890     # experience id  (Creator Dashboard → Settings)
export ROBLOX_MCP_PLACE_ID=9876543210        # place id       (the number in the game URL)
export ROBLOX_MCP_ALLOWED_UNIVERSES=1234567890
```

`universeId` and `placeId` are different numbers and both are needed — a universe (the experience)
contains one or more places (the start place plus any others).

`ROBLOX_MCP_ALLOWED_UNIVERSES` is the blast-radius control: with it set, the server refuses any
other universe **even if your API key could reach it**. Set it whenever your key is broader than
the one experience the agent is working on.

## Start here: `get_publish_capabilities`

```json
{
  "gates": { "publishing": true },
  "apiKey": {
    "configured": true,
    "source": "file",
    "fingerprint": "sha256:9f2b1c4d7e08",
    "path": "/home/me/.roblox-studio-mcp/open-cloud-key"
  },
  "defaults": { "universeId": 1234567890, "placeId": 9876543210 },
  "allowedUniverseIds": [1234567890],
  "maxUploadBytes": 104857600,
  "requiredScopes": { "publishPlace": "Place Publishing API -> write (universe-places:write)", "...": "..." },
  "endpoints": {
    "publish": "https://apis.roblox.com/universes/v1",
    "cloudV2": "https://apis.roblox.com/cloud/v2"
  },
  "notes": []
}
```

A non-empty `notes` array is the actionable part: each entry names the environment variable,
permission or dashboard page that fixes what is missing.

## Saved vs Published

`publish_place` takes `versionType`, and the default is deliberately the safe one:

| `versionType` | Effect |
| --- | --- |
| `Saved` (default) | Uploads a new version and stores it. Nothing changes for players. This is the right choice for checkpoints, review builds and anything the user has not explicitly asked to release. |
| `Published` | Uploads and releases: **new** servers use this version. Servers that are already running keep the old one until they empty out — or until `restart_universe_servers` closes them. |

Rolling a build out fully is therefore two deliberate steps, and the second one is the disruptive
one:

```
publish_place  path="PetSim.rbxlx" versionType="Published"   → new servers get the build
restart_universe_servers                                     → existing players are moved onto it
```

## Full workflow

```
get_publish_capabilities                     → gate on? key loaded? right universe?
get_universe_info                            → confirm it is really the intended experience
…build and debug with the Studio tools…
save_project                                 → real Ctrl+S writes the .rbxlx
publish_place  path="PetSim.rbxlx"           → Saved: uploaded, not released
  → { "versionNumber": 42, "versionType": "Saved" }
…user reviews it…
publish_place  path="PetSim.rbxlx" versionType="Published"
restart_universe_servers                     → only with explicit consent
```

`save_project` must come first: `publish_place` uploads what is **on disk**, not what is open in
Studio. Publishing straight after an edit without saving silently ships the previous state.

## Security model

- **Gate, off by default.** `ROBLOX_MCP_ALLOW_PUBLISH` is checked before any request is built, so a
  server without it never sends a byte to Roblox.
- **No credential is ever generated.** The bridge and HTTP tokens auto-generate; an API key cannot.
  Absence is a reported state, never a silent fallback.
- **The key never leaves the process.** Not in results, logs or errors — only a `sha256:`
  fingerprint. Response bodies are scrubbed of the key before they are shown, as defence in depth.
- **Universe allowlist.** `ROBLOX_MCP_ALLOWED_UNIVERSES` bounds what a broad key can touch.
- **Path sandbox.** `publish_place` resolves paths through the same `ROBLOX_MCP_PLACES_ROOT` sandbox
  as the other place tools, so it cannot upload arbitrary files from the disk.
- **Content validation.** The file is confirmed to be a real Roblox place (XML or binary magic) and
  under `ROBLOX_MCP_MAX_PLACE_UPLOAD_BYTES` before any upload starts.
- **Safe default release mode.** `Saved`, so the obvious call cannot surprise a live audience.
- **No arbitrary remote execution.** `publish_universe_message` can only deliver a string to a topic
  the game already subscribes to; it cannot run code in a live server.

## Manual acceptance checklist

CI has no Roblox account, so these steps are the human verification of the last mile. Use a
**private, throwaway experience** for steps 5 onward.

1. With the gate off: `get_publish_capabilities` → `gates.publishing: false` and a note naming
   `ROBLOX_MCP_ALLOW_PUBLISH=1`. `publish_place` → refuses, no network request.
2. Enable the gate but configure no key → `apiKey.configured: false`, and the note points at both
   `ROBLOX_MCP_OPEN_CLOUD_KEY` and the key-file path.
3. Configure the key → `apiKey.configured: true`, a `sha256:` fingerprint, and the key does **not**
   appear anywhere in the response.
4. `get_universe_info` → the real display name of your experience. (A `403` here means the key
   lacks `universe:read` or your IP is outside its allowlist.)
5. `create_place_file` + `launch_studio`, add a recognisable part, `save_project`.
6. `publish_place { path }` → `versionNumber` returned; the Creator Dashboard shows a new version,
   and the live game is **unchanged**.
7. `publish_place { path, versionType: "Published" }` → joining the experience shows the new part.
8. `get_place_info` → current name/description/serverSize. `update_place_config { description }` →
   the change appears on the experience's page.
9. With `ROBLOX_MCP_ALLOWED_UNIVERSES` set to a different id, `publish_place` → refused before any
   request.
10. `publish_universe_message` with a topic the place subscribes to → the live server logs it.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Publishing to Roblox is disabled on this server` | `ROBLOX_MCP_ALLOW_PUBLISH` is not `1`. Set it and restart the server. |
| `No Roblox Open Cloud API key is configured` | Set `ROBLOX_MCP_OPEN_CLOUD_KEY`, or write the key to `~/.roblox-studio-mcp/open-cloud-key`, then restart. |
| `ROBLOX_MCP_OPEN_CLOUD_KEY is only N characters long` | The key was truncated on copy. Copy the whole value from the Creator Dashboard. |
| `No universeId was given and no default is configured` | Set `ROBLOX_MCP_UNIVERSE_ID`, or pass `universeId`. It is not the placeId. |
| `Universe N is not in the allowlist` | `ROBLOX_MCP_ALLOWED_UNIVERSES` excludes it. Add it, or drop the variable. |
| HTTP 401 — *The API key was rejected* | Key mistyped, revoked or expired. Generate a new one. |
| HTTP 403 — *valid but not allowed* | The key is missing the permission named in the error, **or** your IP is outside the key's allowlist (check that first — it is the usual cause), **or** the key's owner lacks edit rights on the experience. |
| HTTP 404 | Wrong `universeId` / `placeId`, or they belong to another account or group. |
| HTTP 400 on publish | The file is not a valid place, or the extension does not match the content (`.rbxlx` is XML, `.rbxl` is binary). |
| HTTP 429 | Open Cloud rate limit; publishing is limited per universe. Honour the `Retry after` in the message — do not retry in a loop. |
| `Could not reach the Roblox Open Cloud API` | No outbound HTTPS to `apis.roblox.com` (proxy, firewall or offline host). |
| Published, but players still see the old build | Existing servers keep their version. Wait for them to empty, or `restart_universe_servers`. |
| Published the wrong thing | Upload the previous file again as `Published`; place versions are immutable, so rolling back means publishing the older content forward. |
