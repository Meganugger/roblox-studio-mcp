import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  errorResult,
  instancePathSchema,
  runCommand,
  scriptClassSchema,
  ToolContext,
} from "../tool-helpers.js";

export function registerScriptTools(server: McpServer, ctx: ToolContext): void {
  const sourceSchema = z.string().max(ctx.config.maxScriptSourceBytes).describe("Full Luau source code.");

  server.registerTool(
    "create_script",
    {
      title: "Create script",
      description:
        "Create a Script, LocalScript or ModuleScript with the given source. Placement guide: server logic in " +
        "ServerScriptService, shared modules in ReplicatedStorage, client scripts in StarterPlayer.StarterPlayerScripts " +
        "or StarterGui. Set runContext to 'Client'/'Server' for Scripts that should use RunContext instead of location.",
      inputSchema: {
        scriptClass: scriptClassSchema,
        parentPath: instancePathSchema,
        name: z.string().min(1).max(100),
        source: sourceSchema,
        runContext: z.enum(["Legacy", "Server", "Client"]).optional().describe("Only for class Script."),
        overwrite: z
          .boolean()
          .default(false)
          .describe("Replace source if a script with this name/class already exists at the parent."),
      },
    },
    async ({ scriptClass, parentPath, name, source, runContext, overwrite }) =>
      runCommand(ctx, "CreateScript", { scriptClass, parentPath, name, source, runContext, overwrite }),
  );

  server.registerTool(
    "get_script_source",
    {
      title: "Read script source",
      description:
        "Return the full Luau source of a script, with line count and byte size. Optionally slice by line range.",
      inputSchema: {
        path: instancePathSchema,
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
      },
    },
    async ({ path, startLine, endLine }) =>
      runCommand(ctx, "GetScriptSource", { path, startLine, endLine }),
  );

  server.registerTool(
    "set_script_source",
    {
      title: "Replace script source",
      description: "Replace a script's entire source. For small edits prefer patch_script_source.",
      inputSchema: { path: instancePathSchema, source: sourceSchema },
    },
    async ({ path, source }) => runCommand(ctx, "SetScriptSource", { path, source }),
  );

  server.registerTool(
    "patch_script_source",
    {
      title: "Patch script source",
      description:
        "Apply exact-match find/replace edits to a script (like a code editor's replace). Each edit's `find` " +
        "must appear exactly once unless replaceAll is true. Fails atomically: either all edits apply or none do. " +
        "Use this for refactors instead of resending whole files.",
      inputSchema: {
        path: instancePathSchema,
        edits: z
          .array(
            z.object({
              find: z.string().min(1).max(100_000),
              replace: z.string().max(100_000),
              replaceAll: z.boolean().default(false),
            }),
          )
          .min(1)
          .max(50),
      },
    },
    async ({ path, edits }) => runCommand(ctx, "PatchScriptSource", { path, edits }),
  );

  server.registerTool(
    "search_script_source",
    {
      title: "Search across scripts",
      description:
        "Search all script sources in the place for a plain-text or Lua-pattern query. Returns matches with " +
        "script path, line number and line text - like grep for your game.",
      inputSchema: {
        query: z.string().min(1).max(500),
        isPattern: z.boolean().default(false).describe("Treat query as a Lua string pattern."),
        caseSensitive: z.boolean().default(false),
        root: instancePathSchema.default("game"),
        maxResults: z.number().int().min(1).max(1000).default(200),
      },
    },
    async ({ query, isPattern, caseSensitive, root, maxResults }) =>
      runCommand(ctx, "SearchScriptSource", { query, isPattern, caseSensitive, root, maxResults }, 60_000),
  );

  server.registerTool(
    "list_scripts",
    {
      title: "List all scripts",
      description:
        "List every Script/LocalScript/ModuleScript in the place (or under a root) with path, class, " +
        "line count and enabled state. Great for orienting in an unfamiliar project.",
      inputSchema: {
        root: instancePathSchema.default("game"),
        classFilter: scriptClassSchema.optional(),
      },
    },
    async ({ root, classFilter }) => runCommand(ctx, "ListScripts", { root, classFilter }),
  );

  server.registerTool(
    "analyze_scripts",
    {
      title: "Analyze scripts for syntax errors",
      description:
        "Compile-check scripts with Luau (loadstring) without running them. Returns a list of " +
        "{path, error, line} for scripts that fail to compile. Run this after batch edits and before playtesting.",
      inputSchema: {
        root: instancePathSchema.default("game"),
        path: instancePathSchema.optional().describe("Analyze a single script instead of a whole subtree."),
      },
    },
    async ({ root, path }) => {
      if (!ctx.config.allowRunLuau) {
        return errorResult(
          "analyze_scripts requires Luau compilation, which is disabled (ROBLOX_MCP_ALLOW_RUN_LUAU=0).",
        );
      }
      return runCommand(ctx, "AnalyzeScripts", { root, path }, 60_000);
    },
  );
}
