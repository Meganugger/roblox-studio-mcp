import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { peerSchema, runCommand, textResult, ToolContext } from "../tool-helpers.js";

export function registerConnectionTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_studio_status",
    {
      title: "Get Studio connection status",
      description:
        "Report whether the Roblox Studio plugin is connected to this MCP server, plus place metadata " +
        "(place name, placeId, gameId, plugin version) and the list of connected peers (edit session, " +
        "playtest server/clients). Call this first to verify the pipeline is live.",
      inputSchema: {},
    },
    async () => {
      const state = ctx.bridge.connectionState();
      const peers = ctx.sessions.list();
      if (!state.connected) {
        return textResult({
          connected: false,
          peers,
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
        peers,
        studio: live.isError ? { error: live.content[0]?.text } : JSON.parse(live.content[0].text),
      });
    },
  );

  server.registerTool(
    "get_connected_peers",
    {
      title: "List connected Studio peers",
      description:
        "List every connected plugin peer: the edit-mode Studio session plus, during a playtest, the play " +
        "server and each play client (with the simulated player's name). Use a peer's sessionId (or the " +
        'shortcuts "edit"/"server"/"client") as the `peer` argument of run_luau, eval_server_runtime, ' +
        "eval_client_runtime, get_output_logs and get_errors to route commands to that live DataModel.",
      inputSchema: {},
    },
    async () => textResult({ peers: ctx.sessions.list() }),
  );

  server.registerTool(
    "ping_studio",
    {
      title: "Ping Roblox Studio",
      description: "Round-trip a ping through the Studio plugin to measure end-to-end latency.",
      inputSchema: { peer: peerSchema },
    },
    async ({ peer }) => {
      const startedAt = Date.now();
      const result = await runCommand(ctx, "Ping", { sentAt: startedAt }, undefined, peer);
      if (result.isError) return result;
      return textResult({ ok: true, peer, roundTripMs: Date.now() - startedAt });
    },
  );
}
