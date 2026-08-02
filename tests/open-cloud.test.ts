/**
 * Unit tests for the Open Cloud client: the exact requests it sends to Roblox,
 * the security gates, the universe allowlist, API-key handling/redaction, and
 * the mapping from HTTP status to an actionable fix. Everything runs through the
 * injected transport, so no network access is involved.
 */
import { describe, expect, it } from "vitest";
import {
  CLOUD_V2_BASE,
  explainStatus,
  fingerprint,
  OpenCloudClient,
  PUBLISH_BASE,
  redact,
} from "../server/src/cloud/open-cloud.js";
import {
  OpenCloudRequestError,
  OpenCloudTransportError,
  OpenCloudUnavailableError,
} from "../server/src/cloud/types.js";
import { FakeCloudHttpClient } from "./helpers/fake-cloud.js";
import { makeCloudClient } from "./helpers/test-context.js";

const KEY = "test-open-cloud-api-key-abcdefghij";

function clientWith(
  overrides: Parameters<typeof makeCloudClient>[0]["config"] = {},
): { client: OpenCloudClient; http: FakeCloudHttpClient } {
  const http = new FakeCloudHttpClient();
  const client = makeCloudClient({
    config: { allowPublish: true, apiKey: KEY, defaultUniverseId: 111, defaultPlaceId: 222, ...overrides },
    http,
  });
  return { client, http };
}

const xmlPlace = () => new TextEncoder().encode('<roblox version="4"></roblox>');

describe("OpenCloudClient gates and configuration", () => {
  it("refuses every call when the publishing gate is off, naming the setting", async () => {
    const { client, http } = clientWith({ allowPublish: false });
    await expect(client.getUniverse()).rejects.toThrowError(OpenCloudUnavailableError);
    await expect(client.getUniverse()).rejects.toThrowError(/ROBLOX_MCP_ALLOW_PUBLISH/);
    expect(http.requests).toHaveLength(0);
  });

  it("refuses every call when no API key is configured, pointing at both sources", async () => {
    const { client, http } = clientWith({ apiKey: undefined, apiKeyPath: "/home/u/.roblox-studio-mcp/open-cloud-key" });
    await expect(client.getUniverse()).rejects.toThrowError(
      /ROBLOX_MCP_OPEN_CLOUD_KEY|\/home\/u\/\.roblox-studio-mcp\/open-cloud-key/,
    );
    expect(http.requests).toHaveLength(0);
  });

  it("requires a universe id when neither an argument nor a default exists", () => {
    const { client } = clientWith({ defaultUniverseId: undefined });
    expect(() => client.resolveUniverseId()).toThrowError(/ROBLOX_MCP_UNIVERSE_ID/);
    expect(client.resolveUniverseId(987)).toBe(987);
  });

  it("requires a place id when neither an argument nor a default exists", () => {
    const { client } = clientWith({ defaultPlaceId: undefined });
    expect(() => client.resolvePlaceId()).toThrowError(/ROBLOX_MCP_PLACE_ID/);
    expect(client.resolvePlaceId(654)).toBe(654);
  });

  it("enforces the universe allowlist even when the API key could reach the universe", async () => {
    const { client, http } = clientWith({ allowedUniverseIds: [111, 333] });
    expect(client.resolveUniverseId(333)).toBe(333);
    await expect(client.getUniverse(999)).rejects.toThrowError(/not in the allowlist/);
    await expect(client.getUniverse(999)).rejects.toThrowError(/ROBLOX_MCP_ALLOWED_UNIVERSES=111,333/);
    expect(http.requests).toHaveLength(0);
  });

  it("allows any universe when the allowlist is empty", async () => {
    const { client, http } = clientWith();
    await client.getUniverse(424242);
    expect(http.only().url).toBe(`${CLOUD_V2_BASE}/universes/424242`);
  });
});

describe("OpenCloudClient.status", () => {
  it("never exposes the key, only a stable fingerprint and its source", () => {
    const { client } = clientWith({
      apiKeySource: "file",
      apiKeyPath: "/keys/open-cloud-key",
      allowedUniverseIds: [111],
    });
    const status = client.status();
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(status.apiKey).toEqual({
      configured: true,
      source: "file",
      fingerprint: fingerprint(KEY),
      path: "/keys/open-cloud-key",
    });
    expect(status.gates.publishing).toBe(true);
    expect(status.notes).toEqual([]);
  });

  it("explains every missing prerequisite when nothing is configured", () => {
    const client = makeCloudClient({ config: { allowPublish: false } });
    const status = client.status();
    expect(status.apiKey.configured).toBe(false);
    expect(status.apiKey.fingerprint).toBeNull();
    const notes = status.notes.join("\n");
    expect(notes).toContain("ROBLOX_MCP_ALLOW_PUBLISH");
    expect(notes).toContain("create.roblox.com/dashboard/credentials");
    expect(notes).toContain("ROBLOX_MCP_UNIVERSE_ID");
    expect(notes).toContain("ROBLOX_MCP_ALLOWED_UNIVERSES");
  });

  it("reports the required API-key permission for every operation", () => {
    const { client } = clientWith();
    expect(client.status().requiredScopes).toMatchObject({
      publishPlace: expect.stringContaining("universe-places:write"),
      readUniverse: "universe:read",
      writePlace: "universe.place:write",
      restartServers: "universe:write",
      publishMessage: "universe-messaging-service:publish",
    });
  });

  it("produces a fingerprint that identifies a key without revealing it", () => {
    const print = fingerprint(KEY);
    expect(print).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(print).toBe(fingerprint(KEY));
    expect(print).not.toBe(fingerprint(`${KEY}x`));
    expect(print).not.toContain(KEY.slice(0, 8));
  });
});

