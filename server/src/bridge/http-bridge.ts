import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import {
  BridgeResult,
  ENDPOINTS,
  LONG_POLL_HOLD_MS,
  PLUGIN_TIMEOUT_MS,
  PluginConnectionState,
  PluginHello,
  PROTOCOL_VERSION,
  ServerHello,
} from "@roblox-studio-mcp/shared";
import { isAuthorized } from "./auth.js";
import { CommandQueue } from "./command-queue.js";
import { createLogger } from "../logger.js";

const log = createLogger("bridge");

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const SERVER_VERSION = "1.0.0";

export interface HttpBridgeOptions {
  port: number;
  authToken: string;
  queue: CommandQueue;
  /** Bind host; always 127.0.0.1 outside of tests. */
  host?: string;
}

/**
 * Local HTTP bridge the Roblox Studio plugin talks to.
 * See shared/src/protocol.ts for the endpoint contract.
 */
export class HttpBridge {
  private readonly server: Server;
  private readonly options: Required<HttpBridgeOptions>;
  private lastSeenAt: number | null = null;
  private hello: PluginHello | null = null;
  private boundPort: number | null = null;

  constructor(options: HttpBridgeOptions) {
    this.options = { host: "127.0.0.1", ...options };
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        log.error(`Unhandled bridge error: ${String(err)}`);
        if (!res.headersSent) this.json(res, 500, { error: "internal error" });
      });
    });
    // Long polls must be allowed to sit open.
    this.server.requestTimeout = LONG_POLL_HOLD_MS + 30_000;
    this.server.headersTimeout = LONG_POLL_HOLD_MS + 35_000;
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
    log.info(`HTTP bridge listening on http://${this.options.host}:${this.boundPort}`);
    return this.boundPort;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get port(): number {
    if (this.boundPort === null) throw new Error("Bridge not started");
    return this.boundPort;
  }

  connectionState(): PluginConnectionState {
    const connected = this.lastSeenAt !== null && Date.now() - this.lastSeenAt < PLUGIN_TIMEOUT_MS;
    return { connected, lastSeenAt: this.lastSeenAt, hello: this.hello };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === ENDPOINTS.health) {
      this.json(res, 200, { ok: true, pluginConnected: this.connectionState().connected });
      return;
    }

    if (!url.pathname.startsWith("/plugin/")) {
      this.json(res, 404, { error: "not found" });
      return;
    }

    if (!isAuthorized(req.headers.authorization, this.options.authToken)) {
      log.warn(`Rejected unauthorized request to ${url.pathname}`);
      this.json(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method === "POST" && url.pathname === ENDPOINTS.hello) {
      const body = await this.readJson<PluginHello>(req, res);
      if (body === undefined) return;
      this.hello = body;
      this.lastSeenAt = Date.now();
      const compatible = body.protocolVersion === PROTOCOL_VERSION;
      const reply: ServerHello = {
        serverVersion: SERVER_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        ok: compatible,
        message: compatible
          ? undefined
          : `Protocol mismatch: server speaks v${PROTOCOL_VERSION}, plugin speaks v${body.protocolVersion}. Update the older side.`,
      };
      log.info(
        `Plugin connected: ${body.placeName} (placeId=${body.placeId}, plugin v${body.pluginVersion})`,
      );
      this.json(res, compatible ? 200 : 409, reply);
      return;
    }

    if (req.method === "GET" && url.pathname === ENDPOINTS.poll) {
      this.lastSeenAt = Date.now();
      const command = await this.options.queue.takeNext(LONG_POLL_HOLD_MS);
      this.lastSeenAt = Date.now();
      if (command) {
        this.json(res, 200, command);
      } else {
        res.writeHead(204);
        res.end();
      }
      return;
    }

    if (req.method === "POST" && url.pathname === ENDPOINTS.result) {
      const body = await this.readJson<BridgeResult>(req, res);
      if (body === undefined) return;
      this.lastSeenAt = Date.now();
      if (typeof body.id !== "string" || typeof body.ok !== "boolean") {
        this.json(res, 400, { error: "invalid result envelope" });
        return;
      }
      const known = this.options.queue.complete(body);
      this.json(res, known ? 200 : 410, { ok: known });
      return;
    }

    this.json(res, 404, { error: "not found" });
  }

  private async readJson<T>(req: IncomingMessage, res: ServerResponse): Promise<T | undefined> {
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of req) {
        total += (chunk as Buffer).length;
        if (total > MAX_BODY_BYTES) {
          this.json(res, 413, { error: "body too large" });
          return undefined;
        }
        chunks.push(chunk as Buffer);
      }
    } catch (err) {
      log.warn(`Body read failed: ${String(err)}`);
      this.json(res, 400, { error: "body read failed" });
      return undefined;
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } catch {
      this.json(res, 400, { error: "invalid JSON" });
      return undefined;
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}
