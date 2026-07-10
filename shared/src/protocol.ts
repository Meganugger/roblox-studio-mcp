/**
 * Wire protocol between the MCP server's HTTP bridge and the Roblox Studio plugin.
 *
 * Transport model
 * ---------------
 * Roblox Studio plugins can only make *outbound* HTTP requests, so the plugin
 * long-polls the local bridge for commands and posts results back:
 *
 *   Plugin -> GET  /plugin/poll    (held up to LONG_POLL_HOLD_MS, returns a command or 204)
 *   Plugin -> POST /plugin/result  (result envelope for a previously delivered command)
 *   Plugin -> POST /plugin/hello   (handshake / reconnect announcement)
 *   Any    -> GET  /health         (unauthenticated liveness probe, no data exposure)
 *
 * All /plugin/* endpoints require `Authorization: Bearer <token>`.
 * The bridge binds to 127.0.0.1 only.
 */

/** Version of this wire protocol. Bumped on breaking changes. */
export const PROTOCOL_VERSION = 1;

/** Default TCP port for the local HTTP bridge. */
export const DEFAULT_BRIDGE_PORT = 3667;

/** How long the bridge holds an open /plugin/poll request before replying 204. */
export const LONG_POLL_HOLD_MS = 15_000;

/** Plugin is considered disconnected when no poll arrives within this window. */
export const PLUGIN_TIMEOUT_MS = 45_000;

/** Default per-command timeout (server side). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/** Upper bound for user-configurable command timeouts (e.g. run_luau). */
export const MAX_COMMAND_TIMEOUT_MS = 180_000;

export const ENDPOINTS = {
  health: "/health",
  hello: "/plugin/hello",
  poll: "/plugin/poll",
  result: "/plugin/result",
} as const;

/** A single command dispatched from the MCP server to the Studio plugin. */
export interface BridgeCommand {
  /** Unique command id (UUID v4). */
  id: string;
  /** Command name, e.g. "CreateInstance". Must be a known CommandName. */
  name: string;
  /** JSON-serializable payload; shape depends on the command. */
  payload: Record<string, unknown>;
  /** Milliseconds the plugin should allow the command to run before aborting. */
  timeoutMs: number;
}

/** Result envelope posted back by the plugin for a delivered command. */
export interface BridgeResult {
  /** Id of the command this result answers. */
  id: string;
  /** True when the command executed successfully. */
  ok: boolean;
  /** JSON-serializable result data (present when ok). */
  result?: unknown;
  /** Error details (present when not ok). */
  error?: BridgeError;
}

export interface BridgeError {
  message: string;
  /** Optional Luau stack trace. */
  stack?: string;
  /** Machine-readable error code. */
  code?: string;
}

/** Handshake body sent by the plugin on connect/reconnect. */
export interface PluginHello {
  pluginVersion: string;
  protocolVersion: number;
  placeName: string;
  placeId: number;
  gameId: number;
  studioLocale?: string;
}

/** Handshake response from the bridge. */
export interface ServerHello {
  serverVersion: string;
  protocolVersion: number;
  ok: boolean;
  message?: string;
}

/** Connection status the bridge tracks about the plugin. */
export interface PluginConnectionState {
  connected: boolean;
  lastSeenAt: number | null;
  hello: PluginHello | null;
}
