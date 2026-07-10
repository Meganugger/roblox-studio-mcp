import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runCommand, textResult, ToolContext } from "../tool-helpers.js";

export function registerConnectionTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_studio_status",
    {
      title: "Get Studio connection status",
      description:
        "Report whether the Roblox Studio plugin is connected to this MCP server, plus place metadata " +
        "(place name, placeId, gameId, plugin version). Call this first to verify the pipeline is live.",
      inputSchema: {},
    },
    async () => {
      const state = ctx.bridge.connectionState();
      if (!state.connected) {
        return textResult({
          connected: false,
          hint:
            "Open Roblox Studio, install/enable the Roblox Studio MCP plugin, set the auth token in the " +
            "plugin widget, and make sure it points at port " + ctx.bridge.port + ".",
        });
      }
      // Enrich with live data from Studio.
      const live = await runCommand(ctx, "GetStudioStatus", {});
      return textResult({
        connected: true,
        lastSeenAt: state.lastSeenAt,
        handshake: state.hello,
        studio: live.isError ? { error: live.content[0]?.text } : JSON.parse(live.content[0].text),
      });
    },
  );

  server.registerTool(
    "ping_studio",
    {
      title: "Ping Roblox Studio",
      description: "Round-trip a ping through the Studio plugin to measure end-to-end latency.",
      inputSchema: {},
    },
    async () => {
      const startedAt = Date.now();
      const result = await runCommand(ctx, "Ping", { sentAt: startedAt });
      if (result.isError) return result;
      return textResult({ ok: true, roundTripMs: Date.now() - startedAt });
    },
  );
}
