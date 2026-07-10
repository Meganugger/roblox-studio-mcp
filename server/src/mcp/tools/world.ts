import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, propertiesSchema, runCommand, ToolContext } from "../tool-helpers.js";

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

export function registerWorldTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "generate_terrain",
    {
      title: "Generate terrain",
      description:
        "Create smooth terrain. Shapes: 'block' (FillBlock), 'ball' (FillBall), or 'hills' (procedural " +
        "heightmap using Perlin noise - great for natural-looking maps). Regions are capped at 2048 studs per " +
        "axis to keep Studio responsive. Materials use Enum.Material names (Grass, Rock, Sand, Water, Snow...).",
      inputSchema: {
        shape: z.enum(["block", "ball", "hills"]),
        center: vec3.describe("Center position [x, y, z] in studs."),
        size: vec3.describe("Region size [x, y, z] in studs (for 'ball', x is used as radius)."),
        material: z.string().max(50).default("Grass").describe('Material name, e.g. "Grass".'),
        seed: z.number().int().optional().describe("Noise seed for 'hills' (reproducible maps)."),
        amplitude: z.number().min(1).max(500).default(40).describe("Hill height in studs ('hills' only)."),
        frequency: z.number().min(0.001).max(1).default(0.02).describe("Noise frequency ('hills' only)."),
      },
    },
    async ({ shape, center, size, material, seed, amplitude, frequency }) => {
      if (size.some((axis) => Math.abs(axis) > 2048)) {
        return errorResult("Terrain region too large: each axis must be <= 2048 studs.");
      }
      return runCommand(
        ctx,
        "GenerateTerrain",
        { shape, center, size, material, seed, amplitude, frequency },
        120_000,
      );
    },
  );

  server.registerTool(
    "clear_terrain",
    {
      title: "Clear terrain",
      description: "Remove all smooth terrain from the place (Terrain:Clear()). Cannot be limited to a region.",
      inputSchema: {},
    },
    async () => runCommand(ctx, "ClearTerrain", {}, 60_000),
  );

  server.registerTool(
    "set_lighting",
    {
      title: "Configure lighting & atmosphere",
      description:
        "Set Lighting service properties and optionally apply a preset mood. Presets create/configure " +
        "Atmosphere, Bloom, ColorCorrection and Sky children. Presets: 'day', 'sunset', 'night', 'foggy-horror', " +
        "'neon-city'. Pass extra properties to fine-tune after the preset.",
      inputSchema: {
        preset: z.enum(["day", "sunset", "night", "foggy-horror", "neon-city"]).optional(),
        properties: propertiesSchema
          .optional()
          .describe('Extra Lighting properties, e.g. {"Brightness": 2, "ClockTime": 14}.'),
      },
    },
    async ({ preset, properties }) => runCommand(ctx, "SetLighting", { preset, properties }),
  );

  server.registerTool(
    "insert_asset",
    {
      title: "Insert asset from Roblox catalog",
      description:
        "Insert a free model/asset by assetId using InsertService and parent it at the given path. " +
        "SECURITY: inserted models can contain scripts. The plugin strips all scripts from inserted assets " +
        "unless allowScripts is true - only enable that for assets you trust.",
      inputSchema: {
        assetId: z.number().int().min(1),
        parentPath: z.string().default("game.Workspace"),
        allowScripts: z.boolean().default(false),
      },
    },
    async ({ assetId, parentPath, allowScripts }) => {
      if (!ctx.config.allowInsertAsset) {
        return errorResult("insert_asset is disabled on this server (ROBLOX_MCP_ALLOW_INSERT_ASSET=0).");
      }
      return runCommand(ctx, "InsertAsset", { assetId, parentPath, allowScripts }, 60_000);
    },
  );

  server.registerTool(
    "set_camera",
    {
      title: "Move Studio camera",
      description:
        "Point the Studio editor camera at a position (with optional focus target). Useful to 'look at' what " +
        "you just built, or to frame an area before asking the user to review it.",
      inputSchema: {
        position: vec3.describe("Camera position [x, y, z]."),
        lookAt: vec3.optional().describe("Point the camera should face; defaults to origin-ward."),
      },
    },
    async ({ position, lookAt }) => runCommand(ctx, "SetCamera", { position, lookAt }),
  );
}
