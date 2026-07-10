# Claude Code setup

```bash
claude mcp add roblox-studio -- node /absolute/path/to/roblox-studio-mcp/server/dist/index.js
```

With custom port / restricted code execution:

```bash
claude mcp add roblox-studio \
  --env ROBLOX_MCP_PORT=4100 \
  --env ROBLOX_MCP_ALLOW_RUN_LUAU=0 \
  -- node /absolute/path/to/roblox-studio-mcp/server/dist/index.js
```
