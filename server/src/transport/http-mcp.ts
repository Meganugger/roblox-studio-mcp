import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isAuthorized } from "../bridge/auth.js";
import { ToolContext } from "../mcp/tool-helpers.js";
import { createMcpServer } from "../mcp/server.js";
import { createLogger } from "../logger.js";

const log = createLogger("http-mcp");

export interface HttpMcpOptions {
  port: number;
  host: string;
  token: string;
  ctx: ToolContext;
}

/**
 * Streamable HTTP MCP transport: exposes the full tool suite at POST /mcp so
 * AI platforms that only accept a server URL (instead of spawning a stdio
 * process) can connect.
 *
 * - Every request must carry `Authorization: Bearer <token>` (constant-time check).
 * - Runs in stateless mode: each POST gets a fresh McpServer wired to the
 *   shared ToolContext (session registry / bridge / config are singletons),
 *   so any number of concurrent clients and any reverse proxy or tunnel can
 *   sit in front without session affinity.
 * - Binds to 127.0.0.1 by default. To reach it from a URL-only cloud platform,
 *   keep the bind local and publish it through a reverse tunnel
 *   (Cloudflare Tunnel / ngrok / Tailscale Funnel) - see docs/remote-access.md.
 */
export class HttpMcpTransport {
  private readonly server: Server;
  private boundPort: number | null = null;

  constructor(private readonly options: HttpMcpOptions) {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        log.error(`Unhandled HTTP MCP error: ${String(err)}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        }
      });
    });
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    this.boundPort = typeof address === "object" && address ? address.port : this.options.port;
    log.info(`Streamable HTTP MCP endpoint: http://${this.options.host}:${this.boundPort}/mcp`);
    return this.boundPort;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get port(): number {
    if (this.boundPort === null) throw new Error("HTTP MCP transport not started");
    return this.boundPort;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    // Tolerate trailing slashes: clients and reverse proxies add them freely, and
    // `/mcp/` failing while `/mcp` works is indistinguishable from a wrong URL.
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && path === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (path !== "/mcp") {
      // Logged because a 404 here is almost always a client URL or reverse-proxy
      // path problem, and the client usually only surfaces the status code.
      const legacySse = path === "/sse" || path === "/messages" || path.endsWith("/sse");
      log.warn(
        `404 for ${req.method ?? "?"} ${url.pathname} - the MCP endpoint is /mcp` +
          (legacySse
            ? " (this looks like the legacy HTTP+SSE transport; this server speaks Streamable HTTP)"
            : ""),
      );
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: `not found: ${req.method ?? "?"} ${url.pathname}; the MCP endpoint is POST /mcp`,
          ...(legacySse
            ? { hint: "Legacy HTTP+SSE transport is not supported; configure Streamable HTTP at /mcp." }
            : {}),
        }),
      );
      return;
    }

    if (!isAuthorized(req.headers.authorization, this.options.token)) {
      log.warn("Rejected unauthorized MCP request");
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" },
          id: null,
        }),
      );
      return;
    }

    if (req.method !== "POST") {
      // Stateless mode: no server-initiated streams (GET) or sessions to delete.
      res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed; POST JSON-RPC messages to /mcp" },
          id: null,
        }),
      );
      return;
    }

    // Fresh server + transport per request (stateless Streamable HTTP).
    const mcpServer = createMcpServer(this.options.ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  }
}
