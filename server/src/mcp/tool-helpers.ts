import { z } from "zod";
import { CommandName, isValidInstancePath, PeerContext, PeerInfo } from "@roblox-studio-mcp/shared";
import { CommandTimeoutError, StudioCommandError } from "../bridge/command-queue.js";
import { HttpBridge } from "../bridge/http-bridge.js";
import { SessionRegistry, UnknownPeerError } from "../bridge/sessions.js";
import { ServerConfig } from "../config.js";
import { NativeHost } from "../native/host.js";
import { NativeOperationError, NativeUnavailableError } from "../native/types.js";
import { PlacePathError } from "../native/places.js";

/** Shared context handed to every tool module. */
export interface ToolContext {
  sessions: SessionRegistry;
  bridge: HttpBridge;
  config: ServerConfig;
  /** Native host control (Studio process, window, input, screenshots). */
  native: NativeHost;
}

export type ToolContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContentBlock[];
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

/** Result carrying a PNG image plus its JSON metadata. */
export function imageResult(base64: string, metadata: unknown): ToolResult {
  return {
    content: [
      { type: "image", data: base64, mimeType: "image/png" },
      { type: "text", text: JSON.stringify(metadata, null, 2) },
    ],
  };
}

/** First text block of a tool result (image blocks are skipped). */
export function textOf(result: ToolResult): string {
  for (const block of result.content) {
    if (block.type === "text") return block.text;
  }
  return "";
}

/**
 * Turn native-layer failures into readable tool errors. Unavailability always
 * carries the exact fix (install a tool, flip an env var, grant a permission),
 * so the agent can tell the user what to do instead of retrying blindly.
 */
export function nativeErrorResult(operation: string, err: unknown): ToolResult {
  if (err instanceof NativeUnavailableError) {
    return errorResult(`${operation} is unavailable on this host: ${err.message}`);
  }
  if (err instanceof NativeOperationError) {
    return errorResult(`${operation} failed: ${err.message}`);
  }
  if (err instanceof PlacePathError) {
    return errorResult(err.message);
  }
  return errorResult(`${operation} failed: ${String(err instanceof Error ? err.message : err)}`);
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

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Session ids of every currently known peer with the given context. */
export function sessionIdsOf(ctx: ToolContext, context: PeerContext): Set<string> {
  return new Set(
    ctx.sessions
      .list()
      .filter((peer) => peer.context === context)
      .map((peer) => peer.sessionId),
  );
}

/**
 * Wait until a peer of the given context connects that was not already known.
 * Returns null on timeout so callers can report a precise, actionable message.
 */
export async function waitForNewPeer(
  ctx: ToolContext,
  context: PeerContext,
  knownSessionIds: Set<string>,
  timeoutMs: number,
  pollIntervalMs = 500,
): Promise<PeerInfo | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = ctx.sessions
      .list()
      .find((peer) => peer.connected && peer.context === context && !knownSessionIds.has(peer.sessionId));
    if (match) return match;
    if (Date.now() >= deadline) return null;
    await sleep(pollIntervalMs);
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
