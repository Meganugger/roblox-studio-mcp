/**
 * Tests for the Open Cloud parts of the configuration: how the API key is
 * resolved (and deliberately never generated), and how the publishing gate,
 * default ids, universe allowlist and upload limit are parsed from the
 * environment. Every case runs against a throwaway ROBLOX_MCP_HOME.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resolveOpenCloudKey } from "../server/src/config.js";

const KEY = "a-real-looking-open-cloud-key-1234";

describe("Open Cloud configuration", () => {
  let home: string;
  let saved: NodeJS.ProcessEnv;

  const CLOUD_VARS = [
    "ROBLOX_MCP_HOME",
    "ROBLOX_MCP_ALLOW_PUBLISH",
    "ROBLOX_MCP_OPEN_CLOUD_KEY",
    "ROBLOX_MCP_UNIVERSE_ID",
    "ROBLOX_MCP_PLACE_ID",
    "ROBLOX_MCP_ALLOWED_UNIVERSES",
    "ROBLOX_MCP_MAX_PLACE_UPLOAD_BYTES",
  ];

  beforeEach(() => {
    saved = { ...process.env };
    home = mkdtempSync(join(tmpdir(), "mcp-config-home-"));
    for (const name of CLOUD_VARS) delete process.env[name];
    process.env.ROBLOX_MCP_HOME = home;
  });

  afterEach(() => {
    for (const name of CLOUD_VARS) delete process.env[name];
    for (const [name, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[name] = value;
    }
  });

  describe("resolveOpenCloudKey", () => {
    it("prefers the environment variable and reports its source", () => {
      const resolution = resolveOpenCloudKey({ ROBLOX_MCP_OPEN_CLOUD_KEY: `  ${KEY}  ` });
      expect(resolution).toMatchObject({ key: KEY, source: "env" });
      expect(resolution.path).toBe(join(home, "open-cloud-key"));
    });

    it("falls back to the persisted key file", () => {
      writeFileSync(join(home, "open-cloud-key"), `${KEY}\n`);
      expect(resolveOpenCloudKey({})).toMatchObject({ key: KEY, source: "file" });
    });

    it("never invents a key: absence is a reported state, not an error", () => {
      const resolution = resolveOpenCloudKey({});
      expect(resolution.key).toBeUndefined();
      expect(resolution.source).toBeUndefined();
      // The path is still reported so the tools can tell the user where to put one.
      expect(resolution.path).toBe(join(home, "open-cloud-key"));
    });

    it("rejects a truncated environment key instead of failing later at Roblox", () => {
      expect(() => resolveOpenCloudKey({ ROBLOX_MCP_OPEN_CLOUD_KEY: "too-short" })).toThrowError(
        /cannot be a real Roblox/,
      );
    });

    it("ignores an implausible key file rather than sending garbage", () => {
      writeFileSync(join(home, "open-cloud-key"), "nope\n");
      expect(resolveOpenCloudKey({}).key).toBeUndefined();
    });
  });

  describe("loadConfig", () => {
    it("keeps publishing off by default", () => {
      expect(loadConfig().allowPublish).toBe(false);
    });

    it("enables publishing only when explicitly turned on", () => {
      process.env.ROBLOX_MCP_ALLOW_PUBLISH = "1";
      expect(loadConfig().allowPublish).toBe(true);
      process.env.ROBLOX_MCP_ALLOW_PUBLISH = "0";
      expect(loadConfig().allowPublish).toBe(false);
    });

    it("parses the default ids, the allowlist and the upload limit", () => {
      process.env.ROBLOX_MCP_UNIVERSE_ID = "12345";
      process.env.ROBLOX_MCP_PLACE_ID = "67890";
      process.env.ROBLOX_MCP_ALLOWED_UNIVERSES = "12345, 54321 ,999";
      process.env.ROBLOX_MCP_MAX_PLACE_UPLOAD_BYTES = "2048";
      process.env.ROBLOX_MCP_OPEN_CLOUD_KEY = KEY;

      const config = loadConfig();
      expect(config.universeId).toBe(12345);
      expect(config.placeId).toBe(67890);
      expect(config.allowedUniverseIds).toEqual([12345, 54321, 999]);
      expect(config.maxPlaceUploadBytes).toBe(2048);
      expect(config.openCloudKey).toBe(KEY);
      expect(config.openCloudKeySource).toBe("env");
    });

    it("defaults to no ids, no allowlist and a 100 MiB upload limit", () => {
      const config = loadConfig();
      expect(config.universeId).toBeUndefined();
      expect(config.placeId).toBeUndefined();
      expect(config.allowedUniverseIds).toEqual([]);
      expect(config.maxPlaceUploadBytes).toBe(100 * 1024 * 1024);
    });

    it("rejects malformed ids instead of silently ignoring them", () => {
      process.env.ROBLOX_MCP_UNIVERSE_ID = "not-a-number";
      expect(() => loadConfig()).toThrowError(/ROBLOX_MCP_UNIVERSE_ID/);
      process.env.ROBLOX_MCP_UNIVERSE_ID = "0";
      expect(() => loadConfig()).toThrowError(/positive integer/);
    });

    it("rejects a malformed allowlist entry so the sandbox is never half-applied", () => {
      process.env.ROBLOX_MCP_ALLOWED_UNIVERSES = "111,oops";
      expect(() => loadConfig()).toThrowError(/ROBLOX_MCP_ALLOWED_UNIVERSES/);
    });

    it("rejects a nonsensical upload limit", () => {
      process.env.ROBLOX_MCP_MAX_PLACE_UPLOAD_BYTES = "-5";
      expect(() => loadConfig()).toThrowError(/ROBLOX_MCP_MAX_PLACE_UPLOAD_BYTES/);
    });
  });
});
