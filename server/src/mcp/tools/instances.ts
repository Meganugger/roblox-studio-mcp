import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  errorResult,
  instancePathSchema,
  propertiesSchema,
  runCommand,
  ToolContext,
} from "../tool-helpers.js";

const classNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9]+$/, "Class names are alphanumeric, e.g. Part, Model, Folder, ScreenGui.");

const instanceNameSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((n) => !n.includes(".") && !n.includes("/") && !n.includes("["), {
    message: 'Instance names must not contain ".", "/" or "[" (they would break path addressing).',
  });

export function registerInstanceTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_instance_tree",
    {
      title: "Get Explorer tree",
      description:
        "Return the Explorer hierarchy under a path as a nested tree of {name, className, path, children}. " +
        "Use maxDepth to bound the response; use classFilter to only include matching classes (ancestors of " +
        "matches are kept). Start with path 'game' and maxDepth 2 to orient yourself.",
      inputSchema: {
        path: instancePathSchema.describe('Root of the tree, e.g. "game" or "game.Workspace".'),
        maxDepth: z.number().int().min(1).max(25).default(4).describe("How many levels to descend."),
        classFilter: z.string().max(100).optional().describe('Optional class filter, e.g. "Script" or "BasePart".'),
        maxNodes: z.number().int().min(1).max(20000).default(3000).describe("Hard cap on returned nodes."),
      },
    },
    async ({ path, maxDepth, classFilter, maxNodes }) =>
      runCommand(ctx, "GetInstanceTree", { path, maxDepth, classFilter, maxNodes }),
  );

  server.registerTool(
    "get_instance",
    {
      title: "Inspect an instance",
      description:
        "Return an instance's class, path and readable properties (typed values are tagged, e.g. " +
        '{"$type":"Vector3","value":[0,10,0]}). Also lists attributes and child names.',
      inputSchema: {
        path: instancePathSchema,
        properties: z
          .array(z.string().min(1).max(100))
          .max(200)
          .optional()
          .describe("Optional explicit property whitelist; defaults to common properties for the class."),
      },
    },
    async ({ path, properties }) => runCommand(ctx, "GetInstance", { path, properties }),
  );

  server.registerTool(
    "get_instance_children",
    {
      title: "List children",
      description: "List direct children of an instance: name, className and path for each.",
      inputSchema: { path: instancePathSchema },
    },
    async ({ path }) => runCommand(ctx, "GetInstanceChildren", { path }),
  );

  server.registerTool(
    "search_instances",
    {
      title: "Search instances",
      description:
        "Search the DataModel for instances by name substring and/or class (IsA-aware). Returns matching paths.",
      inputSchema: {
        root: instancePathSchema.default("game").describe("Where to search from."),
        nameContains: z.string().max(200).optional().describe("Case-insensitive name substring."),
        className: z.string().max(100).optional().describe('IsA class, e.g. "BasePart", "GuiObject".'),
        maxResults: z.number().int().min(1).max(2000).default(200),
      },
    },
    async ({ root, nameContains, className, maxResults }) => {
      if (!nameContains && !className) {
        return runCommand(ctx, "SearchInstances", { root, maxResults });
      }
      return runCommand(ctx, "SearchInstances", { root, nameContains, className, maxResults });
    },
  );

  server.registerTool(
    "create_instance",
    {
      title: "Create instance",
      description:
        "Create a single instance of the given class under a parent, optionally setting a name and properties. " +
        "Returns the created instance's path. For many objects at once, prefer create_instances_batch.",
      inputSchema: {
        className: classNameSchema,
        parentPath: instancePathSchema,
        name: instanceNameSchema.optional(),
        properties: propertiesSchema.optional(),
      },
    },
    async ({ className, parentPath, name, properties }) =>
      runCommand(ctx, "CreateInstance", { className, parentPath, name, properties }),
  );

  server.registerTool(
    "create_instances_batch",
    {
      title: "Create instances (batch)",
      description:
        "Create up to 500 instances in one atomic Studio operation (single undo waypoint). Items are created " +
        "in order; an item's parentPath may reference an instance created earlier in the same batch. " +
        "Ideal for building maps, UI hierarchies and folder structures quickly.",
      inputSchema: {
        items: z
          .array(
            z.object({
              className: classNameSchema,
              parentPath: instancePathSchema,
              name: instanceNameSchema.optional(),
              properties: propertiesSchema.optional(),
            }),
          )
          .min(1)
          .max(500),
      },
    },
    async ({ items }) => runCommand(ctx, "CreateInstancesBatch", { items }, 90_000),
  );

  server.registerTool(
    "set_instance_properties",
    {
      title: "Set properties",
      description:
        "Set one or more properties on an existing instance. See create_instance for the value encoding. " +
        "Also supports attributes via the special key prefix '@', e.g. {\"@Health\": 100}.",
      inputSchema: {
        path: instancePathSchema,
        properties: propertiesSchema,
      },
    },
    async ({ path, properties }) => runCommand(ctx, "SetProperties", { path, properties }),
  );

  server.registerTool(
    "mass_set_properties",
    {
      title: "Set properties on many instances (bulk)",
      description:
        "Set the same properties on many instances in one atomic Studio operation (single undo waypoint). " +
        "Targets are either an explicit list of paths, or a filter (root + className and/or nameContains). " +
        "Perfect for large places: re-materialize every wall, anchor all parts under a folder, retexture a " +
        "whole map. Returns how many instances were updated plus any per-instance failures. " +
        "Use dryRun=true to preview which instances would match without changing anything.",
      inputSchema: {
        paths: z.array(instancePathSchema).max(2000).optional().describe("Explicit target paths."),
        root: instancePathSchema.optional().describe("Filter mode: search under this root."),
        className: z.string().max(100).optional().describe('Filter: IsA class, e.g. "BasePart".'),
        nameContains: z.string().max(200).optional().describe("Filter: case-insensitive name substring."),
        properties: propertiesSchema,
        maxInstances: z.number().int().min(1).max(5000).default(1000).describe("Safety cap on matched instances."),
        dryRun: z.boolean().default(false).describe("Only report matching instances; change nothing."),
      },
    },
    async ({ paths, root, className, nameContains, properties, maxInstances, dryRun }) => {
      if (!paths && !root) {
        return errorResult("Provide either `paths` or a filter (`root` plus className/nameContains).");
      }
      if (root && !className && !nameContains) {
        return errorResult(
          "Filter mode needs at least one of className / nameContains (refusing to bulk-edit every descendant).",
        );
      }
      return runCommand(
        ctx,
        "MassSetProperties",
        { paths, root, className, nameContains, properties, maxInstances, dryRun },
        120_000,
      );
    },
  );

  server.registerTool(
    "rename_instance",
    {
      title: "Rename instance",
      description: "Rename an instance. Returns the new path.",
      inputSchema: { path: instancePathSchema, newName: instanceNameSchema },
    },
    async ({ path, newName }) => runCommand(ctx, "RenameInstance", { path, newName }),
  );

  server.registerTool(
    "move_instance",
    {
      title: "Move (reparent) instance",
      description: "Reparent an instance to a new parent. Returns the new path.",
      inputSchema: { path: instancePathSchema, newParentPath: instancePathSchema },
    },
    async ({ path, newParentPath }) => runCommand(ctx, "MoveInstance", { path, newParentPath }),
  );

  server.registerTool(
    "clone_instance",
    {
      title: "Clone instance",
      description:
        "Clone an instance (deep copy) under a parent (defaults to the original's parent). Returns the clone's path.",
      inputSchema: {
        path: instancePathSchema,
        newParentPath: instancePathSchema.optional(),
        newName: instanceNameSchema.optional(),
      },
    },
    async ({ path, newParentPath, newName }) =>
      runCommand(ctx, "CloneInstance", { path, newParentPath, newName }),
  );

  server.registerTool(
    "delete_instance",
    {
      title: "Delete instance",
      description:
        "Destroy an instance and all of its descendants. Protected containers (game, core services) cannot be deleted.",
      inputSchema: { path: instancePathSchema },
    },
    async ({ path }) => runCommand(ctx, "DeleteInstance", { path }),
  );

  server.registerTool(
    "get_selection",
    {
      title: "Get Studio selection",
      description: "Return the paths currently selected in the Studio Explorer.",
      inputSchema: {},
    },
    async () => runCommand(ctx, "GetSelection", {}),
  );

  server.registerTool(
    "set_selection",
    {
      title: "Set Studio selection",
      description: "Select instances in the Studio Explorer (useful to show the user what you changed).",
      inputSchema: { paths: z.array(instancePathSchema).max(100) },
    },
    async ({ paths }) => runCommand(ctx, "SetSelection", { paths }),
  );
}
