/**
 * get_roblox_docs tests: the YAML condenser plus the tool's fetch/caching
 * behavior using an injected fetcher (no live network required).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { condenseEngineYaml, setDocsFetcher } from "../server/src/mcp/tools/docs.js";
import { createMcpServer } from "../server/src/mcp/server.js";
import { HttpBridge } from "../server/src/bridge/http-bridge.js";
import { SessionRegistry } from "../server/src/bridge/sessions.js";
import { ServerConfig } from "../server/src/config.js";
import { makeConfig, makeNativeHost } from "./helpers/test-context.js";

const SAMPLE_YAML = `name: ProximityPrompt
type: class
memory_category: Instances
summary: |
  Allows prompting user interaction.
description: |
  The ProximityPrompt class lets you prompt users to interact.
code_samples:
  - proximity-sample-1
properties:
  - name: ProximityPrompt.ActionText
    summary: |
      Text shown to the user.
    code_samples:
    type: string
    thread_safety: ReadSafe
  - name: ProximityPrompt.HoldDuration
    summary: |
      Seconds the prompt must be held.
    type: float
events:
  - name: ProximityPrompt.Triggered
    summary: |
      Fires when the player triggers the prompt.
    parameters:
      - name: playerWhoTriggered
        type: Player
`;

describe("condenseEngineYaml", () => {
  it("keeps names, types, summaries and parameters", () => {
    const out = condenseEngineYaml(SAMPLE_YAML);
    expect(out).toContain("ProximityPrompt.ActionText");
    expect(out).toContain("ProximityPrompt.Triggered");
    expect(out).toContain("playerWhoTriggered");
    expect(out).toContain("Allows prompting user interaction.");
  });

  it("drops bulky metadata", () => {
    const out = condenseEngineYaml(SAMPLE_YAML);
    expect(out).not.toContain("memory_category");
    expect(out).not.toContain("thread_safety");
    expect(out).not.toContain("proximity-sample-1");
  });

  it("filters to a single member", () => {
    const out = condenseEngineYaml(SAMPLE_YAML, "Triggered");
    expect(out).toContain("ProximityPrompt.Triggered");
    expect(out).not.toContain("ProximityPrompt.ActionText");
    expect(out).not.toContain("HoldDuration");
  });
});

describe("get_roblox_docs tool", () => {
  let client: Client;
  let bridge: HttpBridge;
  const fetched: string[] = [];

  const config: ServerConfig = makeConfig();
  const native = makeNativeHost();

  beforeEach(async () => {
    fetched.length = 0;
    setDocsFetcher(async (url) => {
      fetched.push(url);
      if (url.includes("/classes/ProximityPrompt.yaml")) {
        return { status: 200, text: async () => SAMPLE_YAML };
      }
      return { status: 404, text: async () => "not found" };
    });

    const sessions = new SessionRegistry();
    bridge = new HttpBridge({ port: 0, authToken: config.authToken, sessions });
    await bridge.start();
    const server = createMcpServer({ sessions, bridge, config, native });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "docs-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await bridge.stop();
  });

  it("fetches and condenses class docs", async () => {
    const result = await client.callTool({
      name: "get_roblox_docs",
      arguments: { name: "ProximityPrompt" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('class "ProximityPrompt"');
    expect(text).toContain("ProximityPrompt.Triggered");
    expect(text).not.toContain("memory_category");
  });

  it("reports a clean miss for unknown names after trying all categories", async () => {
    const result = await client.callTool({
      name: "get_roblox_docs",
      arguments: { name: "TotallyBogusClass" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain("No official engine reference");
    expect(fetched.filter((u) => u.includes("TotallyBogusClass")).length).toBe(5);
  });
});
