import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildInstallPlan, resolveInstallOrder, SCAFFOLDS } from "../../scaffolds/index.js";
import { errorResult, runCommand, textOf, textResult, ToolContext } from "../tool-helpers.js";

export function registerScaffoldTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_scaffolds",
    {
      title: "List game system scaffolds",
      description:
        "List the production-ready gameplay systems this server can install in one shot: data profiles " +
        "(DataStore saving), currency, inventory, shop, quests, progression/achievements, leaderboards, " +
        "combat, NPCs, rounds/matchmaking, settings and a full UI kit. Each entry lists its dependencies " +
        "and the files it creates. Use install_scaffold to add them to the open place, then customize the " +
        "generated Luau with the script tools.",
      inputSchema: {},
    },
    async () =>
      textResult(
        SCAFFOLDS.map((scaffold) => ({
          id: scaffold.id,
          title: scaffold.title,
          description: scaffold.description,
          dependencies: scaffold.dependencies,
          files: scaffold.files.map((file) => `${file.parentPath}.${file.name} (${file.className})`),
        })),
      ),
  );

  server.registerTool(
    "install_scaffold",
    {
      title: "Install game system scaffolds",
      description:
        "Install one or more scaffolds (plus their dependencies, automatically resolved and ordered) into " +
        "the open place as a single batch operation with one undo waypoint. Existing files with the same " +
        "path are skipped unless overwrite=true, so re-running is safe and your edits are preserved. " +
        "After installing, run analyze_scripts and start_playtest to verify, then tailor the generated " +
        "code to the game's design.",
      inputSchema: {
        ids: z
          .array(z.string().min(1).max(50))
          .min(1)
          .max(SCAFFOLDS.length)
          .describe('Scaffold ids from list_scaffolds, e.g. ["currency", "shop", "ui-kit"].'),
        overwrite: z
          .boolean()
          .default(false)
          .describe("Replace existing scripts at the same paths (folders are always reused, never replaced)."),
      },
    },
    async ({ ids, overwrite }) => {
      let plan;
      try {
        plan = buildInstallPlan(resolveInstallOrder(ids));
      } catch (err) {
        return errorResult(String(err instanceof Error ? err.message : err));
      }
      const items = plan.map((file) => ({
        className: file.className,
        parentPath: file.parentPath,
        name: file.name,
        properties: file.source !== undefined ? { Source: file.source } : undefined,
        // Folders are always reused; scripts are skipped or updated in place.
        skipIfExists: file.className === "Folder" ? true : !overwrite,
        upsert: file.className !== "Folder" && overwrite,
      }));
      const result = await runCommand(ctx, "CreateInstancesBatch", { items }, 120_000);
      if (result.isError) return result;
      return textResult({
        installed: resolveInstallOrder(ids).map((scaffold) => scaffold.id),
        note:
          "Scaffolds installed. Next steps: 1) analyze_scripts to verify compilation, 2) start_playtest + " +
          "get_errors to verify runtime behavior, 3) customize catalogs/definitions (ShopCatalog, " +
          "QuestDefinitions, ProfileTemplate) for this specific game.",
        result: JSON.parse(textOf(result)),
      });
    },
  );
}
