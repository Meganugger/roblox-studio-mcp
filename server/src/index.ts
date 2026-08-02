#!/usr/bin/env node
/**
 * Roblox Studio MCP server entrypoint.
 *
 * Always starts the local HTTP bridge on 127.0.0.1 (for the Roblox Studio
 * plugin), plus one MCP transport for the AI client:
 *  - stdio (default): for Claude Code, Claude Desktop, Cursor, Codex, etc.
 *  - Streamable HTTP (--transport http): for platforms that connect to a URL.
 *
 * All human-facing logging goes to stderr; stdout is reserved for MCP JSON-RPC
 * in stdio mode.
 *
 * CLI:
 *   --transport stdio|http   Select the MCP transport (default stdio).
 *   --install-plugin         Copy the built Studio plugin into the local
 *                            Roblox plugins folder, then exit.
 *   --print-token            Print the plugin auth token, then exit.
 *   --help                   Show usage.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, McpTransportKind, resolveAuthToken } from "./config.js";
import { HttpBridge } from "./bridge/http-bridge.js";
import { SessionRegistry } from "./bridge/sessions.js";
import { createMcpServer } from "./mcp/server.js";
import { HttpMcpTransport } from "./transport/http-mcp.js";
import { installPlugin, studioPluginsDir } from "./install-plugin.js";
import { NativeHost } from "./native/host.js";
import { OpenCloudClient } from "./cloud/open-cloud.js";
import { createLogger } from "./logger.js";
import { SERVER_VERSION } from "./version.js";

const log = createLogger("main");

const USAGE = `roblox-studio-mcp v${SERVER_VERSION}

Usage: roblox-studio-mcp [options]

Options:
  --transport stdio|http  MCP transport for the AI client (default: stdio).
                          "http" serves Streamable HTTP MCP at /mcp for
                          URL-only platforms (see docs/remote-access.md).
  --install-plugin        Install the Studio plugin into ${(() => {
    try {
      return studioPluginsDir();
    } catch {
      return "the Roblox plugins folder (set MCP_PLUGINS_DIR on this OS)";
    }
  })()} and exit.
  --print-token           Print the plugin auth token and exit.
  --help                  Show this help.

Environment:
  ROBLOX_MCP_PORT               Bridge port for the Studio plugin (default 3667).
  ROBLOX_MCP_TOKEN              Plugin auth token (auto-generated otherwise).
  ROBLOX_MCP_TRANSPORT          stdio | http (same as --transport).
  ROBLOX_MCP_HTTP_PORT          HTTP MCP port (default 3668).
  ROBLOX_MCP_HTTP_HOST          HTTP MCP bind host (default 127.0.0.1).
  ROBLOX_MCP_HTTP_TOKEN         Bearer token for the HTTP MCP endpoint.
  ROBLOX_MCP_ALLOW_RUN_LUAU     Set 0 to disable arbitrary code execution tools.
  ROBLOX_MCP_ALLOW_INSERT_ASSET Set 0 to disable insert_asset.
  ROBLOX_MCP_ALLOW_NATIVE       Set 0 to disable all native host control
                                (launching Studio, window focus, screenshots, shortcuts).
  ROBLOX_MCP_ALLOW_NATIVE_INPUT Set 0 to disable keyboard-shortcut simulation only.
  ROBLOX_MCP_STUDIO_PATH        Explicit Roblox Studio executable path.
  ROBLOX_MCP_PLACES_DIR         Where new place files are created.
  ROBLOX_MCP_PLACES_ROOT        Sandbox root for place tools (default: home directory).
  ROBLOX_MCP_SCREENSHOT_DIR     Where screenshots are written.
  MCP_PLUGINS_DIR               Override the Studio plugins folder for --install-plugin.

Publishing to Roblox (Open Cloud) - disabled by default:
  ROBLOX_MCP_ALLOW_PUBLISH      Set 1 to enable the publish tools. These reach live
                                players, so they are off unless you opt in.
  ROBLOX_MCP_OPEN_CLOUD_KEY     Open Cloud API key. Alternatively write it to
                                ~/.roblox-studio-mcp/open-cloud-key (chmod 600).
                                Never generated, never printed back.
  ROBLOX_MCP_UNIVERSE_ID        Default universe (experience) id for publish tools.
  ROBLOX_MCP_PLACE_ID           Default place id for publish tools.
  ROBLOX_MCP_ALLOWED_UNIVERSES  Comma-separated universe allowlist; other universes
                                are refused even if the API key can reach them.
  ROBLOX_MCP_MAX_PLACE_UPLOAD_BYTES
                                Upload size limit for publish_place (default 100 MiB).
`;

interface CliOptions {
  transport?: McpTransportKind;
  installPlugin: boolean;
  printToken: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { installPlugin: false, printToken: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--transport": {
        const value = argv[++i];
        if (value !== "stdio" && value !== "http") {
          throw new Error(`--transport must be "stdio" or "http", got: ${value ?? "(missing)"}`);
        }
        options.transport = value;
        break;
      }
      case "--install-plugin":
        options.installPlugin = true;
        break;
      case "--print-token":
        options.printToken = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg} (see --help)`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  let cli: CliOptions;
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${String(err instanceof Error ? err.message : err)}\n\n${USAGE}`);
    process.exit(2);
  }

  if (cli.help) {
    process.stderr.write(USAGE);
    process.exit(0);
  }

  if (cli.installPlugin) {
    try {
      const destination = installPlugin();
      process.stderr.write(
        `Installed Studio plugin to ${destination}\n` +
          "Fully close and reopen Roblox Studio, then open the MCP panel from the Plugins toolbar.\n",
      );
      process.exit(0);
    } catch (err) {
      process.stderr.write(`Plugin install failed: ${String(err instanceof Error ? err.message : err)}\n`);
      process.exit(1);
    }
  }

  if (cli.printToken) {
    process.stdout.write(`${resolveAuthToken()}\n`);
    process.exit(0);
  }

  const config = loadConfig({ transport: cli.transport });
  const sessions = new SessionRegistry();
  const bridge = new HttpBridge({
    port: config.bridgePort,
    authToken: config.authToken,
    sessions,
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

  const native = new NativeHost({
    config: {
      allowNative: config.allowNative,
      allowNativeInput: config.allowNativeInput,
      studioPath: config.studioPath,
      screenshotDir: config.screenshotDir,
    },
  });
  const cloud = new OpenCloudClient({
    config: {
      allowPublish: config.allowPublish,
      apiKey: config.openCloudKey,
      apiKeySource: config.openCloudKeySource,
      apiKeyPath: config.openCloudKeyPath,
      defaultUniverseId: config.universeId,
      defaultPlaceId: config.placeId,
      allowedUniverseIds: config.allowedUniverseIds,
      maxUploadBytes: config.maxPlaceUploadBytes,
    },
  });
  const ctx = { sessions, bridge, config, native, cloud };
  let httpTransport: HttpMcpTransport | null = null;

  if (config.transport === "http") {
    httpTransport = new HttpMcpTransport({
      port: config.httpPort,
      host: config.httpHost,
      token: config.httpToken,
      ctx,
    });
    try {
      await httpTransport.start();
    } catch (err) {
      log.error(`Could not start the HTTP MCP transport on port ${config.httpPort}: ${String(err)}.`);
      process.exit(1);
    }
    log.info(`MCP endpoint (Streamable HTTP): http://${config.httpHost}:${httpTransport.port}/mcp`);
    log.info(`MCP bearer token: ${config.httpToken}`);
    if (config.httpHost === "127.0.0.1") {
      log.info(
        "To connect a URL-only AI platform, publish this endpoint with a reverse tunnel " +
          "(e.g. `cloudflared tunnel --url http://127.0.0.1:" +
          httpTransport.port +
          "`). See docs/remote-access.md.",
      );
    } else {
      log.warn(
        `HTTP MCP transport is bound to ${config.httpHost} - make sure this machine is not directly ` +
          "exposed to the Internet without TLS in front. A localhost bind + reverse tunnel is safer.",
      );
    }
  } else {
    const mcpServer = createMcpServer(ctx);
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
  }

  log.info(`Roblox Studio MCP server v${SERVER_VERSION} ready (transport: ${config.transport}).`);
  log.info(`Bridge: http://127.0.0.1:${bridge.port} | Plugin auth token: ${config.authToken}`);
  log.info("Paste the token into the Roblox Studio MCP plugin widget to connect Studio.");
  log.info(
    `Native host control: ${config.allowNative ? "enabled" : "disabled"} ` +
      `(input simulation: ${config.allowNative && config.allowNativeInput ? "enabled" : "disabled"}, ` +
      `platform: ${process.platform}). Places dir: ${config.placesDir}`,
  );
  log.info(
    `Roblox publishing: ${config.allowPublish ? "enabled" : "disabled (ROBLOX_MCP_ALLOW_PUBLISH=1 to enable)"} ` +
      `(Open Cloud API key: ${config.openCloudKey ? `loaded from ${config.openCloudKeySource}` : "not configured"}).`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`Received ${signal}, shutting down.`);
    sessions.rejectAll("Server shutting down");
    await bridge.stop().catch(() => undefined);
    await httpTransport?.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error(`Fatal: ${String(err)}`);
  process.exit(1);
});
