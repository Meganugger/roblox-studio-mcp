import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, peerSchema, runCommand, ToolContext } from "../tool-helpers.js";

export function registerCodeTools(server: McpServer, ctx: ToolContext): void {
  const codeSchema = z.string().min(1).max(ctx.config.maxLuauCodeBytes).describe("Luau source to execute.");
  const timeoutSchema = z
    .number()
    .int()
    .min(1000)
    .max(180_000)
    .default(30_000)
    .describe("How long to wait for completion (yielding code is allowed).");
  const descriptionSchema = z
    .string()
    .max(200)
    .optional()
    .describe("Short human-readable description shown in Studio's undo history.");

  const guardDisabled = () =>
    errorResult(
      "run_luau is disabled on this server (ROBLOX_MCP_ALLOW_RUN_LUAU=0). " +
        "Use the dedicated instance/script tools instead, or ask the user to enable code execution.",
    );

  server.registerTool(
    "run_luau",
    {
      title: "Run Luau code in Studio",
      description:
        "Execute arbitrary Luau code inside Roblox Studio (plugin security level) and return printed output " +
        "plus serialized return values. This is the escape hatch for anything the dedicated tools don't cover: " +
        "complex geometry, physics setup, querying services, bulk edits, etc. By default it runs in the edit " +
        'DataModel; set peer="server"/"client" during a playtest to evaluate against the live game state ' +
        "(prefer the eval_server_runtime / eval_client_runtime shortcuts for that). " +
        "Code runs wrapped in a coroutine with its own print/warn capture. Return values are serialized " +
        "(tables up to depth 6, max 500 keys per table; Instances become their paths). " +
        "The operation creates a single undo waypoint.",
      inputSchema: {
        code: codeSchema,
        timeoutMs: timeoutSchema,
        description: descriptionSchema,
        peer: peerSchema,
      },
    },
    async ({ code, timeoutMs, description, peer }) => {
      if (!ctx.config.allowRunLuau) return guardDisabled();
      return runCommand(ctx, "RunLuau", { code, timeoutMs, description }, timeoutMs + 5_000, peer);
    },
  );

  server.registerTool(
    "eval_server_runtime",
    {
      title: "Evaluate Luau on the live playtest server",
      description:
        "Run Luau inside the playtest server's DataModel while the game is running (plugin security level). " +
        "Use it to inspect and mutate live server state mid-playtest: read workspace state, query services, " +
        "call module functions, count spawned NPCs, check leaderstats, etc. Requires an active play-solo or " +
        "multiplayer playtest (see get_connected_peers). Returns printed output plus serialized return values.",
      inputSchema: {
        code: codeSchema,
        timeoutMs: timeoutSchema,
      },
    },
    async ({ code, timeoutMs }) => {
      if (!ctx.config.allowRunLuau) return guardDisabled();
      return runCommand(ctx, "RunLuau", { code, timeoutMs }, timeoutMs + 5_000, "server");
    },
  );

  server.registerTool(
    "eval_client_runtime",
    {
      title: "Evaluate Luau on a live playtest client",
      description:
        "Run Luau inside a playtest client's DataModel while the game is running (plugin security level). " +
        "Use it to inspect live client state: PlayerGui contents, camera, local character, UI visibility, etc. " +
        "When several clients are connected (multiplayer test), pass the target client's sessionId from " +
        "get_connected_peers as `peer`. Returns printed output plus serialized return values.",
      inputSchema: {
        code: codeSchema,
        timeoutMs: timeoutSchema,
        peer: peerSchema.removeDefault().default("client"),
      },
    },
    async ({ code, timeoutMs, peer }) => {
      if (!ctx.config.allowRunLuau) return guardDisabled();
      return runCommand(ctx, "RunLuau", { code, timeoutMs }, timeoutMs + 5_000, peer);
    },
  );
}
