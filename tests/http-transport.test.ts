/**
 * Streamable HTTP transport test: a real MCP client connects to the HTTP MCP
 * endpoint over actual TCP (the same path a URL-only AI platform uses through
 * a tunnel), lists tools and calls one end-to-end through a fake plugin.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HttpBridge } from "../server/src/bridge/http-bridge.js";
import { SessionRegistry } from "../server/src/bridge/sessions.js";
import { HttpMcpTransport } from "../server/src/transport/http-mcp.js";
import { ServerConfig } from "../server/src/config.js";
import { FakePlugin } from "./helpers/fake-plugin.js";
import { makeConfig, makeNativeHost } from "./helpers/test-context.js";

const PLUGIN_TOKEN = "plugin-token-1234567890abc";
const MCP_TOKEN = "mcp-http-token-1234567890abc";

describe("Streamable HTTP MCP transport", () => {
  let sessions: SessionRegistry;
  let bridge: HttpBridge;
  let transport: HttpMcpTransport;
  let mcpUrl: string;
  let plugin: FakePlugin | null = null;

  const config: ServerConfig = makeConfig({
    authToken: PLUGIN_TOKEN,
    transport: "http",
    httpToken: MCP_TOKEN,
  });
  const native = makeNativeHost();

  beforeEach(async () => {
    sessions = new SessionRegistry();
    bridge = new HttpBridge({ port: 0, authToken: PLUGIN_TOKEN, sessions });
    await bridge.start();
    transport = new HttpMcpTransport({
      port: 0,
      host: "127.0.0.1",
      token: MCP_TOKEN,
      ctx: { sessions, bridge, config, native },
    });
    const port = await transport.start();
    mcpUrl = `http://127.0.0.1:${port}/mcp`;
  });

  afterEach(async () => {
    plugin?.stop();
    plugin = null;
    sessions.rejectAll("teardown");
    await transport.stop();
    await bridge.stop();
  });

  function makeClient(token: string): { client: Client; transport: StreamableHTTPClientTransport } {
    const clientTransport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    return { client: new Client({ name: "http-test-client", version: "1.0.0" }), transport: clientTransport };
  }

  it("rejects requests without a valid bearer token", async () => {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });
    expect(res.status).toBe(401);

    const bad = makeClient("wrong-token-000000000000");
    await expect(bad.client.connect(bad.transport)).rejects.toThrow();
  });

  it("serves the full tool suite over HTTP and executes calls end-to-end", async () => {
    const { client, transport: clientTransport } = makeClient(MCP_TOKEN);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("run_luau");
    expect(names).toContain("eval_server_runtime");
    expect(names).toContain("get_roblox_docs");
    expect(names.length).toBeGreaterThanOrEqual(45);

    // Full path: HTTP MCP -> session registry -> bridge -> fake plugin.
    plugin = new FakePlugin({
      baseUrl: `http://127.0.0.1:${bridge.port}`,
      token: PLUGIN_TOKEN,
      handler: (command) => {
        expect(command.name).toBe("Ping");
        return { pong: true };
      },
    });
    await plugin.hello();
    plugin.start();

    const result = await client.callTool({ name: "ping_studio", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((result.content as Array<{ text: string }>)[0].text).toContain("roundTripMs");

    await client.close();
  });

  it("supports multiple concurrent HTTP clients (stateless mode)", async () => {
    const a = makeClient(MCP_TOKEN);
    const b = makeClient(MCP_TOKEN);
    await Promise.all([a.client.connect(a.transport), b.client.connect(b.transport)]);
    const [toolsA, toolsB] = await Promise.all([a.client.listTools(), b.client.listTools()]);
    expect(toolsA.tools.length).toBe(toolsB.tools.length);
    await Promise.all([a.client.close(), b.client.close()]);
  });

  it("accepts the endpoint with a trailing slash", async () => {
    const res = await fetch(`${mcpUrl}/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MCP_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: unknown[] } };
    expect(body.result.tools.length).toBeGreaterThan(0);
  });

  it("reports the requested path on 404 and flags legacy SSE probes", async () => {
    const root = await fetch(mcpUrl.replace("/mcp", "/"));
    expect(root.status).toBe(404);
    expect(((await root.json()) as { error: string }).error).toContain("GET /");

    const sse = await fetch(mcpUrl.replace("/mcp", "/sse"));
    expect(sse.status).toBe(404);
    const body = (await sse.json()) as { error: string; hint?: string };
    expect(body.hint).toContain("Legacy HTTP+SSE");
  });

  it("answers /healthz without auth", async () => {
    const res = await fetch(mcpUrl.replace("/mcp", "/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
