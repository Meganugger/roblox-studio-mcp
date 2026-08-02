/**
 * Builders for a ServerConfig / ToolContext in tests, so adding a config field
 * does not require editing every test file.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerConfig } from "../../server/src/config.js";
import { NativeConfig, NativeHost, NativeHostOptions } from "../../server/src/native/host.js";

export function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    bridgePort: 0,
    authToken: "test-token-1234567890",
    transport: "stdio",
    httpPort: 0,
    httpHost: "127.0.0.1",
    httpToken: "",
    allowRunLuau: true,
    allowInsertAsset: true,
    allowNative: true,
    allowNativeInput: true,
    studioPath: undefined,
    placesDir: join(tmpdir(), "roblox-mcp-test-places"),
    placesRoot: tmpdir(),
    screenshotDir: join(tmpdir(), "roblox-mcp-test-shots"),
    maxScriptSourceBytes: 512 * 1024,
    maxLuauCodeBytes: 256 * 1024,
    ...overrides,
  };
}

export function makeNativeConfig(overrides: Partial<NativeConfig> = {}): NativeConfig {
  return {
    allowNative: true,
    allowNativeInput: true,
    screenshotDir: join(tmpdir(), "roblox-mcp-test-shots"),
    ...overrides,
  };
}

export function makeNativeHost(options: Partial<NativeHostOptions> & { config?: NativeConfig } = {}): NativeHost {
  return new NativeHost({
    ...options,
    config: options.config ?? makeNativeConfig(),
  });
}
