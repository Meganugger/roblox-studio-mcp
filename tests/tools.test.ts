/**
 * Full-stack MCP test: connects a real MCP client to the server over an
 * in-memory transport, with a fake plugin behind the HTTP bridge, and
 * exercises tool listing plus a representative tool call.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CommandQueue } from "../server/src/bridge/command-queue.js";
import { HttpBridge } from "../server/src/bridge/http-bridge.js";
import { createMcpServer } from "../server/src/mcp/server.js";
import { ServerConfig } from "../server/src/config.js";
import { BridgeCommand, ENDPOINTS, PROTOCOL_VERSION } from "@roblox-studio-mcp/shared";

const TOKEN = "tools-test-token-1234567890";

const EXPECTED_TOOLS = [
  "get_studio_status",
  "ping_studio",
  "get_instance_tree",
  "get_instance",
  "get_instance_children",
  "search_instances",
  "create_instance",
  "create_instances_batch",
  "set_instance_properties",
  "rename_instance",
  "move_instance",
  "clone_instance",
  "delete_instance",
  "get_selection",
  "set_selection",
  "create_script",
  "get_script_source",
  "set_script_source",
  "patch_script_source",
  "search_script_source",
  "list_scripts",
  "analyze_scripts",
  "run_luau",
  "get_project_info",
  "save_project",
  "export_project_snapshot",
  "start_playtest",
  "stop_playtest",
  "get_playtest_state",
  "get_output_logs",
  "get_errors",
  "clear_output_logs",
  "generate_terrain",
  "clear_terrain",
  "set_lighting",
  "insert_asset",
  "set_camera",
  "list_scaffolds",
  "install_scaffold",
];

describe("MCP tools", () => {
  let queue: CommandQueue;
  let bridge: HttpBridge;
  let client: Client;
  let pluginRunning = false;
  let baseUrl = "";

  const config: ServerConfig = {
    bridgePort: 0,
    authToken: TOKEN,
    allowRunLuau: true,
    allowInsertAsset: true,
    maxScriptSourceBytes: 512 * 1024,
    maxLuauCodeBytes: 256 * 1024,
  };

  async function startFakePlugin(handler: (command: BridgeCommand) => unknown): Promise<void> {
    await fetch(`${baseUrl}${ENDPOINTS.hello}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        pluginVersion: "1.0.0",
        protocolVersion: PROTOCOL_VERSION,
        placeName: "ToolTest",
        placeId: 1,
        gameId: 1,
      }),
    });
    pluginRunning = true;
    void (async () => {
      while (pluginRunning) {
        try {
          const res = await fetch(`${baseUrl}${ENDPOINTS.poll}`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
          });
          if (!pluginRunning || res.status !== 200) continue;
          const command = (await res.json()) as BridgeCommand;
          const result = handler(command);
          await fetch(`${baseUrl}${ENDPOINTS.result}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ id: command.id, ok: true, result }),
          });
        } catch {
          if (pluginRunning) await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    })();
  }

  beforeEach(async () => {
    queue = new CommandQueue();
    bridge = new HttpBridge({ port: 0, authToken: TOKEN, queue });
    const port = await bridge.start();
    baseUrl = `http://127.0.0.1:${port}`;

    const server = createMcpServer({ queue, bridge, config });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    pluginRunning = false;
    queue.rejectAll("teardown");
    await client.close();
    await bridge.stop();
  });

  it("exposes the complete tool suite", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.description && tool.description.length, `${tool.name} has no description`).toBeGreaterThan(20);
    }
  });

  it("returns a clear error when Studio is not connected", async () => {
    const result = await client.callTool({ name: "get_selection", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("plugin is not connected");
  });

  it("routes tool calls to the plugin and returns Studio results", async () => {
    await startFakePlugin((command) => {
      expect(command.name).toBe("CreateInstance");
      expect(command.payload).toMatchObject({
        className: "Part",
        parentPath: "game.Workspace",
        name: "TestPart",
      });
      return { name: "TestPart", className: "Part", path: "game.Workspace.TestPart" };
    });

    const result = await client.callTool({ name: "create_instance", arguments: {
      className: "Part",
      parentPath: "game.Workspace",
      name: "TestPart",
      properties: { Size: { $type: "Vector3", value: [4, 1, 2] }, Anchored: true },
    } });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text)).toEqual({ name: "TestPart", className: "Part", path: "game.Workspace.TestPart" });
  });

  it("validates instance paths before dispatching", async () => {
    await startFakePlugin(() => ({}));
    const result = await client.callTool({ name: "delete_instance", arguments: { path: "Workspace.Part" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("game");
  });

  it("blocks run_luau when disabled by config", async () => {
    config.allowRunLuau = false;
    try {
      await startFakePlugin(() => ({}));
      const result = await client.callTool({ name: "run_luau", arguments: { code: "print('hi')" } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("disabled");
    } finally {
      config.allowRunLuau = true;
    }
  });

  it("lists scaffolds without needing a Studio connection", async () => {
    const result = await client.callTool({ name: "list_scaffolds", arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0].text;
    const scaffolds = JSON.parse(text) as Array<{ id: string }>;
    expect(scaffolds.map((scaffold) => scaffold.id)).toContain("currency");
  });

  it("installs scaffolds through a single batch command", async () => {
    let batchPayload: Record<string, unknown> | null = null;
    await startFakePlugin((command) => {
      expect(command.name).toBe("CreateInstancesBatch");
      batchPayload = command.payload;
      const items = command.payload.items as Array<{ name: string }>;
      return { created: items.map((item) => ({ name: item.name })), count: items.length };
    });

    const result = await client.callTool({ name: "install_scaffold", arguments: { ids: ["currency"] } });
    expect(result.isError).toBeFalsy();
    expect(batchPayload).not.toBeNull();
    const items = (batchPayload as unknown as { items: Array<{ name: string; properties?: { Source?: string } }> }).items;
    const names = items.map((item) => item.name);
    expect(names).toEqual(expect.arrayContaining(["Server", "Services", "Bootstrap", "Net", "DataService", "CurrencyService"]));
    const currencyItem = items.find((item) => item.name === "CurrencyService");
    expect(currencyItem?.properties?.Source).toContain("CurrencyService:Spend");
  });
});
