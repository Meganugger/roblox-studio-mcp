import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  errorResult,
  imageResult,
  nativeErrorResult,
  sessionIdsOf,
  sleep,
  textResult,
  ToolContext,
  ToolResult,
  waitForNewPeer,
} from "../tool-helpers.js";
import { SHORTCUT_NAMES } from "../../native/shortcuts.js";
import { resolvePlacePath } from "../../native/places.js";

/**
 * Launch Studio (optionally with a place) and, unless told otherwise, wait for
 * the plugin's edit peer to connect. Shared by launch_studio and
 * open_place_file so both behave identically.
 */
export async function launchStudioAndWait(
  ctx: ToolContext,
  options: { placeFilePath?: string; placeId?: number; waitForPlugin: boolean; timeoutMs: number },
): Promise<Record<string, unknown>> {
  const known = sessionIdsOf(ctx, "edit");
  const launch = await ctx.native.launchStudio({
    placeFilePath: options.placeFilePath,
    placeId: options.placeId,
  });
  if (!options.waitForPlugin) {
    return { ...launch, placeFilePath: options.placeFilePath, waitedForPlugin: false };
  }

  const peer = await waitForNewPeer(ctx, "edit", known, options.timeoutMs);
  return {
    ...launch,
    placeFilePath: options.placeFilePath,
    waitedForPlugin: true,
    pluginConnected: peer !== null,
    peer,
    ...(peer
      ? {}
      : {
          hint:
            "Studio was launched but no edit peer connected within the timeout. Check that the plugin is " +
            "installed (--install-plugin), that Studio finished loading the place, and that the plugin widget " +
            "shows 'Connected'. get_host_capabilities and get_studio_status help diagnose this.",
        }),
  };
}

