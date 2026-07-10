#!/usr/bin/env node
/**
 * Roblox Studio MCP server entrypoint.
 *
 * Starts two things:
 *  1. The MCP server on stdio (for the AI client: Claude, Cursor, etc.)
 *  2. The local HTTP bridge on 127.0.0.1 (for the Roblox Studio plugin)
 *
 * All human-facing logging goes to stderr; stdout is reserved for MCP JSON-RPC.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { CommandQueue } from "./bridge/command-queue.js";
import { HttpBridge } from "./bridge/http-bridge.js";
import { createMcpServer } from "./mcp/server.js";
import { createLogger } from "./logger.js";

const log = createLogger("main");

async function main(): Promise<void> {
  const config = loadConfig();
  const queue = new CommandQueue();
  const bridge = new HttpBridge({
    port: config.bridgePort,
    authToken: config.authToken,
    queue,
  });

  try {
    await bridge.start();
  } catch (err) {
    log.error(
      `Could not start the HTTP bridge on port ${config.bridgePort}: ${String(err)}. ` +
        `Is another instance running? Set ROBLOX_MCP_PORT to change the port.`,
    );
    process.exit(1);
  }

  const mcpServer = createMcpServer({ queue, bridge, config });
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  log.info("Roblox Studio MCP server ready.");
  log.info(`Bridge: http://127.0.0.1:${bridge.port} | Plugin auth token: ${config.authToken}`);
  log.info("Paste the token into the Roblox Studio MCP plugin widget to connect Studio.");

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`Received ${signal}, shutting down.`);
    queue.rejectAll("Server shutting down");
    await bridge.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error(`Fatal: ${String(err)}`);
  process.exit(1);
});
