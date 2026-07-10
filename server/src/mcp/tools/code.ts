import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, runCommand, ToolContext } from "../tool-helpers.js";

export function registerCodeTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "run_luau",
    {
      title: "Run Luau code in Studio",
      description:
        "Execute arbitrary Luau code inside Roblox Studio (plugin security level, edit DataModel) and return " +
        "printed output plus serialized return values. This is the escape hatch for anything the dedicated tools " +
        "don't cover: complex geometry, physics setup, querying services, bulk edits, etc. " +
        "Code runs wrapped in a coroutine with its own print/warn capture. Return values are serialized " +
        "(tables up to depth 6, max 500 keys per table; Instances become their paths). " +
        "The operation creates a single undo waypoint.",
      inputSchema: {
        code: z.string().min(1).max(ctx.config.maxLuauCodeBytes).describe("Luau source to execute."),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(180_000)
          .default(30_000)
          .describe("How long to wait for completion (yielding code is allowed)."),
        description: z
          .string()
          .max(200)
          .optional()
          .describe("Short human-readable description shown in Studio's undo history."),
      },
    },
    async ({ code, timeoutMs, description }) => {
      if (!ctx.config.allowRunLuau) {
        return errorResult(
          "run_luau is disabled on this server (ROBLOX_MCP_ALLOW_RUN_LUAU=0). " +
            "Use the dedicated instance/script tools instead, or ask the user to enable code execution.",
        );
      }
      return runCommand(ctx, "RunLuau", { code, timeoutMs, description }, timeoutMs + 5_000);
    },
  );
}
