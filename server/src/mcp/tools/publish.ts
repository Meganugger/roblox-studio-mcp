import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cloudErrorResult, errorResult, textResult, ToolContext } from "../tool-helpers.js";
import { NodeHostFileSystem } from "../../native/runner.js";
import { describePlaceFile, resolvePlacePath } from "../../native/places.js";

/**
 * Roblox Open Cloud tools (v4 "publishing").
 *
 * This is the last mile of the autonomous loop: everything else edits a local
 * Studio session, these tools put the result on Roblox. They are gated off by
 * default (`ROBLOX_MCP_ALLOW_PUBLISH`) because they are the only tools whose
 * effects reach real players, and they never expose the API key.
 */

const universeIdSchema = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe(
    "Universe (experience) id. Defaults to ROBLOX_MCP_UNIVERSE_ID. This is NOT the placeId: find it in the " +
      "Creator Dashboard under the experience's Settings.",
  );

const placeIdSchema = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe("Place id (the number in the game URL). Defaults to ROBLOX_MCP_PLACE_ID.");

export function registerPublishTools(server: McpServer, ctx: ToolContext): void {
  const fs = new NodeHostFileSystem();

  server.registerTool(
    "get_publish_capabilities",
    {
      title: "Get Roblox publishing capabilities",
      description:
        "Report whether this server can publish to Roblox: whether the publishing gate is enabled, whether an " +
        "Open Cloud API key is configured (and where it came from - only a fingerprint is shown, never the key), " +
        "the default universe/place, the universe allowlist, the upload size limit, and exactly which API-key " +
        "permissions each publish tool needs. Call this before publish_place: every missing prerequisite comes " +
        "back with the precise fix, so you can tell the user what to configure instead of retrying.",
      inputSchema: {},
    },
    async () => textResult(ctx.cloud.status()),
  );

  server.registerTool(
    "publish_place",
    {
      title: "Publish a place file to Roblox",
      description:
        "Upload a local place file (.rbxlx or .rbxl) to Roblox as a new version of a place. This is how work " +
        "leaves the local machine: build in Studio -> save_project (real Ctrl+S) -> publish_place on that file. " +
        'versionType="Saved" (the default) uploads the version WITHOUT releasing it, so live players are ' +
        'unaffected; versionType="Published" makes it the version new servers use - only do that when the user ' +
        "asked to go live. Existing servers keep running the old version until they close or " +
        "restart_universe_servers is called. Requires the publishing gate and an Open Cloud API key " +
        "(get_publish_capabilities explains any missing prerequisite).",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .max(1000)
          .describe(
            "Place file to upload: absolute, or a name inside the configured places directory. Must be inside " +
              "the places sandbox root.",
          ),
        universeId: universeIdSchema,
        placeId: placeIdSchema,
        versionType: z
          .enum(["Saved", "Published"])
          .default("Saved")
          .describe(
            'How to release the upload. "Saved" stores the version without releasing it (safe default). ' +
              '"Published" makes it live for new servers.',
          ),
      },
    },
    async ({ path, universeId, placeId, versionType }) => {
      try {
        const resolved = resolvePlacePath(path, {
          root: ctx.config.placesRoot,
          defaultDir: ctx.config.placesDir,
        });
        const info = describePlaceFile(resolved, fs);
        if (!info.exists) {
          return errorResult(
            `No place file at ${resolved}. Use list_place_files to see what exists, or save_project to write the ` +
              "current Studio session to disk first.",
          );
        }
        if (info.format === "unknown") {
          return errorResult(
            `${resolved} does not look like a Roblox place file (expected an XML place starting with <roblox or a ` +
              "binary place starting with <roblox!). Refusing to upload it.",
          );
        }

        const outcome = await ctx.cloud.publishPlace({
          universeId,
          placeId,
          versionType,
          contents: fs.readFile(resolved),
          format: info.format,
        });
        return textResult({
          ...outcome,
          path: resolved,
          modifiedAt: info.modifiedAt,
          next:
            versionType === "Published"
              ? "The version is live for new servers. Call restart_universe_servers to move players on existing " +
                "servers onto it, or leave them to finish naturally."
              : 'Saved without releasing. Re-run with versionType="Published" when the user wants it live.',
        });
      } catch (err) {
        return cloudErrorResult("Publishing the place", err);
      }
    },
  );

  server.registerTool(
    "get_universe_info",
    {
      title: "Get Roblox universe info",
      description:
        "Read an experience's Open Cloud configuration: display name, description, owner (user or group), " +
        "visibility, age rating, supported devices and voice-chat setting. Use it to confirm the API key really " +
        "points at the experience you think it does before publishing anything.",
      inputSchema: { universeId: universeIdSchema },
    },
    async ({ universeId }) => {
      try {
        return textResult(await ctx.cloud.getUniverse(universeId));
      } catch (err) {
        return cloudErrorResult("Reading the universe", err);
      }
    },
  );

  server.registerTool(
    "get_place_info",
    {
      title: "Get Roblox place info",
      description:
        "Read a place's Open Cloud configuration: display name, description, server size and timestamps. " +
        "Confirms which place a placeId refers to, and shows the current values before update_place_config.",
      inputSchema: { universeId: universeIdSchema, placeId: placeIdSchema },
    },
    async ({ universeId, placeId }) => {
      try {
        return textResult(await ctx.cloud.getPlace(universeId, placeId));
      } catch (err) {
        return cloudErrorResult("Reading the place", err);
      }
    },
  );

  server.registerTool(
    "update_place_config",
    {
      title: "Update a place's configuration",
      description:
        "Change a place's display name, description and/or maximum server size on Roblox. Only the fields you " +
        "pass are modified (the others are left untouched). These are the player-visible listing details, so " +
        "confirm the wording with the user first; get_place_info shows the current values.",
      inputSchema: {
        universeId: universeIdSchema,
        placeId: placeIdSchema,
        displayName: z.string().min(1).max(50).optional().describe("New place name shown to players."),
        description: z.string().max(1000).optional().describe("New place description."),
        serverSize: z
          .number()
          .int()
          .min(1)
          .max(700)
          .optional()
          .describe("Maximum players per server. Roblox rejects values outside what the experience allows."),
      },
    },
    async ({ universeId, placeId, displayName, description, serverSize }) => {
      try {
        return textResult(
          await ctx.cloud.updatePlace({ universeId, placeId, displayName, description, serverSize }),
        );
      } catch (err) {
        return cloudErrorResult("Updating the place configuration", err);
      }
    },
  );

  server.registerTool(
    "restart_universe_servers",
    {
      title: "Restart the experience's live servers",
      description:
        "Shut down every running server of the experience so players rejoin on the latest published version. " +
        "This DISCONNECTS everyone currently playing (Roblox reconnects them into new servers), so only do it " +
        'when the user explicitly asks to roll out a build. It has no effect on versionType="Saved" uploads, ' +
        "which were never released.",
      inputSchema: { universeId: universeIdSchema },
    },
    async ({ universeId }) => {
      try {
        const result = await ctx.cloud.restartServers(universeId);
        return textResult({
          ...result,
          note:
            "Roblox is closing the running servers. Players are moved to new servers on the published version; " +
            "in-progress rounds are lost.",
        });
      } catch (err) {
        return cloudErrorResult("Restarting the universe servers", err);
      }
    },
  );

  server.registerTool(
    "publish_universe_message",
    {
      title: "Send a MessagingService message to live servers",
      description:
        "Publish a MessagingService message to every running server of the experience, as received by " +
        "MessagingService:SubscribeAsync(topic) in game code. Use it to trigger live-ops behaviour you have " +
        "already scripted (reload config, start an event, announce something) without restarting servers. The " +
        "game must already subscribe to the topic; this tool cannot run arbitrary code remotely.",
      inputSchema: {
        universeId: universeIdSchema,
        topic: z
          .string()
          .min(1)
          .max(80)
          .describe("Topic name the game subscribes to with MessagingService:SubscribeAsync."),
        message: z
          .string()
          .min(1)
          .max(1024)
          .describe("Message payload (Roblox caps this at 1 KiB). Encode structured data as JSON yourself."),
      },
    },
    async ({ universeId, topic, message }) => {
      try {
        return textResult(await ctx.cloud.publishMessage({ universeId, topic, message }));
      } catch (err) {
        return cloudErrorResult("Publishing the message", err);
      }
    },
  );
}