describe("publishPlace", () => {
  it("uploads XML places to the versioned publish endpoint with the right headers", async () => {
    const { client, http } = clientWith();
    http.onRequest(() => ({ status: 200, text: JSON.stringify({ versionNumber: 7 }) }));

    const outcome = await client.publishPlace({
      versionType: "Saved",
      contents: xmlPlace(),
      format: "xml",
    });

    const request = http.only();
    expect(request.method).toBe("POST");
    expect(request.url).toBe(`${PUBLISH_BASE}/111/places/222/versions?versionType=Saved`);
    expect(request.headers["x-api-key"]).toBe(KEY);
    expect(request.headers["content-type"]).toBe("application/xml");
    expect(request.headers.accept).toBe("application/json");
    expect(new TextDecoder().decode(request.body as Uint8Array)).toBe('<roblox version="4"></roblox>');
    expect(outcome.bytes).toBe(29);
    expect(outcome).toMatchObject({
      universeId: 111,
      placeId: 222,
      versionType: "Saved",
      versionNumber: 7,
      format: "xml",
      contentType: "application/xml",
    });
  });

  it("sends binary places as octet-stream and honours explicit ids", async () => {
    const { client, http } = clientWith();
    await client.publishPlace({
      universeId: 555,
      placeId: 666,
      versionType: "Published",
      contents: new Uint8Array([1, 2, 3, 4]),
      format: "binary",
    });
    const request = http.only();
    expect(request.url).toBe(`${PUBLISH_BASE}/555/places/666/versions?versionType=Published`);
    expect(request.headers["content-type"]).toBe("application/octet-stream");
    expect(request.body).toBeInstanceOf(Uint8Array);
  });

  it("refuses an empty place instead of uploading nothing", async () => {
    const { client, http } = clientWith();
    await expect(
      client.publishPlace({ versionType: "Saved", contents: new Uint8Array(), format: "xml" }),
    ).rejects.toThrowError(/empty \(0 bytes\)/);
    expect(http.requests).toHaveLength(0);
  });

  it("refuses uploads over the configured size limit before spending bandwidth", async () => {
    const { client, http } = clientWith({ maxUploadBytes: 8 });
    await expect(
      client.publishPlace({ versionType: "Saved", contents: new Uint8Array(9), format: "binary" }),
    ).rejects.toThrowError(/ROBLOX_MCP_MAX_PLACE_UPLOAD_BYTES/);
    expect(http.requests).toHaveLength(0);
  });

  it("still reports success when Roblox omits a version number", async () => {
    const { client, http } = clientWith();
    http.setFallback({ status: 200, text: "" });
    const outcome = await client.publishPlace({ versionType: "Saved", contents: xmlPlace(), format: "xml" });
    expect(outcome.versionNumber).toBeNull();
  });
});

