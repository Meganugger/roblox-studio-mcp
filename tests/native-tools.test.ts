/**
 * Full-stack tests for the native host + place tools: a real MCP client calls
 * them against the real server, with an injected native backend and simulated
 * Studio plugins. This verifies the parts the agent actually depends on -
 * launching and waiting for peers, screenshots coming back as images, native
 * saving, and the security errors.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BridgeCommand } from "@roblox-studio-mcp/shared";
import { HttpBridge } from "../server/src/bridge/http-bridge.js";
import { SessionRegistry } from "../server/src/bridge/sessions.js";
import { createMcpServer } from "../server/src/mcp/server.js";
import { NativeHost } from "../server/src/native/host.js";
import { ServerConfig } from "../server/src/config.js";
import { FakePlugin } from "./helpers/fake-plugin.js";
import { FakeCommandRunner, FakeFileSystem } from "./helpers/fake-native.js";
import { makeCloudClient, makeConfig, makeNativeConfig } from "./helpers/test-context.js";

const TOKEN = "native-tools-token-123456";
const STUDIO_EXE = "/opt/roblox/RobloxStudioBeta.exe";

interface Harness {
  client: Client;
  sessions: SessionRegistry;
  bridge: HttpBridge;
  runner: FakeCommandRunner;
  nativeFs: FakeFileSystem;
  config: ServerConfig;
  baseUrl: string;
  plugins: FakePlugin[];
  connectPlugin(options: { context: "edit" | "server" | "client"; handler?: (command: BridgeCommand) => unknown }): Promise<FakePlugin>;
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content.find((block) => block.type === "text")?.text ?? "";
}

function jsonOf(result: unknown): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

describe("native host and place tools", () => {
  let harness: Harness;
  let placesDir: string;

  beforeEach(async () => {
    const sessions = new SessionRegistry();
    const bridge = new HttpBridge({ port: 0, authToken: TOKEN, sessions });
    const port = await bridge.start();
    const baseUrl = `http://127.0.0.1:${port}`;
    const plugins: FakePlugin[] = [];

    placesDir = mkdtempSync(join(tmpdir(), "mcp-native-places-"));
    const config = makeConfig({ authToken: TOKEN, placesDir, placesRoot: placesDir, studioPath: STUDIO_EXE });

    const nativeFs = new FakeFileSystem().addFile(STUDIO_EXE, "exe");
    const runner = new FakeCommandRunner();
    runner.available = ["xdotool", "pgrep", "pkill", "import", "identify", "convert"];
    runner
      .onRun((call) => {
        if (call.program !== "xdotool") return undefined;
        switch (call.args[0]) {
          case "search":
            return { code: 0, stdout: "99\n" };
          case "getwindowgeometry":
            return { code: 0, stdout: "WINDOW=99\nX=0\nY=0\nWIDTH=1920\nHEIGHT=1080\n" };
          case "getwindowname":
            return { code: 0, stdout: "Sim - Roblox Studio\n" };
          case "getactivewindow":
            return { code: 0, stdout: "99\n" };
          default:
            return { code: 0, stdout: "" };
        }
      })
      .onRun((call) => {
        if (call.program !== "import") return undefined;
        nativeFs.addFile(call.args.at(-1) as string, "PNGBYTES".repeat(64));
        return { code: 0, stdout: "" };
      })
      .onRun((call) => (call.program === "identify" ? { code: 0, stdout: "1280 720\n" } : undefined))
      .onRun((call) => (call.program === "pgrep" ? { code: 0, stdout: "" } : undefined));

    const native = new NativeHost({
      platform: "linux",
      runner,
      fs: nativeFs,
      env: { DISPLAY: ":0" },
      homeDir: placesDir,
      config: makeNativeConfig({ screenshotDir: join(placesDir, "shots"), studioPath: STUDIO_EXE }),
    });

    const server = createMcpServer({ sessions, bridge, config, native, cloud: makeCloudClient() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "native-test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    harness = {
      client,
      sessions,
      bridge,
      runner,
      nativeFs,
      config,
      baseUrl,
      plugins,
      async connectPlugin({ context, handler }) {
        const plugin = new FakePlugin({
          baseUrl,
          token: TOKEN,
          context,
          handler: handler ?? (() => ({ ok: true })),
        });
        plugins.push(plugin);
        await plugin.hello();
        plugin.start();
        return plugin;
      },
    };
  });

  afterEach(async () => {
    for (const plugin of harness.plugins) plugin.stop();
    harness.sessions.rejectAll("teardown");
    await harness.client.close();
    await harness.bridge.stop();
  });

  it("reports host capabilities including gates, backend and shortcuts", async () => {
    const result = await harness.client.callTool({ name: "get_host_capabilities", arguments: {} });
    const payload = jsonOf(result);
    expect(payload).toMatchObject({
      platform: "linux",
      supported: true,
      gates: { nativeControl: true, inputSimulation: true },
    });
    expect(String(payload.backend)).toMatch(/xdotool/);
    expect((payload.shortcuts as Array<{ name: string }>).map((shortcut) => shortcut.name)).toEqual([
      "play",
      "run",
      "stop",
      "save",
      "saveAs",
      "undo",
      "redo",
      "escape",
      "confirm",
    ]);
    expect(payload.studio).toMatchObject({ executablePath: STUDIO_EXE });
  });

  it("launches Studio and waits until the plugin's edit peer connects", async () => {
    harness.runner.onSpawn = async () => {
      await harness.connectPlugin({ context: "edit" });
    };
    const result = await harness.client.callTool({
      name: "launch_studio",
      arguments: { waitForPlugin: true, timeoutMs: 5_000 },
    });
    const payload = jsonOf(result);
    expect(payload).toMatchObject({ executablePath: STUDIO_EXE, pluginConnected: true, waitedForPlugin: true });
    expect((payload.peer as { context: string }).context).toBe("edit");
    expect(harness.runner.spawns[0]).toMatchObject({ program: STUDIO_EXE, args: [] });
  });

  it("reports a timeout with a diagnosis when the plugin never connects", async () => {
    const result = await harness.client.callTool({
      name: "launch_studio",
      arguments: { waitForPlugin: true, timeoutMs: 5_000 },
    });
    const payload = jsonOf(result);
    expect(payload.pluginConnected).toBe(false);
    expect(String(payload.hint)).toMatch(/--install-plugin/);
  });

  it("refuses both placeFilePath and placeId at once", async () => {
    const result = await harness.client.callTool({
      name: "launch_studio",
      arguments: { placeFilePath: "Game.rbxlx", placeId: 5 },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/either placeFilePath or placeId/);
  });

  it("returns a screenshot as an inline image plus metadata", async () => {
    const result = await harness.client.callTool({
      name: "capture_studio_screenshot",
      arguments: { maxWidth: 1280, label: "lobby" },
    });
    expect(result.isError).toBeFalsy();
    const blocks = (result as { content: Array<{ type: string; data?: string; mimeType?: string }> }).content;
    const image = blocks.find((block) => block.type === "image");
    expect(image?.mimeType).toBe("image/png");
    expect((image?.data ?? "").length).toBeGreaterThan(100);
    const metadata = jsonOf(result);
    expect(metadata).toMatchObject({ width: 1280, height: 720, inlined: true, via: "import" });
    expect(String(metadata.path)).toContain("lobby-");
  });

  it("can save a screenshot without inlining it", async () => {
    const result = await harness.client.callTool({
      name: "capture_studio_screenshot",
      arguments: { includeImage: false },
    });
    const blocks = (result as { content: Array<{ type: string }> }).content;
    expect(blocks.some((block) => block.type === "image")).toBe(false);
    expect(jsonOf(result)).toMatchObject({ inlined: false });
  });

  it("sends allowlisted shortcuts and rejects unknown ones", async () => {
    const ok = await harness.client.callTool({ name: "send_studio_shortcut", arguments: { shortcut: "escape" } });
    expect(ok.isError).toBeFalsy();
    expect(jsonOf(ok)).toMatchObject({ shortcut: "escape", keys: "Esc" });
    expect(harness.runner.callsTo("xdotool").map((call) => call.args.join(" "))).toContain(
      "key --clearmodifiers Escape",
    );

    const bad = await harness.client.callTool({
      name: "send_studio_shortcut",
      arguments: { shortcut: "rm -rf /" },
    });
    expect(bad.isError).toBe(true);
  });

  it("starts a play session and waits for the playtest peers", async () => {
    harness.runner.onRunFirst((call) => {
      if (call.program === "xdotool" && call.args[0] === "key" && call.args.includes("F5")) {
        void (async () => {
          await harness.connectPlugin({ context: "server" });
          await harness.connectPlugin({ context: "client" });
        })();
        return { code: 0, stdout: "" };
      }
      return undefined;
    });

    const result = await harness.client.callTool({
      name: "start_play_solo",
      arguments: { timeoutMs: 8_000 },
    });
    const payload = jsonOf(result);
    expect(payload).toMatchObject({ shortcut: "play", keys: "F5", running: true });
    expect((payload.serverPeer as { context: string }).context).toBe("server");
    expect((payload.clientPeer as { context: string }).context).toBe("client");
    expect(String(payload.next)).toMatch(/eval_server_runtime/);
  });

  it("explains a play session that produced no peers", async () => {
    const result = await harness.client.callTool({
      name: "start_play_solo",
      arguments: { timeoutMs: 5_000 },
    });
    const payload = jsonOf(result);
    expect(payload.running).toBe(false);
    expect(String(payload.hint)).toMatch(/saved token|modal dialog/);
  });

  it("stops a play session with Shift+F5", async () => {
    const result = await harness.client.callTool({ name: "stop_play_solo", arguments: { settleMs: 0 } });
    expect(jsonOf(result)).toMatchObject({ shortcut: "stop", keys: "Shift+F5" });
    expect(harness.runner.callsTo("xdotool").map((call) => call.args.join(" "))).toContain(
      "key --clearmodifiers shift+F5",
    );
  });

  it("saves the place with a real keystroke and verifies Studio still responds", async () => {
    const commands: string[] = [];
    await harness.connectPlugin({
      context: "edit",
      handler: (command) => {
        commands.push(command.name);
        return { pong: true };
      },
    });

    const result = await harness.client.callTool({ name: "save_project", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(jsonOf(result)).toMatchObject({
      keystrokeDelivered: true,
      keys: "Ctrl+S",
      studioResponsive: true,
      saved: true,
    });
    // The ping proves Studio is not stuck behind a modal Save As dialog.
    expect(commands).toEqual(["Ping"]);
  });

  it("warns when Studio stops responding after the save keystroke", async () => {
    const plugin = await harness.connectPlugin({ context: "edit" });
    // Simulate a modal dialog: the plugin stops answering commands.
    plugin.stop();
    const result = await harness.client.callTool({ name: "save_project", arguments: {} });
    const payload = jsonOf(result);
    expect(payload).toMatchObject({ keystrokeDelivered: true, verified: true, studioResponsive: false, saved: false });
    expect(String(payload.warning)).toMatch(/send_studio_shortcut/);
  }, 45_000);

  it("does not claim a modal dialog when no plugin is connected to verify with", async () => {
    const result = await harness.client.callTool({ name: "save_project", arguments: {} });
    const payload = jsonOf(result);
    expect(payload).toMatchObject({ keystrokeDelivered: true, keys: "Ctrl+S", verified: false });
    expect(payload.warning).toBeUndefined();
    expect(String(payload.note)).toMatch(/no plugin peer is connected/);
  });

  it("falls back to the in-Studio notification when native input is disabled", async () => {
    const nativeFs = new FakeFileSystem().addFile(STUDIO_EXE, "exe");
    const sessions = new SessionRegistry();
    const bridge = new HttpBridge({ port: 0, authToken: TOKEN, sessions });
    const port = await bridge.start();
    const requests: string[] = [];
    const plugin = new FakePlugin({
      baseUrl: `http://127.0.0.1:${port}`,
      token: TOKEN,
      context: "edit",
      handler: (command) => {
        requests.push(command.name);
        return { notified: true };
      },
    });
    await plugin.hello();
    plugin.start();

    const native = new NativeHost({
      platform: "linux",
      runner: new FakeCommandRunner(),
      fs: nativeFs,
      env: { DISPLAY: ":0" },
      config: makeNativeConfig({ allowNativeInput: false, screenshotDir: join(placesDir, "shots") }),
    });
    const server = createMcpServer({ sessions, bridge, config: makeConfig({ authToken: TOKEN }), native, cloud: makeCloudClient() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "fallback-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.callTool({ name: "save_project", arguments: {} });
      expect(jsonOf(result)).toMatchObject({ keystrokeDelivered: false, notifiedUserInStudio: true });
      expect(String(jsonOf(result).nativeSaveUnavailable)).toMatch(/ROBLOX_MCP_ALLOW_NATIVE_INPUT=0/);
      expect(requests).toEqual(["RequestSave"]);

      const shortcut = await client.callTool({ name: "send_studio_shortcut", arguments: { shortcut: "play" } });
      expect(shortcut.isError).toBe(true);
      expect(textOf(shortcut)).toMatch(/ROBLOX_MCP_ALLOW_NATIVE_INPUT=0/);
    } finally {
      plugin.stop();
      sessions.rejectAll("teardown");
      await client.close();
      await bridge.stop();
    }
  });

  it("creates a place file from a template and lists it", async () => {
    const created = await harness.client.callTool({
      name: "create_place_file",
      arguments: { name: "PetSimulator", template: "baseplate" },
    });
    const payload = jsonOf(created);
    const path = String(payload.path);
    expect(path).toBe(join(placesDir, "PetSimulator.rbxlx"));
    expect(payload).toMatchObject({ exists: true, format: "xml", template: "baseplate" });
    expect(readFileSync(path, "utf8")).toContain('<Item class="SpawnLocation"');

    const listed = await harness.client.callTool({ name: "list_place_files", arguments: {} });
    const files = jsonOf(listed).files as Array<{ name: string }>;
    expect(files.map((file) => file.name)).toContain("PetSimulator.rbxlx");
  });

  it("refuses to create places outside the sandbox or with the wrong extension", async () => {
    const outside = await harness.client.callTool({
      name: "create_place_file",
      arguments: { path: "/etc/evil.rbxlx" },
    });
    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toMatch(/outside the allowed place directory/);

    const wrongExtension = await harness.client.callTool({
      name: "create_place_file",
      arguments: { path: join(placesDir, "notes.txt") },
    });
    expect(wrongExtension.isError).toBe(true);
    expect(textOf(wrongExtension)).toMatch(/must end in/);
  });

  it("opens an existing place file in Studio and waits for the peer", async () => {
    await harness.client.callTool({ name: "create_place_file", arguments: { name: "OpenMe" } });
    harness.runner.onSpawn = async () => {
      await harness.connectPlugin({ context: "edit" });
    };

    const result = await harness.client.callTool({
      name: "open_place_file",
      arguments: { path: "OpenMe.rbxlx", timeoutMs: 5_000 },
    });
    const payload = jsonOf(result);
    expect(payload).toMatchObject({ pluginConnected: true });
    expect(payload.place).toMatchObject({ format: "xml", exists: true });
    expect(harness.runner.spawns[0].args).toEqual([join(placesDir, "OpenMe.rbxlx")]);
  });

  it("reports a missing or invalid place file before launching Studio", async () => {
    const missing = await harness.client.callTool({
      name: "open_place_file",
      arguments: { path: "Nope.rbxlx" },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/No place file at/);
    expect(harness.runner.spawns).toHaveLength(0);
  });

  it("lists the available place templates", async () => {
    const result = await harness.client.callTool({ name: "list_place_templates", arguments: {} });
    const payload = jsonOf(result);
    expect((payload.templates as Array<{ id: string }>).map((template) => template.id)).toEqual([
      "baseplate",
      "flat",
      "empty",
    ]);
    expect(payload).toMatchObject({ placesDir, placesRoot: placesDir });
  });

  it("lists Studio processes", async () => {
    harness.runner.onRunFirst((call) => (call.program === "pgrep" ? { code: 0, stdout: "1234\n" } : undefined));
    const result = await harness.client.callTool({ name: "get_studio_processes", arguments: {} });
    expect(jsonOf(result)).toMatchObject({ running: true, count: 1 });
  });

  it("warns that force-closing Studio discards unsaved work", async () => {
    harness.runner.onRunFirst((call) => (call.program === "pgrep" ? { code: 0, stdout: "1234\n" } : undefined));
    const result = await harness.client.callTool({ name: "close_studio", arguments: { force: true } });
    expect(jsonOf(result)).toMatchObject({ closed: 1, forced: true });
    expect(String(jsonOf(result).note)).toMatch(/unsaved changes were discarded/);
  });
});
