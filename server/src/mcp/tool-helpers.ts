import { z } from "zod";
import { CommandName, isValidInstancePath } from "@roblox-studio-mcp/shared";
import { CommandTimeoutError, StudioCommandError } from "../bridge/command-queue.js";
import { HttpBridge } from "../bridge/http-bridge.js";
import { SessionRegistry, UnknownPeerError } from "../bridge/sessions.js";
import { ServerConfig } from "../config.js";

/** Shared context handed to every tool module. */
export interface ToolContext {
  sessions: SessionRegistry;
  bridge: HttpBridge;
  config: ServerConfig;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export function textResult(payload: unknown): ToolResult {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Dispatch a command to a Studio peer and format the response for the MCP
 * client. Connection problems and Studio-side errors become readable tool
 * errors instead of protocol failures, so the AI can react and retry.
 *
 * `peer` selects the target DataModel: "edit" (default), "server", "client",
 * or an explicit sessionId from get_connected_peers.
 */
export async function runCommand(
  ctx: ToolContext,
  name: CommandName,
  payload: Record<string, unknown>,
  timeoutMs?: number,
  peer: string = "edit",
): Promise<ToolResult> {
  let session;
  try {
    session = ctx.sessions.resolve(peer);
  } catch (err) {
    if (err instanceof UnknownPeerError) {
      const editHint =
        peer === "edit"
          ? " Open Roblox Studio with the Roblox Studio MCP plugin installed, click the MCP toolbar button, " +
            "verify the token matches, and try again. (The plugin connects to this server over " +
            `http://127.0.0.1:${ctx.bridge.port}.)`
          : "";
      return errorResult(err.message + editHint);
    }
    throw err;
  }
  try {
    const result = await session.queue.dispatch(name, payload, timeoutMs);
    return textResult(result ?? { ok: true });
  } catch (err) {
    if (err instanceof StudioCommandError) {
      const stack = err.stack2 ? `\nLuau stack:\n${err.stack2}` : "";
      return errorResult(`Studio error while executing ${name}: ${err.message}${stack}`);
    }
    if (err instanceof CommandTimeoutError) {
      return errorResult(err.message);
    }
    return errorResult(`Failed to execute ${name}: ${String(err)}`);
  }
}

/** Zod schema for DataModel instance paths ("game.Workspace.Foo"). */
export const instancePathSchema = z
  .string()
  .min(4)
  .max(2000)
  .refine(isValidInstancePath, {
    message:
      'Instance paths must start with "game" and use "." or "/" separators, e.g. "game.Workspace.Map.Spawn". ' +
      'Duplicate sibling names can be indexed: "game.Workspace.Part[2]".',
  });

/** Property map: primitives, tagged values ({$type,...}) or "Enum.X.Y" strings. */
export const propertiesSchema = z
  .record(z.string().min(1).max(100), z.unknown())
  .describe(
    "Map of property name to value. Primitives are plain JSON. Typed Roblox values use tagged objects, e.g. " +
      '{"Size": {"$type": "Vector3", "value": [4, 1, 2]}, "Color": {"$type": "Color3", "value": [1, 0, 0]}, ' +
      '"Material": "Enum.Material.Neon", "Position": {"$type": "UDim2", "value": [0.5, 0, 0.5, 0]}}. ' +
      "Supported tags: Vector3, Vector2, CFrame (12 numbers), Color3 (0-1 floats), BrickColor, UDim, UDim2, " +
      "EnumItem, Instance (path), NumberRange, Rect, ColorSequence, NumberSequence, Font.",
  );

export const scriptClassSchema = z
  .enum(["Script", "LocalScript", "ModuleScript"])
  .describe("Roblox script class.");

/** Peer selector for tools that can target a specific live DataModel. */
export const peerSchema = z
  .string()
  .min(1)
  .max(100)
  .default("edit")
  .describe(
    'Which connected Studio peer to target: "edit" (default), "server" (playtest server), "client" ' +
      "(playtest client), or an explicit sessionId from get_connected_peers when several clients are connected.",
  );