export function registerNativeTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_host_capabilities",
    {
      title: "Get native host capabilities",
      description:
        "Report what this machine allows the server to do natively: whether Roblox Studio was found (and where), " +
        "which Studio processes are running, whether window control / keyboard-shortcut input / screenshots are " +
        "available (and via which OS tool), which security gates are enabled, and the allowlisted Studio " +
        "shortcuts. Call this before launch_studio, capture_studio_screenshot, send_studio_shortcut or " +
        "start_play_solo: every unavailable capability comes with the exact fix (install a tool, set an " +
        "environment variable, grant an OS permission).",
      inputSchema: {},
    },
    async () => textResult(await ctx.native.capabilities()),
  );

  server.registerTool(
    "get_studio_processes",
    {
      title: "List Roblox Studio processes",
      description:
        "List the Roblox Studio processes running on this machine (pid, process name, window title). Use it to " +
        "check whether Studio is already open before launching another instance.",
      inputSchema: {},
    },
    async () => {
      try {
        const processes = await ctx.native.studioProcesses();
        return textResult({ running: processes.length > 0, count: processes.length, processes });
      } catch (err) {
        return nativeErrorResult("Listing Studio processes", err);
      }
    },
  );

  server.registerTool(
    "launch_studio",
    {
      title: "Launch Roblox Studio",
      description:
        "Start Roblox Studio on this machine, optionally opening a local place file (created by " +
        "create_place_file) or a cloud placeId, then wait for the MCP plugin's edit peer to connect. This is how " +
        "you go from 'no Studio open' to a fully controllable session without the user doing anything. " +
        "Requires the plugin to be installed (server CLI: --install-plugin) and to have been connected once so " +
        "it remembers the auth token; otherwise Studio opens but no peer appears and you must ask the user to " +
        "paste the token in the MCP widget.",
      inputSchema: {
        placeFilePath: z
          .string()
          .max(1000)
          .optional()
          .describe("Absolute path (or a name inside the places directory) of a .rbxl/.rbxlx file to open."),
        placeId: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Cloud placeId to open in edit mode (the user must be signed in to Studio)."),
        waitForPlugin: z.boolean().default(true).describe("Wait until the plugin's edit peer connects."),
        timeoutMs: z
          .number()
          .int()
          .min(5_000)
          .max(600_000)
          .default(180_000)
          .describe("How long to wait for the plugin peer (Studio can take a while to boot)."),
      },
    },
    async ({ placeFilePath, placeId, waitForPlugin, timeoutMs }) => {
      if (placeFilePath && placeId !== undefined) {
        return errorResult("Pass either placeFilePath or placeId, not both.");
      }
      try {
        let resolvedPlace: string | undefined;
        if (placeFilePath) {
          resolvedPlace = resolvePlacePath(placeFilePath, {
            root: ctx.config.placesRoot,
            defaultDir: ctx.config.placesDir,
          });
        }
        return textResult(
          await launchStudioAndWait(ctx, {
            placeFilePath: resolvedPlace,
            placeId,
            waitForPlugin,
            timeoutMs,
          }),
        );
      } catch (err) {
        return nativeErrorResult("Launching Roblox Studio", err);
      }
    },
  );

  server.registerTool(
    "close_studio",
    {
      title: "Close Roblox Studio",
      description:
        "Close Roblox Studio. By default this asks the window to close, which lets Studio prompt about unsaved " +
        "changes; force=true kills the process and DISCARDS unsaved work. Call save_project first.",
      inputSchema: {
        force: z
          .boolean()
          .default(false)
          .describe("Kill the process instead of asking it to close. Unsaved changes are lost."),
      },
    },
    async ({ force }) => {
      try {
        const result = await ctx.native.closeStudio(force);
        return textResult({
          ...result,
          note: force
            ? "Studio was terminated; any unsaved changes were discarded."
            : "Studio was asked to close. If the place has unsaved changes it will show a confirmation dialog " +
              "that the user (or send_studio_shortcut) must answer.",
        });
      } catch (err) {
        return nativeErrorResult("Closing Roblox Studio", err);
      }
    },
  );

  server.registerTool(
    "focus_studio_window",
    {
      title: "Focus the Studio window",
      description:
        "Bring the Roblox Studio window to the foreground and report its title and geometry. Useful before " +
        "screenshots or shortcuts, and to confirm which place Studio currently has open.",
      inputSchema: {},
    },
    async () => {
      try {
        return textResult(await ctx.native.focusWindow());
      } catch (err) {
        return nativeErrorResult("Focusing the Studio window", err);
      }
    },
  );

  server.registerTool(
    "send_studio_shortcut",
    {
      title: "Send a Studio keyboard shortcut",
      description:
        "Send one allowlisted Roblox Studio shortcut to the Studio window: play (F5), run (F8), stop (Shift+F5), " +
        "save (Ctrl/Cmd+S), saveAs, undo, redo, escape, confirm. Studio is focused first and the target window " +
        "is verified to be Roblox Studio before any key is delivered - arbitrary text/keys cannot be injected. " +
        "Prefer start_play_solo / stop_play_solo / save_project, which wrap these with the right waiting and " +
        "verification; use this tool for escape/confirm (dismissing dialogs) and undo/redo.",
      inputSchema: {
        shortcut: z.enum(SHORTCUT_NAMES).describe("Which allowlisted Studio action to trigger."),
      },
    },
    async ({ shortcut }) => {
      try {
        return textResult(await ctx.native.sendShortcut(shortcut));
      } catch (err) {
        return nativeErrorResult(`Sending the "${shortcut}" shortcut`, err);
      }
    },
  );

  server.registerTool(
    "capture_studio_screenshot",
    {
      title: "Screenshot the Studio window",
      description:
        "Capture what Roblox Studio currently shows (3D viewport, Explorer, Output, dialogs) as a PNG and return " +
        "it as an image you can actually look at, plus the saved file path. This is the only way to visually " +
        "verify a build: frame the subject with set_camera first, then capture. Set fullScreen=true to include " +
        "everything on screen (e.g. a dialog outside the Studio window). Images are downscaled to maxWidth " +
        "before being returned.",
      inputSchema: {
        maxWidth: z
          .number()
          .int()
          .min(320)
          .max(3840)
          .default(1280)
          .describe("Downscale the capture to at most this width (keeps responses small)."),
        fullScreen: z.boolean().default(false).describe("Capture the whole screen instead of the Studio window."),
        label: z
          .string()
          .max(60)
          .optional()
          .describe('Short label used in the file name, e.g. "lobby-after-lighting".'),
        includeImage: z
          .boolean()
          .default(true)
          .describe("Return the image inline. Set false to only save it to disk and get the path."),
      },
    },
    async ({ maxWidth, fullScreen, label, includeImage }) => {
      try {
        const shot = await ctx.native.captureScreenshot({
          maxWidth,
          fullScreen,
          label,
          inline: includeImage,
        });
        const metadata = {
          path: shot.path,
          width: shot.width,
          height: shot.height,
          bytes: shot.bytes,
          scaled: shot.scaled,
          via: shot.via,
          inlined: shot.inlined,
        };
        if (shot.base64) return imageResult(shot.base64, metadata);
        return textResult({
          ...metadata,
          note: includeImage
            ? "The image was too large to inline; read it from `path` or lower maxWidth."
            : "Image saved to disk only (includeImage=false).",
        });
      } catch (err) {
        return nativeErrorResult("Capturing a Studio screenshot", err);
      }
    },
  );

  server.registerTool(
    "start_play_solo",
    {
      title: "Start a real play session (F5)",
      description:
        "Press Play in Studio (F5) and wait for the playtest peers to connect. Unlike start_playtest (Run mode, " +
        "server simulation only), this starts a full play session with a player character, so the whole game " +
        "runs exactly as a player experiences it. Once the server peer connects you can use eval_server_runtime, " +
        "eval_client_runtime and per-peer get_output_logs / get_errors to debug live. This closes the autonomous " +
        "loop: build -> start_play_solo -> get_errors -> fix -> stop_play_solo -> repeat, with no human input. " +
        "Requires native input to be enabled and the plugin to have a saved token (it auto-connects the playtest " +
        "DataModels).",
      inputSchema: {
        waitForPeers: z.boolean().default(true).describe("Wait for the playtest server peer to connect."),
        timeoutMs: z
          .number()
          .int()
          .min(5_000)
          .max(300_000)
          .default(90_000)
          .describe("How long to wait for the playtest peers."),
      },
    },
    async ({ waitForPeers, timeoutMs }) => {
      const knownServers = sessionIdsOf(ctx, "server");
      const knownClients = sessionIdsOf(ctx, "client");
      let sent;
      try {
        sent = await ctx.native.sendShortcut("play");
      } catch (err) {
        return nativeErrorResult("Starting play solo", err);
      }
      if (!waitForPeers) {
        return textResult({ ...sent, waitedForPeers: false, peers: ctx.sessions.list() });
      }

      const serverPeer = await waitForNewPeer(ctx, "server", knownServers, timeoutMs);
      // The client DataModel starts slightly after the server one; give it a moment.
      const clientPeer = serverPeer
        ? await waitForNewPeer(ctx, "client", knownClients, Math.min(30_000, timeoutMs))
        : null;

      const result: ToolResult = textResult({
        ...sent,
        waitedForPeers: true,
        running: serverPeer !== null,
        serverPeer,
        clientPeer,
        peers: ctx.sessions.list(),
        ...(serverPeer
          ? {
              next:
                "Use eval_server_runtime / eval_client_runtime for live state, get_errors with peer=\"server\" " +
                'and peer="client" for failures, then stop_play_solo when done.',
            }
          : {
              hint:
                "Play mode did not produce a server peer. Either Studio did not enter play mode (check " +
                "get_host_capabilities and capture_studio_screenshot for a modal dialog), or the plugin has no " +
                "saved token for playtest DataModels (connect once from the MCP widget in edit mode).",
            }),
      });
      return result;
    },
  );

  server.registerTool(
    "stop_play_solo",
    {
      title: "Stop the play session (Shift+F5)",
      description:
        "Press Stop in Studio (Shift+F5) to end a play session and return to edit mode. Playtest peers stop " +
        "polling immediately and disappear from get_connected_peers once their timeout elapses.",
      inputSchema: {
        settleMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .default(1_500)
          .describe("How long to wait after pressing Stop before reporting peer state."),
      },
    },
    async ({ settleMs }) => {
      try {
        const sent = await ctx.native.sendShortcut("stop");
        if (settleMs > 0) await sleep(settleMs);
        return textResult({
          ...sent,
          peers: ctx.sessions.list(),
          note:
            "Studio returned to edit mode. Playtest peers are torn down with their DataModels; they may still be " +
            "listed until their connection times out.",
        });
      } catch (err) {
        return nativeErrorResult("Stopping the play session", err);
      }
    },
  );
}
