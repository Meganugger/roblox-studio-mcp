import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, nativeErrorResult, textResult, ToolContext } from "../tool-helpers.js";
import { NodeHostFileSystem } from "../../native/runner.js";
import {
  createPlaceFile,
  describePlaceFile,
  listPlaceFiles,
  PLACE_TEMPLATES,
  resolvePlaceDirectory,
  resolvePlacePath,
} from "../../native/places.js";
import { launchStudioAndWait } from "./native.js";

const templateIds = PLACE_TEMPLATES.map((template) => template.id) as [
  (typeof PLACE_TEMPLATES)[number]["id"],
  ...Array<(typeof PLACE_TEMPLATES)[number]["id"]>,
];

/**
 * Local place-file tools: create a new project, open an existing one, and list
 * what exists. All paths are validated against the configured sandbox root.
 */
export function registerPlaceTools(server: McpServer, ctx: ToolContext): void {
  const fs = new NodeHostFileSystem();

  server.registerTool(
    "list_place_templates",
    {
      title: "List place templates",
      description:
        "List the templates create_place_file can generate (baseplate, flat ground, empty) with what each one " +
        "contains, plus the configured places directory and sandbox root.",
      inputSchema: {},
    },
    async () =>
      textResult({
        templates: PLACE_TEMPLATES,
        placesDir: ctx.config.placesDir,
        placesRoot: ctx.config.placesRoot,
        format: ".rbxlx (Roblox XML place format)",
      }),
  );

  server.registerTool(
    "create_place_file",
    {
      title: "Create a new place file",
      description:
        "Create a brand-new Roblox place (.rbxlx) on disk from a template, without Studio being involved. This " +
        "is the 'create project' entry point: create_place_file -> launch_studio(placeFilePath) -> build with the " +
        "instance/script/scaffold tools -> save_project. Pass a bare name to write into the configured places " +
        "directory, or an absolute path inside the sandbox root.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(120)
          .optional()
          .describe('Place name, e.g. "PetSimulator" (".rbxlx" is appended if missing).'),
        path: z
          .string()
          .max(1000)
          .optional()
          .describe("Explicit destination path instead of name; must end in .rbxlx and stay inside the sandbox."),
        template: z
          .enum(templateIds)
          .default("baseplate")
          .describe("Which template to generate (see list_place_templates)."),
        overwrite: z.boolean().default(false).describe("Replace the file if it already exists."),
      },
    },
    async ({ name, path, template, overwrite }) => {
      if (!name && !path) return errorResult("Pass either name or path.");
      if (name && path) return errorResult("Pass either name or path, not both.");
      try {
        const raw = path ?? (name as string).replace(/\.rbxlx?$/i, "") + ".rbxlx";
        const destination = resolvePlacePath(raw, {
          root: ctx.config.placesRoot,
          defaultDir: ctx.config.placesDir,
          xmlOnly: true,
        });
        const created = createPlaceFile({ path: destination, template, overwrite }, fs);
        return textResult({
          ...created,
          next: `Open it with launch_studio { placeFilePath: "${destination}" }, then build. ` +
            "save_project (Ctrl+S) saves straight back into this file - no Save As dialog.",
        });
      } catch (err) {
        return nativeErrorResult("Creating the place file", err);
      }
    },
  );

  server.registerTool(
    "open_place_file",
    {
      title: "Open a place file in Studio",
      description:
        "Open an existing local place file (.rbxl or .rbxlx) in Roblox Studio and wait for the plugin's edit " +
        "peer to connect. This is the 'open project' entry point. The file is inspected first, so a wrong path or " +
        "a corrupt file is reported before Studio is launched.",
      inputSchema: {
        path: z.string().min(1).max(1000).describe("Path to the .rbxl/.rbxlx file (absolute, or relative to the places directory)."),
        waitForPlugin: z.boolean().default(true),
        timeoutMs: z.number().int().min(5_000).max(600_000).default(180_000),
      },
    },
    async ({ path, waitForPlugin, timeoutMs }) => {
      try {
        const resolved = resolvePlacePath(path, {
          root: ctx.config.placesRoot,
          defaultDir: ctx.config.placesDir,
        });
        const info = describePlaceFile(resolved, fs);
        if (!info.exists) {
          return errorResult(
            `No place file at ${resolved}. Use list_place_files to see what exists, or create_place_file to make one.`,
          );
        }
        if (info.bytes === 0) {
          return errorResult(`${resolved} is empty (0 bytes), so Studio cannot open it.`);
        }
        if (info.format === "unknown") {
          return errorResult(
            `${resolved} does not look like a Roblox place file (expected an XML place starting with <roblox ` +
              "or a binary place starting with <roblox!).",
          );
        }

        const launch = await launchStudioAndWait(ctx, {
          placeFilePath: resolved,
          waitForPlugin,
          timeoutMs,
        });
        return textResult({ ...launch, place: info });
      } catch (err) {
        return nativeErrorResult("Opening the place file", err);
      }
    },
  );

  server.registerTool(
    "list_place_files",
    {
      title: "List local place files",
      description:
        "List .rbxl/.rbxlx place files in a directory (newest first) so you can find an existing project to open. " +
        "Defaults to the configured places directory; any directory inside the sandbox root can be listed.",
      inputSchema: {
        directory: z
          .string()
          .max(1000)
          .optional()
          .describe("Directory to scan (defaults to the configured places directory)."),
        recursive: z.boolean().default(false).describe("Also scan subdirectories."),
        maxResults: z.number().int().min(1).max(500).default(100),
      },
    },
    async ({ directory, recursive, maxResults }) => {
      try {
        const target = directory
          ? resolvePlaceDirectory(directory, {
              root: ctx.config.placesRoot,
              defaultDir: ctx.config.placesDir,
            })
          : ctx.config.placesDir;

        if (!fs.exists(target)) {
          return textResult({
            directory: target,
            files: [],
            truncated: false,
            note: "The directory does not exist yet; create_place_file will create it on demand.",
          });
        }
        return textResult(listPlaceFiles({ directory: target, recursive, maxResults }, fs));
      } catch (err) {
        return nativeErrorResult("Listing place files", err);
      }
    },
  );
}
