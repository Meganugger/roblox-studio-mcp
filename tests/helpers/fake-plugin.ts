/**
 * Simulated Studio plugin (protocol v2): announces itself with a sessionId +
 * context, long-polls the bridge with its session parameter and posts results,
 * byte-for-byte like the Luau plugin's Bridge module.
 */
import { randomUUID } from "node:crypto";
import { BridgeCommand, ENDPOINTS, PeerContext, PROTOCOL_VERSION } from "@roblox-studio-mcp/shared";

export interface FakePluginOptions {
  baseUrl: string;
  token: string;
  handler: (command: BridgeCommand) => unknown | Promise<unknown>;
  context?: PeerContext;
  sessionId?: string;
  placeName?: string;
  userName?: string;
  userId?: number;
  pluginVersion?: string;
  protocolVersion?: number;
}

export class FakePlugin {
  private stopped = false;
  readonly executed: BridgeCommand[] = [];
  readonly sessionId: string;
  readonly context: PeerContext;

  constructor(private readonly options: FakePluginOptions) {
    this.sessionId = options.sessionId ?? randomUUID();
    this.context = options.context ?? "edit";
  }

  async hello(): Promise<Response> {
    return fetch(`${this.options.baseUrl}${ENDPOINTS.hello}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.options.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        pluginVersion: this.options.pluginVersion ?? "2.0.0",
        protocolVersion: this.options.protocolVersion ?? PROTOCOL_VERSION,
        sessionId: this.sessionId,
        context: this.context,
        placeName: this.options.placeName ?? "TestPlace",
        placeId: 123,
        gameId: 456,
        userName: this.options.userName,
        userId: this.options.userId,
      }),
    });
  }

  start(): void {
    void (async () => {
      while (!this.stopped) {
        try {
          const res = await fetch(
            `${this.options.baseUrl}${ENDPOINTS.poll}?session=${this.sessionId}`,
            { headers: { Authorization: `Bearer ${this.options.token}` } },
          );
          if (this.stopped) return;
          if (res.status !== 200) continue;
          const command = (await res.json()) as BridgeCommand;
          this.executed.push(command);
          let result: unknown;
          let ok = true;
          let error: { message: string } | undefined;
          try {
            result = await this.options.handler(command);
          } catch (err) {
            ok = false;
            error = { message: String(err instanceof Error ? err.message : err) };
          }
          await fetch(`${this.options.baseUrl}${ENDPOINTS.result}?session=${this.sessionId}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${this.options.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ id: command.id, ok, result, error }),
          });
        } catch {
          if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    })();
  }

  stop(): void {
    this.stopped = true;
  }
}
