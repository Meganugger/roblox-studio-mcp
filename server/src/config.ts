import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { DEFAULT_BRIDGE_PORT, DEFAULT_MCP_HTTP_PORT } from "@roblox-studio-mcp/shared";
import { createLogger } from "./logger.js";

const log = createLogger("config");

export type McpTransportKind = "stdio" | "http";

export interface ServerConfig {
  /** Port the local HTTP bridge listens on (127.0.0.1 only). */
  bridgePort: number;
  /** Shared secret between server and Studio plugin. */
  authToken: string;
  /** How the MCP server itself is exposed to AI clients. */
  transport: McpTransportKind;
  /** Port for the Streamable HTTP MCP transport (when transport === "http"). */
  httpPort: number;
  /** Bind host for the HTTP MCP transport. 127.0.0.1 unless explicitly overridden. */
  httpHost: string;
  /** Bearer token required by the HTTP MCP transport. */
  httpToken: string;
  /** Whether the run_luau tool is enabled. */
  allowRunLuau: boolean;
  /** Whether insert_asset (InsertService, remote content) is enabled. */
  allowInsertAsset: boolean;
  /**
   * Whether native host control is enabled: launching/closing Studio, focusing
   * its window, taking screenshots and sending shortcuts.
   */
  allowNative: boolean;
  /**
   * Whether keyboard-shortcut simulation is enabled. Requires allowNative.
   * Turning this off keeps launching and screenshots but blocks all input.
   */
  allowNativeInput: boolean;
  /** Explicit Roblox Studio executable path (auto-detected when unset). */
  studioPath?: string;
  /** Default directory for newly created place files. */
  placesDir: string;
  /** Sandbox root: place tools refuse to touch anything outside it. */
  placesRoot: string;
  /** Where captured screenshots are written. */
  screenshotDir: string;
  /**
   * Whether the Roblox Open Cloud publishing tools are enabled. Off by default:
   * unlike every other tool, these change what live players see.
   */
  allowPublish: boolean;
  /** Open Cloud API key, from the environment or the persisted key file. */
  openCloudKey?: string;
  /** Where the key was found (reported to the agent; the key itself never is). */
  openCloudKeySource?: OpenCloudKeySource;
  /** Path that is checked for a key file, reported even when it is absent. */
  openCloudKeyPath: string;
  /** Default universe for the publish tools. */
  universeId?: number;
  /** Default place for the publish tools. */
  placeId?: number;
  /** When non-empty, the publish tools refuse any other universe. */
  allowedUniverseIds: number[];
  /** Maximum accepted place-file upload size in bytes. */
  maxPlaceUploadBytes: number;
  /** Maximum accepted script source size in bytes. */
  maxScriptSourceBytes: number;
  /** Maximum accepted run_luau code size in bytes. */
  maxLuauCodeBytes: number;
}

function parsePort(raw: string | undefined, fallback: number, envName: string): number {
  if (!raw) return fallback;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${envName}: ${raw}`);
  }
  return port;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

export function configDir(): string {
  return process.env.ROBLOX_MCP_HOME || join(homedir(), ".roblox-studio-mcp");
}

/**
 * Resolve a persisted secret, in priority order:
 *  1. The given environment variable
 *  2. Persisted token file (~/.roblox-studio-mcp/<fileName>)
 *  3. Freshly generated token, persisted for future runs
 */
function resolveSecret(envName: string, fileName: string): string {
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.trim().length >= 16) return fromEnv.trim();
  if (fromEnv) {
    throw new Error(`${envName} must be at least 16 characters long.`);
  }

  const dir = configDir();
  const tokenPath = join(dir, fileName);
  try {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing.length >= 16) return existing;
  } catch {
    // fall through to generation
  }

  const token = randomBytes(24).toString("base64url");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    log.info(`Generated new secret and saved it to ${tokenPath}`);
  } catch (err) {
    log.warn(`Could not persist secret (${String(err)}); using in-memory value for this session.`);
  }
  return token;
}

export function resolveAuthToken(): string {
  return resolveSecret("ROBLOX_MCP_TOKEN", "token");
}

export function resolveHttpToken(): string {
  return resolveSecret("ROBLOX_MCP_HTTP_TOKEN", "http-token");
}

export type OpenCloudKeySource = "env" | "file";

export interface OpenCloudKeyResolution {
  key?: string;
  source?: OpenCloudKeySource;
  /** The file path that was consulted, whether or not it held a key. */
  path: string;
}

/** Shortest plausible Open Cloud key; real ones are far longer. */
const MIN_OPEN_CLOUD_KEY_LENGTH = 20;

/**
 * Resolve the Open Cloud API key from the environment or the persisted key file.
 *
 * Unlike the bridge/HTTP tokens this deliberately never generates a value: an
 * API key is a real Roblox credential that only the user can mint. Absence is a
 * normal state that the publish tools report with instructions.
 */
export function resolveOpenCloudKey(env: NodeJS.ProcessEnv = process.env): OpenCloudKeyResolution {
  const path = join(configDir(), "open-cloud-key");
  const fromEnv = env.ROBLOX_MCP_OPEN_CLOUD_KEY?.trim();
  if (fromEnv) {
    if (fromEnv.length < MIN_OPEN_CLOUD_KEY_LENGTH) {
      throw new Error(
        `ROBLOX_MCP_OPEN_CLOUD_KEY is only ${fromEnv.length} characters long, which cannot be a real Roblox ` +
          "Open Cloud API key. Copy the whole key from https://create.roblox.com/dashboard/credentials.",
      );
    }
    return { key: fromEnv, source: "env", path };
  }
  try {
    const fromFile = readFileSync(path, "utf8").trim();
    if (fromFile.length >= MIN_OPEN_CLOUD_KEY_LENGTH) return { key: fromFile, source: "file", path };
    if (fromFile.length > 0) {
      log.warn(`${path} does not contain a plausible Open Cloud API key (too short); ignoring it.`);
    }
  } catch {
    // No key file: a normal, reported state.
  }
  return { path };
}

function parseId(raw: string | undefined, envName: string): number | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid ${envName}: ${raw} (expected a positive integer id)`);
  }
  return value;
}

