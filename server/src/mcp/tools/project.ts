import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { instancePathSchema, runCommand, textResult, ToolContext } from "../tool-helpers.js";

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
      title: "Save the place",
      description:
        "Persist the open place. Roblox forbids plugins from saving silently, so this sends the real " +
        "Ctrl+S / Cmd+S keystroke to the Studio window (native input) - which saves straight to the file for a " +
        "place opened from disk. If native input is unavailable or disabled it falls back to a prominent " +
        "in-Studio notification asking the user to save. IMPORTANT: a place that has never been saved has no " +
        "file yet, so Ctrl+S opens Studio's Save As dialog; this tool detects that Studio stopped responding and " +
        'tells you, and `send_studio_shortcut escape` dismisses it. Prefer creating places with ' +
        "create_place_file so saving is always silent.",
      inputSchema: {
        message: z.string().max(300).optional().describe("Message shown in Studio when falling back to a notification."),
        native: z
          .boolean()
          .default(true)
          .describe("Send the real save keystroke. Set false to only notify the user inside Studio."),
      },
    },
    async ({ message, native }) => {
      if (native) {
        try {
          const sent = await ctx.native.sendShortcut("save");
          if (!ctx.sessions.editSession()) {
            // Without a connected plugin there is nothing to probe with.
            return textResult({
              keystrokeDelivered: true,
              keys: sent.keys,
              window: sent.window.title,
              verified: false,
              note:
                "The save keystroke was delivered to the Studio window, but no plugin peer is connected so the " +
                "result could not be verified. Connect the MCP plugin, or check visually with " +
                "capture_studio_screenshot.",
            });
          }
          // A modal Save As dialog blocks Studio; a ping tells us which happened.
          const ping = await runCommand(ctx, "Ping", { sentAt: Date.now() }, 6_000);
          return textResult({
            keystrokeDelivered: true,
            keys: sent.keys,
            window: sent.window.title,
            verified: true,
            studioResponsive: !ping.isError,
            saved: !ping.isError,
            ...(ping.isError
              ? {
                  warning:
                    "Studio stopped answering right after the save keystroke, which usually means a modal " +
                    "dialog is open (most likely Save As, because this place has never been saved to a file). " +
                    'Take a look with capture_studio_screenshot { fullScreen: true }; `send_studio_shortcut ' +
                    'escape` cancels the dialog. The user can then save once manually, or you can build the ' +
                    "next project from create_place_file so a file already exists.",
                }
              : {
                  note:
                    "The place was saved to its existing file. For a place opened from the cloud this saves " +
                    "locally; publishing to Roblox still requires the user.",
                }),
          });
        } catch (err) {
          const reason = String(err instanceof Error ? err.message : err);
          const notified = await runCommand(ctx, "RequestSave", { message });
          if (notified.isError) return notified;
          return textResult({
            keystrokeDelivered: false,
            nativeSaveUnavailable: reason,
            notifiedUserInStudio: true,
            note: "Native saving was not possible, so the user was asked inside Studio to press Ctrl+S.",
          });
        }
      }
      return runCommand(ctx, "RequestSave", { message });
    },
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
