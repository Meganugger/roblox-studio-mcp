/**
 * End-to-end bridge test: a simulated Studio plugin long-polls the HTTP
 * bridge, executes commands and posts results, exactly like the Luau plugin.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandQueue } from "../server/src/bridge/command-queue.js";
import { HttpBridge } from "../server/src/bridge/http-bridge.js";
import { BridgeCommand, ENDPOINTS, PROTOCOL_VERSION } from "@roblox-studio-mcp/shared";

const TOKEN = "integration-test-token-123456";

class FakePlugin {
  private stopped = false;
  readonly executed: BridgeCommand[] = [];

  constructor(
    private readonly baseUrl: string,
    private readonly handler: (command: BridgeCommand) => unknown | Promise<unknown>,
    private readonly token: string = TOKEN,
  ) {}

  async hello(): Promise<Response> {
    return fetch(`${this.baseUrl}${ENDPOINTS.hello}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        pluginVersion: "1.0.0",
        protocolVersion: PROTOCOL_VERSION,
        placeName: "TestPlace",
        placeId: 123,
        gameId: 456,
      }),
    });
  }

  start(): void {
    void (async () => {
      while (!this.stopped) {
        try {
          const res = await fetch(`${this.baseUrl}${ENDPOINTS.poll}`, {
            headers: { Authorization: `Bearer ${this.token}` },
          });
          if (this.stopped) return;
          if (res.status !== 200) continue;
          const command = (await res.json()) as BridgeCommand;
          this.executed.push(command);
          let result: unknown;
          let ok = true;
          let error: { message: string } | undefined;
          try {
            result = await this.handler(command);
          } catch (err) {
            ok = false;
            error = { message: String(err instanceof Error ? err.message : err) };
          }
          await fetch(`${this.baseUrl}${ENDPOINTS.result}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
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

describe("HttpBridge integration", () => {
  let queue: CommandQueue;
  let bridge: HttpBridge;
  let baseUrl: string;
  let plugin: FakePlugin | null = null;

  beforeEach(async () => {
    queue = new CommandQueue();
    bridge = new HttpBridge({ port: 0, authToken: TOKEN, queue });
    const port = await bridge.start();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    plugin?.stop();
    plugin = null;
    queue.rejectAll("test teardown");
    await bridge.stop();
  });

  it("answers /health without auth and reports plugin connectivity", async () => {
    const before = await (await fetch(`${baseUrl}${ENDPOINTS.health}`)).json();
    expect(before).toEqual({ ok: true, pluginConnected: false });

    plugin = new FakePlugin(baseUrl, () => ({}));
    const helloRes = await plugin.hello();
    expect(helloRes.status).toBe(200);

    const after = await (await fetch(`${baseUrl}${ENDPOINTS.health}`)).json();
    expect(after).toEqual({ ok: true, pluginConnected: true });
    expect(bridge.connectionState().hello?.placeName).toBe("TestPlace");
  });

  it("rejects unauthorized plugin endpoints", async () => {
    const poll = await fetch(`${baseUrl}${ENDPOINTS.poll}`);
    expect(poll.status).toBe(401);

    const badToken = await fetch(`${baseUrl}${ENDPOINTS.poll}`, {
      headers: { Authorization: "Bearer wrong-token-000000000" },
    });
    expect(badToken.status).toBe(401);
  });

  it("rejects protocol version mismatches with 409", async () => {
    const res = await fetch(`${baseUrl}${ENDPOINTS.hello}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        pluginVersion: "0.1.0",
        protocolVersion: PROTOCOL_VERSION + 1,
        placeName: "Old",
        placeId: 1,
        gameId: 1,
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; message?: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain("Protocol mismatch");
  });

  it("round-trips a command through a polling plugin", async () => {
    plugin = new FakePlugin(baseUrl, (command) => {
      if (command.name === "GetSelection") return { paths: ["game.Workspace.Part"] };
      throw new Error("unexpected command");
    });
    await plugin.hello();
    plugin.start();

    const result = await queue.dispatch("GetSelection", {});
    expect(result).toEqual({ paths: ["game.Workspace.Part"] });
  });

  it("propagates Studio-side errors", async () => {
    plugin = new FakePlugin(baseUrl, () => {
      throw new Error("Not found: game.Workspace.Missing");
    });
    await plugin.hello();
    plugin.start();

    await expect(queue.dispatch("DeleteInstance", { path: "game.Workspace.Missing" })).rejects.toThrow(
      "Not found: game.Workspace.Missing",
    );
  });

  it("handles many sequential commands in order", async () => {
    plugin = new FakePlugin(baseUrl, (command) => ({ echo: command.payload }));
    await plugin.hello();
    plugin.start();

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => queue.dispatch("Ping", { index })),
    );
    results.forEach((result, index) => expect(result).toEqual({ echo: { index } }));
    expect(plugin.executed.length).toBe(10);
  });

  it("returns 410 for results of timed-out commands", async () => {
    const promise = queue.dispatch("Ping", {}, 1000);
    const pollRes = await fetch(`${baseUrl}${ENDPOINTS.poll}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const command = (await pollRes.json()) as BridgeCommand;
    await expect(promise).rejects.toThrow(/timed out/);

    const late = await fetch(`${baseUrl}${ENDPOINTS.result}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: command.id, ok: true, result: {} }),
    });
    expect(late.status).toBe(410);
  });
});
