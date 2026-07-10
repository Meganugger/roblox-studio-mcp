import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { instancePathSchema, runCommand, ToolContext } from "../tool-helpers.js";

export function registerProjectTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_project_info",
    {
      title: "Get project info",
      description:
        "Return place metadata (name, placeId, gameId), per-service instance/script counts, workspace stats " +
        "and Studio session state. Use this to understand a project before making changes.",
      inputSchema: {},
    },
    async () => runCommand(ctx, "GetProjectInfo", {}, 60_000),
  );

  server.registerTool(
    "save_project",
    {
      title: "Request project save",
      description:
        "Roblox Studio does not allow plugins to silently save the place file, so this tool marks the point " +
        "where a save is needed and shows a prominent notification inside Studio asking the user to press Ctrl+S " +
        "(or Publish). Returns whether the notification was shown.",
      inputSchema: {
        message: z.string().max(300).optional().describe("Optional custom message to show the user."),
      },
    },
    async ({ message }) => runCommand(ctx, "RequestSave", { message }),
  );

  server.registerTool(
    "export_project_snapshot",
    {
      title: "Export project snapshot",
      description:
        "Export a structural snapshot of the whole place as JSON: the full instance tree (bounded) and, " +
        "optionally, every script's source. Useful for whole-project review, external analysis or backups. " +
        "Large places are truncated at maxNodes with a `truncated` flag.",
      inputSchema: {
        includeScriptSources: z.boolean().default(false),
        root: instancePathSchema.default("game"),
        maxNodes: z.number().int().min(100).max(50_000).default(10_000),
      },
    },
    async ({ includeScriptSources, root, maxNodes }) =>
      runCommand(ctx, "ExportProjectSnapshot", { includeScriptSources, root, maxNodes }, 120_000),
  );
}
