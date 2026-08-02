/**
 * Builders for a ServerConfig / ToolContext in tests, so adding a config field
 * does not require editing every test file.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerConfig } from "../../server/src/config.js";
import { NativeConfig, NativeHost, NativeHostOptions } from "../../server/src/native/host.js";
import { OpenCloudClient, OpenCloudConfig } from "../../server/src/cloud/open-cloud.js";
import { CloudHttpClient } from "../../server/src/cloud/types.js";

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
    allowPublish: false,
    openCloudKey: undefined,
    openCloudKeySource: undefined,
    openCloudKeyPath: join(tmpdir(), "roblox-mcp-test-open-cloud-key"),
    universeId: undefined,
    placeId: undefined,
    allowedUniverseIds: [],
    maxPlaceUploadBytes: 100 * 1024 * 1024,
    maxScriptSourceBytes: 512 * 1024,
    maxLuauCodeBytes: 256 * 1024,
    ...overrides,
  };
}

export function makeCloudConfig(overrides: Partial<OpenCloudConfig> = {}): OpenCloudConfig {
  return {
    allowPublish: false,
    apiKey: undefined,
    apiKeySource: undefined,
    apiKeyPath: join(tmpdir(), "roblox-mcp-test-open-cloud-key"),
    defaultUniverseId: undefined,
    defaultPlaceId: undefined,
    allowedUniverseIds: [],
    maxUploadBytes: 100 * 1024 * 1024,
    ...overrides,
  };
}

export function makeCloudClient(
  options: { config?: Partial<OpenCloudConfig>; http?: CloudHttpClient } = {},
): OpenCloudClient {
  return new OpenCloudClient({ config: makeCloudConfig(options.config), http: options.http });
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
