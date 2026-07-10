/**
 * Minimal structured logger.
 *
 * IMPORTANT: The MCP transport uses stdout for JSON-RPC, so all logging must
 * go to stderr. Never write to stdout from server code.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevel = (process.env.ROBLOX_MCP_LOG_LEVEL as LogLevel) || "info";
if (!(minLevel in LEVEL_ORDER)) minLevel = "info";

function write(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const time = new Date().toISOString();
  const suffix = extra === undefined ? "" : ` ${safeStringify(extra)}`;
  process.stderr.write(`${time} [${level.toUpperCase()}] [${scope}] ${message}${suffix}\n`);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface Logger {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, extra) => write("debug", scope, message, extra),
    info: (message, extra) => write("info", scope, message, extra),
    warn: (message, extra) => write("warn", scope, message, extra),
    error: (message, extra) => write("error", scope, message, extra),
  };
}