describe("cloud v2 endpoints", () => {
  it("reads a universe", async () => {
    const { client, http } = clientWith();
    http.setFallback({ status: 200, text: JSON.stringify({ path: "universes/111", displayName: "My Game" }) });
    expect(await client.getUniverse()).toMatchObject({ displayName: "My Game" });
    expect(http.only()).toMatchObject({ method: "GET", url: `${CLOUD_V2_BASE}/universes/111` });
  });

  it("reads a place", async () => {
    const { client, http } = clientWith();
    await client.getPlace();
    expect(http.only()).toMatchObject({ method: "GET", url: `${CLOUD_V2_BASE}/universes/111/places/222` });
  });

  it("patches only the supplied fields and builds a matching updateMask", async () => {
    const { client, http } = clientWith();
    const result = await client.updatePlace({ displayName: "New name", serverSize: 24 });

    const request = http.only();
    expect(request.method).toBe("PATCH");
    expect(request.url).toBe(
      `${CLOUD_V2_BASE}/universes/111/places/222?updateMask=${encodeURIComponent("displayName,serverSize")}`,
    );
    expect(request.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(request.body as string)).toEqual({ displayName: "New name", serverSize: 24 });
    expect(result.updateMask).toEqual(["displayName", "serverSize"]);
  });

  it("refuses an update with no fields rather than sending an empty mask", async () => {
    const { client, http } = clientWith();
    await expect(client.updatePlace({})).rejects.toThrowError(/at least one of displayName, description/);
    expect(http.requests).toHaveLength(0);
  });

  it("restarts servers with the custom-method endpoint", async () => {
    const { client, http } = clientWith();
    const result = await client.restartServers();
    expect(http.only()).toMatchObject({
      method: "POST",
      url: `${CLOUD_V2_BASE}/universes/111:restartServers`,
      body: "{}",
    });
    expect(result.universeId).toBe(111);
  });

  it("publishes a MessagingService message with topic and payload", async () => {
    const { client, http } = clientWith();
    const result = await client.publishMessage({ topic: "liveops", message: '{"event":"start"}' });
    const request = http.only();
    expect(request.url).toBe(`${CLOUD_V2_BASE}/universes/111:publishMessage`);
    expect(JSON.parse(request.body as string)).toEqual({ topic: "liveops", message: '{"event":"start"}' });
    expect(result).toMatchObject({ universeId: 111, topic: "liveops", bytes: 17 });
  });
});

describe("error mapping", () => {
  const cases: Array<{ status: number; expect: RegExp }> = [
    { status: 400, expect: /Content-Type does not match/ },
    { status: 401, expect: /API key was rejected/ },
    { status: 403, expect: /IP allowlist/ },
    { status: 404, expect: /Verify the universeId/ },
    { status: 409, expect: /being modified by another operation/ },
    { status: 500, expect: /server-side error/ },
  ];

  for (const testCase of cases) {
    it(`explains HTTP ${testCase.status} with the fix`, async () => {
      const { client, http } = clientWith();
      http.setFallback({ status: testCase.status, text: "denied" });
      const error = await client.getUniverse().catch((err: unknown) => err);
      expect(error).toBeInstanceOf(OpenCloudRequestError);
      expect((error as OpenCloudRequestError).status).toBe(testCase.status);
      expect((error as Error).message).toMatch(testCase.expect);
      expect((error as Error).message).toContain("Roblox said: denied");
    });
  }

  it("names the exact missing permission on 403", async () => {
    const { client, http } = clientWith();
    http.setFallback({ status: 403, text: "" });
    await expect(client.restartServers()).rejects.toThrowError(/"universe:write" permission/);
    http.reset();
    await expect(
      client.publishPlace({ versionType: "Saved", contents: xmlPlace(), format: "xml" }),
    ).rejects.toThrowError(/universe-places:write/);
  });

  it("surfaces the Retry-After value on 429 and warns against retry loops", async () => {
    const { client, http } = clientWith();
    http.setFallback({ status: 429, headers: { "retry-after": "42" }, text: "" });
    await expect(client.getUniverse()).rejects.toThrowError(/Retry after 42 seconds.*do not retry in a loop/s);
  });

  it("reports transport failures as such, mentioning the required host", async () => {
    const http = new FakeCloudHttpClient();
    http.throwOnSend = new Error("getaddrinfo ENOTFOUND apis.roblox.com");
    const client = makeCloudClient({ config: { allowPublish: true, apiKey: KEY, defaultUniverseId: 1 }, http });
    const error = await client.getUniverse().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OpenCloudTransportError);
    expect((error as Error).message).toMatch(/failed before reaching Roblox/);
  });

  it("never leaks the API key through an error body", async () => {
    const { client, http } = clientWith();
    http.setFallback({ status: 400, text: `key ${KEY} is bad` });
    const error = await client.getUniverse().catch((err: unknown) => err);
    expect((error as Error).message).not.toContain(KEY);
    expect((error as Error).message).toContain("[redacted-api-key]");
  });

  it("truncates very long Roblox error bodies", async () => {
    const { client, http } = clientWith();
    http.setFallback({ status: 400, text: "x".repeat(5_000) });
    const error = (await client.getUniverse().catch((err: unknown) => err)) as OpenCloudRequestError;
    expect(error.body).toHaveLength(2_000);
  });
});

describe("redaction and status helpers", () => {
  it("replaces every occurrence of the key", () => {
    expect(redact(`a ${KEY} b ${KEY}`, KEY)).toBe("a [redacted-api-key] b [redacted-api-key]");
  });

  it("is a no-op without a key", () => {
    expect(redact("nothing to hide", "")).toBe("nothing to hide");
  });

  it("falls back to a generic explanation for unexpected statuses", () => {
    expect(explainStatus({ status: 418, headers: {}, text: "" }, "universe:read")).toMatch(/response body below/);
  });
});
