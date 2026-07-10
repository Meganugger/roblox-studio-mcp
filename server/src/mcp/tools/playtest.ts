import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { peerSchema, runCommand, ToolContext } from "../tool-helpers.js";

export function registerPlaytestTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "start_playtest",
    {
      title: "Start playtest (Run mode)",
      description:
        "Start simulation in the current DataModel via RunService:Run(). Server Scripts execute, physics runs, " +
        "and all output/errors are captured for get_output_logs / get_errors. Note: this is Studio 'Run' mode " +
        "(no player character); it is ideal for automated verification of server systems. For player-in-game " +
        "testing, ask the user to press Play (F5): the plugin then auto-connects extra peers for the play " +
        "server and each client (see get_connected_peers), enabling eval_server_runtime / eval_client_runtime. " +
        "Typical loop: analyze_scripts -> start_playtest -> wait -> get_errors -> fix -> stop_playtest -> repeat.",
      inputSchema: {},
    },
    async () => runCommand(ctx, "StartPlaytest", {}),
  );

  server.registerTool(
    "stop_playtest",
    {
      title: "Stop playtest",
      description:
        "Stop the running simulation via RunService:Stop(). Edits made by scripts during Run mode persist in " +
        "the edit DataModel, so consider that when verifying state.",
      inputSchema: {},
    },
    async () => runCommand(ctx, "StopPlaytest", {}),
  );

  server.registerTool(
    "get_playtest_state",
    {
      title: "Get playtest state",
      description:
        "Return whether the simulation is currently running ({running, isEdit, isServer}) for a given peer, " +
        "plus that peer's latest log sequence number.",
      inputSchema: { peer: peerSchema },
    },
    async ({ peer }) => runCommand(ctx, "GetPlaytestState", {}, undefined, peer),
  );

  server.registerTool(
    "get_output_logs",
    {
      title: "Read Studio output",
      description:
        "Read captured output (print/warn/info/errors) from a peer's ring buffer. Each connected peer (edit " +
        "session, playtest server, each playtest client) keeps its own buffer including boot-time prints, so " +
        'you can read per-peer logs during multiplayer tests: peer="server" for server logs, peer="client" ' +
        "(or a sessionId) for a client's logs. Entries carry a monotonic `seq`; pass sinceSeq from your last " +
        "read to only get new entries. Filter by level to focus on problems.",
      inputSchema: {
        sinceSeq: z.number().int().min(0).default(0),
        level: z.enum(["All", "Output", "Info", "Warning", "Error"]).default("All"),
        maxEntries: z.number().int().min(1).max(2000).default(300),
        peer: peerSchema,
      },
    },
    async ({ sinceSeq, level, maxEntries, peer }) =>
      runCommand(ctx, "GetLogs", { sinceSeq, level, maxEntries }, undefined, peer),
  );

  server.registerTool(
    "get_errors",
    {
      title: "Read Studio errors with stack traces",
      description:
        "Read only error entries (script errors include Luau stack traces and the erroring script's path) " +
        "from a peer's log buffer. This is the primary debugging feed: run the game, call get_errors, open " +
        'the failing script, fix, retest. During playtests, check peer="server" and peer="client" separately.',
      inputSchema: {
        sinceSeq: z.number().int().min(0).default(0),
        maxEntries: z.number().int().min(1).max(500).default(100),
        peer: peerSchema,
      },
    },
    async ({ sinceSeq, maxEntries, peer }) =>
      runCommand(ctx, "GetLogs", { sinceSeq, level: "Error", maxEntries, includeStacks: true }, undefined, peer),
  );

  server.registerTool(
    "clear_output_logs",
    {
      title: "Clear captured output",
      description: "Clear a peer's captured log buffer (does not clear Studio's own Output window).",
      inputSchema: { peer: peerSchema },
    },
    async ({ peer }) => runCommand(ctx, "ClearLogs", {}, undefined, peer),
  );
}
