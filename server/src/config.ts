import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DEFAULT_BRIDGE_PORT } from "@roblox-studio-mcp/shared";
import { createLogger } from "./logger.js";

const log = createLogger("config");

export interface ServerConfig {
  /** Port the local HTTP bridge listens on (127.0.0.1 only). */
  bridgePort: number;
  /** Shared secret between server and Studio plugin. */
  authToken: string;
  /** Whether the run_luau tool is enabled. */
  allowRunLuau: boolean;
  /** Whether insert_asset (InsertService, remote content) is enabled. */
  allowInsertAsset: boolean;
  /** Maximum accepted script source size in bytes. */
  maxScriptSourceBytes: number;
  /** Maximum accepted run_luau code size in bytes. */
  maxLuauCodeBytes: number;
}

function parsePort(raw: string | undefined): number {
  if (!raw) return DEFAULT_BRIDGE_PORT;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ROBLOX_MCP_PORT: ${raw}`);
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
 * Resolve the auth token, in priority order:
 *  1. ROBLOX_MCP_TOKEN environment variable
 *  2. Persisted token file (~/.roblox-studio-mcp/token)
 *  3. Freshly generated token, persisted for future runs
 */
export function resolveAuthToken(): string {
  const fromEnv = process.env.ROBLOX_MCP_TOKEN;
  if (fromEnv && fromEnv.trim().length >= 16) return fromEnv.trim();
  if (fromEnv) {
    throw new Error("ROBLOX_MCP_TOKEN must be at least 16 characters long.");
  }

  const dir = configDir();
  const tokenPath = join(dir, "token");
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
    log.info(`Generated new auth token and saved it to ${tokenPath}`);
  } catch (err) {
    log.warn(`Could not persist auth token (${String(err)}); using in-memory token for this session.`);
  }
  return token;
}

export function loadConfig(): ServerConfig {
  return {
    bridgePort: parsePort(process.env.ROBLOX_MCP_PORT),
    authToken: resolveAuthToken(),
    allowRunLuau: parseBool(process.env.ROBLOX_MCP_ALLOW_RUN_LUAU, true),
    allowInsertAsset: parseBool(process.env.ROBLOX_MCP_ALLOW_INSERT_ASSET, true),
    maxScriptSourceBytes: 512 * 1024,
    maxLuauCodeBytes: 256 * 1024,
  };
}
