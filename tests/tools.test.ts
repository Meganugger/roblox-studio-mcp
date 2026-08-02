/**
 * Full-stack MCP test: connects a real MCP client to the server over an
 * in-memory transport, with fake plugins behind the HTTP bridge, and
 * exercises tool listing, routing (including per-peer routing) and errors.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HttpBridge } from "../server/src/bridge/http-bridge.js";
import { SessionRegistry } from "../server/src/bridge/sessions.js";
import { createMcpServer } from "../server/src/mcp/server.js";
import { ServerConfig } from "../server/src/config.js";
import { makeConfig, makeNativeHost } from "./helpers/test-context.js";
import { BridgeCommand } from "@roblox-studio-mcp/shared";
import { FakePlugin, FakePluginOptions } from "./helpers/fake-plugin.js";

const TOKEN = "tools-test-token-1234567890";

const EXPECTED_TOOLS = [
  "get_studio_status",
  "get_connected_peers",
  "ping_studio",
  "get_instance_tree",
  "get_instance",
  "get_instance_children",
  "search_instances",
  "create_instance",
  "create_instances_batch",
  "set_instance_properties",
  "mass_set_properties",
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
  "find_and_replace_in_scripts",
  "list_scripts",
  "analyze_scripts",
  "run_luau",
  "eval_server_runtime",
  "eval_client_runtime",
  "get_project_info",
  "save_project",
  "export_project_snapshot",
  "start_playtest",
  "stop_playtest",
  "get_playtest_state",
  "get_output_logs",
  "get_errors",
  "clear_output_logs",
  "set_log_breakpoint",
  "list_log_breakpoints",
  "clear_log_breakpoints",
  "generate_terrain",
  "clear_terrain",
  "set_lighting",
  "insert_asset",
  "set_camera",
  "list_scaffolds",
  "install_scaffold",
  "get_roblox_docs",
  "get_host_capabilities",
  "get_studio_processes",
  "launch_studio",
  "close_studio",
  "focus_studio_window",
  "send_studio_shortcut",
  "capture_studio_screenshot",
  "start_play_solo",
  "stop_play_solo",
  "list_place_templates",
  "create_place_file",
  "open_place_file",
  "list_place_files",
];

describe("MCP tools", () => {
  let sessions: SessionRegistry;
  let bridge: HttpBridge;
  let client: Client;
  let baseUrl = "";
  const plugins: FakePlugin[] = [];

  const config: ServerConfig = makeConfig({ authToken: TOKEN });
  const native = makeNativeHost();

  async function startFakePlugin(
    handler: (command: BridgeCommand) => unknown,
    options: Partial<FakePluginOptions> = {},
  ): Promise<FakePlugin> {
    const plugin = new FakePlugin({ baseUrl, token: TOKEN, handler, ...options });
    plugins.push(plugin);
    await plugin.hello();
    plugin.start();
    return plugin;
  }

  beforeEach(async () => {
    sessions = new SessionRegistry();
    bridge = new HttpBridge({ port: 0, authToken: TOKEN, sessions });
    const port = await bridge.start();
    baseUrl = `http://127.0.0.1:${port}`;

    const server = createMcpServer({ sessions, bridge, config, native });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    for (const plugin of plugins) plugin.stop();
    plugins.length = 0;
    sessions.rejectAll("teardown");
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
    expect(JSON.stringify(result.content)).toContain("No edit-mode Studio session is connected");
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

  it("routes eval_server_runtime to the server peer and logs tools per peer", async () => {
    await startFakePlugin(() => {
      throw new Error("edit peer should not receive runtime commands");
    });
    const serverPlugin = await startFakePlugin(
      (command) => {
        expect(command.name).toBe("RunLuau");
        return { output: ["42"], returns: [42] };
      },
      { context: "server" },
    );
    const clientPlugin = await startFakePlugin(
      (command) => {
        expect(command.name).toBe("GetLogs");
        return { entries: [{ seq: 1, level: "Output", message: "client boot" }], latestSeq: 1, count: 1 };
      },
      { context: "client", userName: "Tester" },
    );

    const evalResult = await client.callTool({
      name: "eval_server_runtime",
      arguments: { code: "return 42" },
    });
    expect(evalResult.isError).toBeFalsy();
    expect(serverPlugin.executed.map((c) => c.name)).toEqual(["RunLuau"]);

    const logsResult = await client.callTool({
      name: "get_output_logs",
      arguments: { peer: "client" },
    });
    expect(logsResult.isError).toBeFalsy();
    expect((logsResult.content as Array<{ text: string }>)[0].text).toContain("client boot");
    expect(clientPlugin.executed.map((c) => c.name)).toEqual(["GetLogs"]);
  });

  it("explains how to get a runtime peer when none is connected", async () => {
    await startFakePlugin(() => ({}));
    const result = await client.callTool({ name: "eval_server_runtime", arguments: { code: "return 1" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("No server peer is connected");
  });

  it("lists connected peers", async () => {
    await startFakePlugin(() => ({}));
    await startFakePlugin(() => ({}), { context: "server" });
    const result = await client.callTool({ name: "get_connected_peers", arguments: {} });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text) as {
      peers: Array<{ context: string; connected: boolean }>;
    };
    expect(parsed.peers.map((p) => p.context)).toEqual(["edit", "server"]);
    expect(parsed.peers.every((p) => p.connected)).toBe(true);
  });

  it("validates instance paths before dispatching", async () => {
    await startFakePlugin(() => ({}));
    const result = await client.callTool({ name: "delete_instance", arguments: { path: "Workspace.Part" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("game");
  });

  it("requires targets for mass_set_properties", async () => {
    await startFakePlugin(() => ({}));
    const result = await client.callTool({
      name: "mass_set_properties",
      arguments: { properties: { Anchored: true } },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("paths");
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
