import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { instancePathSchema, runCommand, ToolContext } from "../tool-helpers.js";

/**
 * Log breakpoints: non-pausing instrumentation. A marker-tagged print line is
 * inserted into the script source, so it fires on every execution (edit
 * simulation and playtests alike) and shows up in get_output_logs. Markers
 * make the instrumentation reliably listable and removable.
 */
export function registerBreakpointTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "set_log_breakpoint",
    {
      title: "Set log breakpoint",
      description:
        "Instrument a script with a log breakpoint: inserts a marker-tagged print statement before the given " +
        "line (1-based), without pausing execution. Optionally log Luau expressions evaluated in that scope, " +
        'e.g. expressions=["player.Name", "damage"]. Workflow: set the breakpoint on the suspicious line, ' +
        "start a playtest / reproduce the behavior, then read get_output_logs (entries are prefixed " +
        "[MCP:BP:<id>]) and clear_log_breakpoints when done. Each breakpoint gets a unique id; the script's " +
        "line numbers shift by one per inserted breakpoint, so re-read the source before adding more.",
      inputSchema: {
        path: instancePathSchema.describe("Script to instrument."),
        line: z.number().int().min(1).describe("1-based line number to insert the log before."),
        message: z.string().max(300).optional().describe("Optional label included in the log output."),
        expressions: z
          .array(z.string().min(1).max(300))
          .max(10)
          .optional()
          .describe("Luau expressions valid in that scope whose values are logged alongside the message."),
      },
    },
    async ({ path, line, message, expressions }) =>
      runCommand(ctx, "SetLogBreakpoint", { path, line, message, expressions }),
  );

  server.registerTool(
    "list_log_breakpoints",
    {
      title: "List log breakpoints",
      description:
        "List active log breakpoints (id, script path, current line, logged text), optionally filtered to one script.",
      inputSchema: {
        path: instancePathSchema.optional().describe("Only list breakpoints in this script."),
      },
    },
    async ({ path }) => runCommand(ctx, "ListLogBreakpoints", { path }),
  );

  server.registerTool(
    "clear_log_breakpoints",
    {
      title: "Clear log breakpoints",
      description:
        "Remove log breakpoints: a specific one by id, all in one script (path), or every breakpoint in the " +
        "place when called with no arguments. Always clean up breakpoints after a debugging session.",
      inputSchema: {
        id: z.string().max(50).optional().describe("Breakpoint id from set_log_breakpoint / list_log_breakpoints."),
        path: instancePathSchema.optional().describe("Clear all breakpoints in this script."),
      },
    },
    async ({ id, path }) => runCommand(ctx, "ClearLogBreakpoints", { id, path }, 60_000),
  );
}
