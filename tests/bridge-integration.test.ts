/**
 * End-to-end bridge test: simulated Studio plugins (protocol v2, per-session)
 * long-poll the HTTP bridge, execute commands and post results, exactly like
 * the Luau plugin. Covers single-peer flows and multi-peer routing (edit +
 * playtest server + playtest clients).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpBridge } from "../server/src/bridge/http-bridge.js";
import { SessionRegistry } from "../server/src/bridge/sessions.js";
import { BridgeCommand, ENDPOINTS, PROTOCOL_VERSION } from "@roblox-studio-mcp/shared";
import { FakePlugin } from "./helpers/fake-plugin.js";

const TOKEN = "integration-test-token-123456";

describe("HttpBridge integration", () => {
  let sessions: SessionRegistry;
  let bridge: HttpBridge;
  let baseUrl: string;
  const plugins: FakePlugin[] = [];

  function makePlugin(options: Partial<ConstructorParameters<typeof FakePlugin>[0]> = {}): FakePlugin {
    const plugin = new FakePlugin({
      baseUrl,
      token: TOKEN,
      handler: () => ({}),
      ...options,
    });
    plugins.push(plugin);
    return plugin;
  }

  beforeEach(async () => {
    sessions = new SessionRegistry();
    bridge = new HttpBridge({ port: 0, authToken: TOKEN, sessions });
    const port = await bridge.start();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    for (const plugin of plugins) plugin.stop();
    plugins.length = 0;
    sessions.rejectAll("test teardown");
    await bridge.stop();
  });

  it("answers /health without auth and reports plugin connectivity", async () => {
    const before = await (await fetch(`${baseUrl}${ENDPOINTS.health}`)).json();
    expect(before).toEqual({ ok: true, pluginConnected: false, peers: 0 });

    const plugin = makePlugin();
    const helloRes = await plugin.hello();
    expect(helloRes.status).toBe(200);

    const after = await (await fetch(`${baseUrl}${ENDPOINTS.health}`)).json();
    expect(after).toEqual({ ok: true, pluginConnected: true, peers: 1 });
    expect(bridge.connectionState().hello?.placeName).toBe("TestPlace");
  });

  it("rejects unauthorized plugin endpoints", async () => {
    const poll = await fetch(`${baseUrl}${ENDPOINTS.poll}?session=abc12345`);
    expect(poll.status).toBe(401);

    const badToken = await fetch(`${baseUrl}${ENDPOINTS.poll}?session=abc12345`, {
      headers: { Authorization: "Bearer wrong-token-000000000" },
    });
    expect(badToken.status).toBe(401);
  });

  it("rejects protocol version mismatches with 409", async () => {
    const plugin = makePlugin({ protocolVersion: PROTOCOL_VERSION + 1 });
    const res = await plugin.hello();
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; message?: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain("Protocol mismatch");
  });

  it("rejects hellos without a session identity", async () => {
    const res = await fetch(`${baseUrl}${ENDPOINTS.hello}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        pluginVersion: "2.0.0",
        protocolVersion: PROTOCOL_VERSION,
        placeName: "NoSession",
        placeId: 1,
        gameId: 1,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("tells unknown sessions to re-handshake with 409", async () => {
    const res = await fetch(`${baseUrl}${ENDPOINTS.poll}?session=never-said-hello`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(409);
  });

  it("round-trips a command through a polling plugin", async () => {
    const plugin = makePlugin({
      handler: (command) => {
        if (command.name === "GetSelection") return { paths: ["game.Workspace.Part"] };
        throw new Error("unexpected command");
      },
    });
    await plugin.hello();
    plugin.start();

    const result = await sessions.resolve("edit").queue.dispatch("GetSelection", {});
    expect(result).toEqual({ paths: ["game.Workspace.Part"] });
  });

  it("propagates Studio-side errors", async () => {
    const plugin = makePlugin({
      handler: () => {
        throw new Error("Not found: game.Workspace.Missing");
      },
    });
    await plugin.hello();
    plugin.start();

    await expect(
      sessions.resolve("edit").queue.dispatch("DeleteInstance", { path: "game.Workspace.Missing" }),
    ).rejects.toThrow("Not found: game.Workspace.Missing");
  });

  it("handles many sequential commands in order", async () => {
    const plugin = makePlugin({ handler: (command) => ({ echo: command.payload }) });
    await plugin.hello();
    plugin.start();

    const queue = sessions.resolve("edit").queue;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => queue.dispatch("Ping", { index })),
    );
    results.forEach((result, index) => expect(result).toEqual({ echo: { index } }));
    expect(plugin.executed.length).toBe(10);
  });

  it("returns 410 for results of timed-out commands", async () => {
    const plugin = makePlugin();
    await plugin.hello();

    const promise = sessions.resolve("edit").queue.dispatch("Ping", {}, 1000);
    const pollRes = await fetch(`${baseUrl}${ENDPOINTS.poll}?session=${plugin.sessionId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const command = (await pollRes.json()) as BridgeCommand;
    await expect(promise).rejects.toThrow(/timed out/);

    const late = await fetch(`${baseUrl}${ENDPOINTS.result}?session=${plugin.sessionId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: command.id, ok: true, result: {} }),
    });
    expect(late.status).toBe(410);
  });

  it("routes commands independently to edit, server and client peers", async () => {
    const edit = makePlugin({ context: "edit", handler: () => ({ from: "edit" }) });
    const server = makePlugin({ context: "server", handler: () => ({ from: "server" }) });
    const client = makePlugin({
      context: "client",
      userName: "Player1",
      userId: 42,
      handler: () => ({ from: "client" }),
    });

    await Promise.all([edit.hello(), server.hello(), client.hello()]);
    edit.start();
    server.start();
    client.start();

    const [editResult, serverResult, clientResult] = await Promise.all([
      sessions.resolve("edit").queue.dispatch("Ping", {}),
      sessions.resolve("server").queue.dispatch("RunLuau", { code: "return 1" }),
      sessions.resolve("client").queue.dispatch("GetLogs", {}),
    ]);
    expect(editResult).toEqual({ from: "edit" });
    expect(serverResult).toEqual({ from: "server" });
    expect(clientResult).toEqual({ from: "client" });

    // Each peer only saw its own command.
    expect(edit.executed.map((c) => c.name)).toEqual(["Ping"]);
    expect(server.executed.map((c) => c.name)).toEqual(["RunLuau"]);
    expect(client.executed.map((c) => c.name)).toEqual(["GetLogs"]);

    // Peer listing carries client identity.
    const peers = sessions.list();
    expect(peers.map((p) => p.context).sort()).toEqual(["client", "edit", "server"]);
    expect(peers.find((p) => p.context === "client")?.userName).toBe("Player1");
  });

  it("resolves explicit sessionIds and reports ambiguity between multiple clients", async () => {
    const clientA = makePlugin({ context: "client", userName: "PlayerA", handler: () => ({ who: "A" }) });
    const clientB = makePlugin({ context: "client", userName: "PlayerB", handler: () => ({ who: "B" }) });
    await Promise.all([clientA.hello(), clientB.hello()]);
    clientA.start();
    clientB.start();

    expect(() => sessions.resolve("client")).toThrow(/Multiple client peers/);

    const result = await sessions.resolve(clientB.sessionId).queue.dispatch("Ping", {});
    expect(result).toEqual({ who: "B" });
    expect(clientA.executed.length).toBe(0);
  });
});
