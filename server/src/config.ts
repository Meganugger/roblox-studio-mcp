import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

function parseTransport(raw: string | undefined): McpTransportKind {
  if (!raw || raw === "stdio") return "stdio";
  if (raw === "http") return "http";
  throw new Error(`Invalid ROBLOX_MCP_TRANSPORT: ${raw} (expected "stdio" or "http")`);
}

export function loadConfig(overrides: Partial<Pick<ServerConfig, "transport">> = {}): ServerConfig {
  const transport = overrides.transport ?? parseTransport(process.env.ROBLOX_MCP_TRANSPORT);
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
    maxScriptSourceBytes: 512 * 1024,
    maxLuauCodeBytes: 256 * 1024,
  };
}
