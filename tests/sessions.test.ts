import { describe, expect, it } from "vitest";
import { SessionRegistry, UnknownPeerError } from "../server/src/bridge/sessions.js";
import { PluginHello } from "@roblox-studio-mcp/shared";

function hello(overrides: Partial<PluginHello> = {}): PluginHello {
  return {
    pluginVersion: "2.0.0",
    protocolVersion: 2,
    sessionId: "session-" + Math.random().toString(36).slice(2, 10),
    context: "edit",
    placeName: "Place",
    placeId: 1,
    gameId: 1,
    ...overrides,
  };
}

describe("SessionRegistry", () => {
  it("registers peers and resolves them by context shortcut", () => {
    const registry = new SessionRegistry();
    const edit = registry.upsert(hello({ context: "edit" }));
    const server = registry.upsert(hello({ context: "server" }));

    expect(registry.resolve("edit")).toBe(edit);
    expect(registry.resolve("server")).toBe(server);
    expect(registry.editSession()).toBe(edit);
  });

  it("resolves explicit sessionIds", () => {
    const registry = new SessionRegistry();
    const client = registry.upsert(hello({ context: "client", sessionId: "client-abc123" }));
    expect(registry.resolve("client-abc123")).toBe(client);
  });

  it("throws a helpful error when no peer matches", () => {
    const registry = new SessionRegistry();
    expect(() => registry.resolve("edit")).toThrow(UnknownPeerError);
    expect(() => registry.resolve("server")).toThrow(/Start a playtest/);
    expect(() => registry.resolve("bogus-selector")).toThrow(/get_connected_peers/);
  });

  it("reports ambiguity between multiple clients with candidates", () => {
    const registry = new SessionRegistry();
    registry.upsert(hello({ context: "client", sessionId: "client-a", userName: "Alice" }));
    registry.upsert(hello({ context: "client", sessionId: "client-b", userName: "Bob" }));
    expect(() => registry.resolve("client")).toThrow(/client-a.*client-b|client-b.*client-a/s);
  });

  it("re-hello updates an existing session instead of duplicating it", () => {
    const registry = new SessionRegistry();
    const first = registry.upsert(hello({ sessionId: "stable-session-1", placeName: "Before" }));
    const second = registry.upsert(hello({ sessionId: "stable-session-1", placeName: "After" }));
    expect(second).toBe(first);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].placeName).toBe("After");
  });

  it("lists peers ordered edit, server, client with identity", () => {
    const registry = new SessionRegistry();
    registry.upsert(hello({ context: "client", sessionId: "c1", userName: "P1", userId: 7 }));
    registry.upsert(hello({ context: "edit", sessionId: "e1" }));
    registry.upsert(hello({ context: "server", sessionId: "s1" }));

    const list = registry.list();
    expect(list.map((p) => p.context)).toEqual(["edit", "server", "client"]);
    expect(list[2]).toMatchObject({ userName: "P1", userId: 7, connected: true });
  });

  it("rejectAll clears every session", () => {
    const registry = new SessionRegistry();
    registry.upsert(hello());
    registry.upsert(hello({ context: "server" }));
    registry.rejectAll("bye");
    expect(registry.list()).toHaveLength(0);
  });
});