function parseIdList(raw: string | undefined, envName: string): number[] {
  if (!raw || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const value = Number.parseInt(entry, 10);
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`Invalid ${envName}: ${raw} (expected comma-separated positive integer ids)`);
      }
      return value;
    });
}

function parseByteSize(raw: string | undefined, fallback: number, envName: string): number {
  if (!raw || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid ${envName}: ${raw} (expected a positive byte count)`);
  }
  return value;
}

function parseTransport(raw: string | undefined): McpTransportKind {
  if (!raw || raw === "stdio") return "stdio";
  if (raw === "http") return "http";
  throw new Error(`Invalid ROBLOX_MCP_TRANSPORT: ${raw} (expected "stdio" or "http")`);
}

export function loadConfig(overrides: Partial<Pick<ServerConfig, "transport">> = {}): ServerConfig {
  const transport = overrides.transport ?? parseTransport(process.env.ROBLOX_MCP_TRANSPORT);
  const placesDir = process.env.ROBLOX_MCP_PLACES_DIR || join(homedir(), "RobloxStudioMCP", "places");
  const placesRoot = process.env.ROBLOX_MCP_PLACES_ROOT || homedir();
  if (resolve(placesDir) !== resolve(placesRoot) && !resolve(placesDir).startsWith(resolve(placesRoot) + sep)) {
    log.warn(
      `ROBLOX_MCP_PLACES_DIR (${placesDir}) is outside ROBLOX_MCP_PLACES_ROOT (${placesRoot}); ` +
        "place tools will reject it. Set ROBLOX_MCP_PLACES_ROOT to a directory that contains it.",
    );
  }
  const openCloud = resolveOpenCloudKey();
  return {
    bridgePort: parsePort(process.env.ROBLOX_MCP_PORT, DEFAULT_BRIDGE_PORT, "ROBLOX_MCP_PORT"),
    authToken: resolveAuthToken(),
    transport,
    httpPort: parsePort(process.env.ROBLOX_MCP_HTTP_PORT, DEFAULT_MCP_HTTP_PORT, "ROBLOX_MCP_HTTP_PORT"),
    httpHost: process.env.ROBLOX_MCP_HTTP_HOST || "127.0.0.1",
    // Only resolve (and possibly generate) the HTTP token when it is needed.
    httpToken: transport === "http" ? resolveHttpToken() : "",
    allowRunLuau: parseBool(process.env.ROBLOX_MCP_ALLOW_RUN_LUAU, true),
    allowInsertAsset: parseBool(process.env.ROBLOX_MCP_ALLOW_INSERT_ASSET, true),
    allowNative: parseBool(process.env.ROBLOX_MCP_ALLOW_NATIVE, true),
    allowNativeInput: parseBool(process.env.ROBLOX_MCP_ALLOW_NATIVE_INPUT, true),
    studioPath: process.env.ROBLOX_MCP_STUDIO_PATH?.trim() || undefined,
    placesDir,
    placesRoot,
    screenshotDir: process.env.ROBLOX_MCP_SCREENSHOT_DIR || join(configDir(), "screenshots"),
    // Publishing is opt-in: it is the only capability whose blast radius reaches
    // real players, so it must never be enabled by merely installing the server.
    allowPublish: parseBool(process.env.ROBLOX_MCP_ALLOW_PUBLISH, false),
    openCloudKey: openCloud.key,
    openCloudKeySource: openCloud.source,
    openCloudKeyPath: openCloud.path,
    universeId: parseId(process.env.ROBLOX_MCP_UNIVERSE_ID, "ROBLOX_MCP_UNIVERSE_ID"),
    placeId: parseId(process.env.ROBLOX_MCP_PLACE_ID, "ROBLOX_MCP_PLACE_ID"),
    allowedUniverseIds: parseIdList(process.env.ROBLOX_MCP_ALLOWED_UNIVERSES, "ROBLOX_MCP_ALLOWED_UNIVERSES"),
    maxPlaceUploadBytes: parseByteSize(
      process.env.ROBLOX_MCP_MAX_PLACE_UPLOAD_BYTES,
      100 * 1024 * 1024,
      "ROBLOX_MCP_MAX_PLACE_UPLOAD_BYTES",
    ),
    maxScriptSourceBytes: 512 * 1024,
    maxLuauCodeBytes: 256 * 1024,
  };
}
