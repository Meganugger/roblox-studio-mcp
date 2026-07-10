import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runCommand, ToolContext } from "../tool-helpers.js";

export function registerPlaytestTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "start_playtest",
    {
      title: "Start playtest (Run mode)",
      description:
        "Start simulation in the current DataModel via RunService:Run(). Server Scripts execute, physics runs, " +
        "and all output/errors are captured for get_output_logs / get_errors. Note: this is Studio 'Run' mode " +
        "(no player character); it is ideal for automated verification of server systems. " +
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
      description: "Return whether the simulation is currently running ({running, isEdit, isServer}).",
      inputSchema: {},
    },
    async () => runCommand(ctx, "GetPlaytestState", {}),
  );

  server.registerTool(
    "get_output_logs",
    {
      title: "Read Studio output",
      description:
        "Read captured Studio output (print/warn/info/errors) from the plugin's ring buffer. Entries carry a " +
        "monotonic `seq`; pass sinceSeq from your last read to only get new entries. Filter by level to focus " +
        "on problems.",
      inputSchema: {
        sinceSeq: z.number().int().min(0).default(0),
        level: z.enum(["All", "Output", "Info", "Warning", "Error"]).default("All"),
        maxEntries: z.number().int().min(1).max(2000).default(300),
      },
    },
    async ({ sinceSeq, level, maxEntries }) =>
      runCommand(ctx, "GetLogs", { sinceSeq, level, maxEntries }),
  );

  server.registerTool(
    "get_errors",
    {
      title: "Read Studio errors with stack traces",
      description:
        "Read only error entries (script errors include Luau stack traces and the erroring script's path). " +
        "This is the primary debugging feed: run the game, call get_errors, open the failing script, fix, retest.",
      inputSchema: {
        sinceSeq: z.number().int().min(0).default(0),
        maxEntries: z.number().int().min(1).max(500).default(100),
      },
    },
    async ({ sinceSeq, maxEntries }) =>
      runCommand(ctx, "GetLogs", { sinceSeq, level: "Error", maxEntries, includeStacks: true }),
  );

  server.registerTool(
    "clear_output_logs",
    {
      title: "Clear captured output",
      description: "Clear the plugin's captured log buffer (does not clear Studio's own Output window).",
      inputSchema: {},
    },
    async () => runCommand(ctx, "ClearLogs", {}),
  );
}
