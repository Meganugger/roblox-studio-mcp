/**
 * Live verification of the real Open Cloud transport.
 *
 * Every other cloud test injects a fake transport to assert what *would* be
 * sent; this one drives the actual `NodeCloudHttpClient` over real TCP against a
 * local HTTP server, so the parts that only exist at runtime are proven:
 * headers really arriving, a binary place body surviving byte-for-byte, response
 * header/status parsing, timeouts, and unreachable hosts.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCloudHttpClient } from "../server/src/cloud/http.js";
import { OpenCloudTransportError } from "../server/src/cloud/types.js";

interface Received {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

describe("NodeCloudHttpClient against a real HTTP server", () => {
  let server: Server;
  let baseUrl = "";
  let received: Received[] = [];
  let respond: (request: IncomingMessage, response: ServerResponse) => void;

  beforeEach(async () => {
    received = [];
    respond = (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"versionNumber":99}');
    };

    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          method: request.method ?? "",
          url: request.url ?? "",
          headers: request.headers,
          body: Buffer.concat(chunks),
        });
        respond(request, response);
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    // Resolve regardless of the callback's error argument: one test closes the
    // server itself to test an unreachable host.
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const client = new NodeCloudHttpClient();

  it("sends the method, query string, headers and a byte-exact binary body", async () => {
    // A byte range that would be corrupted by any accidental text encoding.
    const place = new Uint8Array([0x3c, 0x72, 0x6f, 0x62, 0x6c, 0x6f, 0x78, 0x21, 0x00, 0x89, 0xff, 0xfe, 0x0d, 0x0a]);

    const response = await client.send({
      method: "POST",
      url: `${baseUrl}/universes/1/places/2/versions?versionType=Published`,
      headers: {
        "x-api-key": "live-transport-key",
        "content-type": "application/octet-stream",
        accept: "application/json",
        "user-agent": "roblox-studio-mcp",
      },
      body: place,
      timeoutMs: 5_000,
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual({ versionNumber: 99 });

    const request = received[0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/universes/1/places/2/versions?versionType=Published");
    expect(request.headers["x-api-key"]).toBe("live-transport-key");
    expect(request.headers["content-type"]).toBe("application/octet-stream");
    expect(request.headers.accept).toBe("application/json");
    expect(request.headers["user-agent"]).toBe("roblox-studio-mcp");
    expect(request.body).toEqual(Buffer.from(place));
    expect(request.headers["content-length"]).toBe(String(place.byteLength));
  });

  it("sends a JSON string body unchanged", async () => {
    await client.send({
      method: "PATCH",
      url: `${baseUrl}/places/2`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Ünicode ✓", serverSize: 12 }),
      timeoutMs: 5_000,
    });
    expect(JSON.parse(received[0].body.toString("utf8"))).toEqual({
      displayName: "Ünicode ✓",
      serverSize: 12,
    });
  });

  it("exposes non-success statuses and lower-cased response headers", async () => {
    respond = (_request, response) => {
      response.writeHead(429, { "Retry-After": "30", "X-Weird-Case": "Yes" });
      response.end("Too many requests");
    };

    const response = await client.send({
      method: "GET",
      url: `${baseUrl}/universes/1`,
      headers: {},
      timeoutMs: 5_000,
    });

    // Non-2xx is returned, not thrown: the client maps it to a fix hint.
    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("30");
    expect(response.headers["x-weird-case"]).toBe("Yes");
    expect(response.text).toBe("Too many requests");
  });

  it("handles an empty response body", async () => {
    respond = (_request, response) => {
      response.writeHead(200);
      response.end();
    };
    const response = await client.send({
      method: "POST",
      url: `${baseUrl}/universes/1:restartServers`,
      headers: {},
      body: "{}",
      timeoutMs: 5_000,
    });
    expect(response.text).toBe("");
  });

  it("times out slow responses as a transport error", async () => {
    respond = () => {
      // Never respond: the abort signal must fire.
    };
    const error = await client
      .send({ method: "GET", url: `${baseUrl}/hang`, headers: {}, timeoutMs: 250 })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OpenCloudTransportError);
    expect((error as Error).message).toContain("apis.roblox.com");
  });

  it("reports an unreachable host as a transport error", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const error = await client
      .send({ method: "GET", url: `${baseUrl}/universes/1`, headers: {}, timeoutMs: 2_000 })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OpenCloudTransportError);
    expect((error as Error).message).toMatch(/Could not reach the Roblox Open Cloud API/);
  });
});
