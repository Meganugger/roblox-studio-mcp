import { CloudHttpClient, CloudRequest, CloudResponse, OpenCloudTransportError } from "./types.js";

/** Real HTTPS transport, built on the platform `fetch`. */
export class NodeCloudHttpClient implements CloudHttpClient {
  async send(request: CloudRequest): Promise<CloudResponse> {
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        // A Uint8Array is a valid fetch body at runtime, but `BodyInit` demands
        // `ArrayBufferView<ArrayBuffer>` while Node's Buffer is typed over
        // `ArrayBufferLike`, so the cast is needed to bridge the two.
        body: request.body as RequestInit["body"],
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new OpenCloudTransportError(
        `Could not reach the Roblox Open Cloud API (${reason}). This server needs outbound HTTPS access to ` +
          "apis.roblox.com.",
      );
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: response.status, headers, text: await response.text() };
  }
}
