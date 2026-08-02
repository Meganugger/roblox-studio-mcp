/**
 * Full-stack tests for the Open Cloud publish tools: a real MCP client calls
 * them against the real server, with the cloud transport faked and real place
 * files on disk. This covers what the agent actually depends on - the safe
 * default, the sandbox and file-format refusals, the exact bytes reaching
 * Roblox, and the security errors - plus the create_place_file -> publish_place
 * path end to end.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HttpBridge } from "../server/src/bridge/http-bridge.js";
import { SessionRegistry } from "../server/src/bridge/sessions.js";
import { createMcpServer } from "../server/src/mcp/server.js";
import { CLOUD_V2_BASE, OpenCloudConfig, PUBLISH_BASE } from "../server/src/cloud/open-cloud.js";
import { FakeCloudHttpClient } from "./helpers/fake-cloud.js";
import { makeCloudClient, makeConfig, makeNativeHost } from "./helpers/test-context.js";

const TOKEN = "publish-tools-token-1234567890";
const KEY = "publish-tools-open-cloud-key-abcdef";

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content.find((block) => block.type === "text")?.text ?? "";
}

function jsonOf(result: unknown): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

describe("Open Cloud publish tools", () => {
  let client: Client;
  let bridge: HttpBridge;
  let sessions: SessionRegistry;
  let http: FakeCloudHttpClient;
  let placesDir: string;

  async function start(cloudOverrides: Partial<OpenCloudConfig> = {}): Promise<void> {
    sessions = new SessionRegistry();
    bridge = new HttpBridge({ port: 0, authToken: TOKEN, sessions });
    await bridge.start();

    http = new FakeCloudHttpClient();
    const cloud = makeCloudClient({
      config: {
        allowPublish: true,
        apiKey: KEY,
        apiKeySource: "env",
        defaultUniverseId: 111,
        defaultPlaceId: 222,
        ...cloudOverrides,
      },
      http,
    });
    const config = makeConfig({ authToken: TOKEN, placesDir, placesRoot: placesDir });
    const server = createMcpServer({ sessions, bridge, config, native: makeNativeHost(), cloud });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "publish-test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  }

  /** Create a real place file through the MCP tool and return its path. */
  async function createPlace(name: string): Promise<string> {
    const result = await client.callTool({ name: "create_place_file", arguments: { name } });
    expect(result.isError, textOf(result)).toBeFalsy();
    return jsonOf(result).path as string;
  }

  beforeEach(() => {
    placesDir = mkdtempSync(join(tmpdir(), "mcp-publish-places-"));
  });

  afterEach(async () => {
    sessions.rejectAll("teardown");
    await client.close();
    await bridge.stop();
  });

  describe("get_publish_capabilities", () => {
    it("reports the configuration without ever revealing the API key", async () => {
      await start({ allowedUniverseIds: [111] });
      const result = await client.callTool({ name: "get_publish_capabilities", arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).not.toContain(KEY);

      const status = jsonOf(result);
      expect(status.gates).toEqual({ publishing: true });
      expect(status.apiKey).toMatchObject({ configured: true, source: "env" });
      expect((status.apiKey as { fingerprint: string }).fingerprint).toMatch(/^sha256:[0-9a-f]{12}$/);
      expect(status.defaults).toEqual({ universeId: 111, placeId: 222 });
      expect(status.allowedUniverseIds).toEqual([111]);
    });

    it("works, and explains the fix, while publishing is disabled", async () => {
      await start({ allowPublish: false, apiKey: undefined });
      const status = jsonOf(await client.callTool({ name: "get_publish_capabilities", arguments: {} }));
      expect(status.gates).toEqual({ publishing: false });
      expect(status.apiKey).toMatchObject({ configured: false, fingerprint: null });
      expect((status.notes as string[]).join("\n")).toContain("ROBLOX_MCP_ALLOW_PUBLISH=1");
    });
  });

  describe("publish_place", () => {
    it("uploads a generated place and reports the version Roblox assigned", async () => {
      await start();
      http.onRequest(() => ({ status: 200, text: JSON.stringify({ versionNumber: 12 }) }));
      const path = await createPlace("ShipIt");

      const result = await client.callTool({ name: "publish_place", arguments: { path } });
      expect(result.isError, textOf(result)).toBeFalsy();

      const request = http.only();
      expect(request.url).toBe(`${PUBLISH_BASE}/111/places/222/versions?versionType=Saved`);
      expect(request.headers["content-type"]).toBe("application/xml");
      // The exact file on disk is what reached Roblox.
      expect(Buffer.from(request.body as Uint8Array)).toEqual(readFileSync(path));

      const body = jsonOf(result);
      expect(body).toMatchObject({ versionNumber: 12, versionType: "Saved", format: "xml", path });
      expect(body.next).toContain('versionType="Published"');
    });

    it("defaults to Saved so the obvious call cannot surprise live players", async () => {
      await start();
      const path = await createPlace("SafeDefault");
      await client.callTool({ name: "publish_place", arguments: { path } });
      expect(http.only().url).toContain("versionType=Saved");
    });

    it("releases the version and points at the rollout step when asked to publish", async () => {
      await start();
      const path = await createPlace("GoLive");
      const result = await client.callTool({
        name: "publish_place",
        arguments: { path, versionType: "Published" },
      });
      expect(http.only().url).toContain("versionType=Published");
      expect(jsonOf(result).next).toContain("restart_universe_servers");
    });

    it("sends a binary .rbxl as octet-stream", async () => {
      await start();
      const path = join(placesDir, "Binary.rbxl");
      writeFileSync(path, "<roblox!\u0089\u00ff\u000d\u000a binary payload");
      const result = await client.callTool({ name: "publish_place", arguments: { path } });
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(http.only().headers["content-type"]).toBe("application/octet-stream");
      expect(jsonOf(result).format).toBe("binary");
    });

    it("accepts a bare file name resolved inside the places directory", async () => {
      await start();
      await createPlace("ByName");
      const result = await client.callTool({ name: "publish_place", arguments: { path: "ByName.rbxlx" } });
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(jsonOf(result).path).toBe(join(placesDir, "ByName.rbxlx"));
    });

    it("refuses a path outside the sandbox root before contacting Roblox", async () => {
      await start();
      const result = await client.callTool({
        name: "publish_place",
        arguments: { path: "/etc/passwd.rbxlx" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("outside the allowed place directory");
      expect(http.requests).toHaveLength(0);
    });

    it("refuses a file that is not a place file", async () => {
      await start();
      const path = join(placesDir, "NotAPlace.rbxlx");
      writeFileSync(path, "just some text");
      const result = await client.callTool({ name: "publish_place", arguments: { path } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("does not look like a Roblox place file");
      expect(http.requests).toHaveLength(0);
    });

    it("explains a missing file instead of uploading nothing", async () => {
      await start();
      const result = await client.callTool({ name: "publish_place", arguments: { path: "Ghost.rbxlx" } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/No place file at .*Ghost\.rbxlx/);
      expect(textOf(result)).toContain("save_project");
      expect(http.requests).toHaveLength(0);
    });

    it("refuses when the publishing gate is off, naming the setting", async () => {
      await start({ allowPublish: false });
      const path = await createPlace("Blocked");
      const result = await client.callTool({ name: "publish_place", arguments: { path } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("ROBLOX_MCP_ALLOW_PUBLISH=1");
      expect(http.requests).toHaveLength(0);
    });

    it("refuses a universe outside the allowlist", async () => {
      await start({ allowedUniverseIds: [111] });
      const path = await createPlace("WrongUniverse");
      const result = await client.callTool({
        name: "publish_place",
        arguments: { path, universeId: 999 },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("not in the allowlist");
      expect(http.requests).toHaveLength(0);
    });

    it("surfaces a permission failure with the exact scope to add", async () => {
      await start();
      http.setFallback({ status: 403, text: "Forbidden" });
      const path = await createPlace("NoPermission");
      const result = await client.callTool({ name: "publish_place", arguments: { path } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("universe-places:write");
      expect(textOf(result)).toContain("IP allowlist");
      expect(textOf(result)).not.toContain(KEY);
    });
  });

  describe("place and universe configuration", () => {
    it("reads universe and place info", async () => {
      await start();
      http
        .onRequest((request) =>
          request.url.endsWith("/universes/111") ? { status: 200, text: '{"displayName":"My Game"}' } : undefined,
        )
        .onRequest((request) =>
          request.url.endsWith("/places/222") ? { status: 200, text: '{"serverSize":30}' } : undefined,
        );

      expect(jsonOf(await client.callTool({ name: "get_universe_info", arguments: {} }))).toEqual({
        displayName: "My Game",
      });
      expect(jsonOf(await client.callTool({ name: "get_place_info", arguments: {} }))).toEqual({ serverSize: 30 });
      expect(http.requests.map((request) => request.url)).toEqual([
        `${CLOUD_V2_BASE}/universes/111`,
        `${CLOUD_V2_BASE}/universes/111/places/222`,
      ]);
    });

    it("updates only the fields it was given", async () => {
      await start();
      const result = await client.callTool({
        name: "update_place_config",
        arguments: { description: "Now with pets", serverSize: 16 },
      });
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(jsonOf(result).updateMask).toEqual(["description", "serverSize"]);
      expect(JSON.parse(http.only().body as string)).toEqual({ description: "Now with pets", serverSize: 16 });
    });

    it("rejects an update with no fields", async () => {
      await start();
      const result = await client.callTool({ name: "update_place_config", arguments: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("at least one of displayName, description or serverSize");
    });
  });

  describe("live server operations", () => {
    it("restarts servers and warns that players are disconnected", async () => {
      await start();
      const result = await client.callTool({ name: "restart_universe_servers", arguments: {} });
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(http.only().url).toBe(`${CLOUD_V2_BASE}/universes/111:restartServers`);
      expect(jsonOf(result).note).toContain("in-progress rounds are lost");
    });

    it("publishes a MessagingService message", async () => {
      await start();
      const result = await client.callTool({
        name: "publish_universe_message",
        arguments: { topic: "liveops", message: "reload" },
      });
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(http.only().url).toBe(`${CLOUD_V2_BASE}/universes/111:publishMessage`);
      expect(JSON.parse(http.only().body as string)).toEqual({ topic: "liveops", message: "reload" });
    });

    it("requires a universe id when none is configured", async () => {
      await start({ defaultUniverseId: undefined });
      const result = await client.callTool({ name: "restart_universe_servers", arguments: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("ROBLOX_MCP_UNIVERSE_ID");
      expect(http.requests).toHaveLength(0);
    });
  });
});
