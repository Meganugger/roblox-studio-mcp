/**
 * In-memory double for the Open Cloud transport. Records every request so the
 * exact URL, method, headers and body sent to Roblox can be asserted without
 * any network access, and lets a test script arbitrary HTTP responses.
 */
import { CloudHttpClient, CloudRequest, CloudResponse } from "../../server/src/cloud/types.js";

export type CloudHandler = (request: CloudRequest) => Partial<CloudResponse> | undefined;

const complete = (partial: Partial<CloudResponse>): CloudResponse => ({
  status: partial.status ?? 200,
  headers: partial.headers ?? {},
  text: partial.text ?? "",
});

export class FakeCloudHttpClient implements CloudHttpClient {
  readonly requests: CloudRequest[] = [];
  /** Thrown by `send` when set, to simulate DNS/TLS/timeout failures. */
  throwOnSend?: Error;

  private readonly handlers: CloudHandler[] = [];
  private fallback: Partial<CloudResponse> = { status: 200, text: "{}" };

  /** Register a response for matching requests; first match wins. */
  onRequest(handler: CloudHandler): this {
    this.handlers.push(handler);
    return this;
  }

  /** Response for requests no handler matched. */
  setFallback(response: Partial<CloudResponse>): this {
    this.fallback = response;
    return this;
  }

  async send(request: CloudRequest): Promise<CloudResponse> {
    this.requests.push(request);
    if (this.throwOnSend) throw this.throwOnSend;
    for (const handler of this.handlers) {
      const response = handler(request);
      if (response) return complete(response);
    }
    return complete(this.fallback);
  }

  /** The single request made, failing loudly when the count is not exactly one. */
  only(): CloudRequest {
    if (this.requests.length !== 1) {
      throw new Error(`Expected exactly 1 cloud request, got ${this.requests.length}`);
    }
    return this.requests[0];
  }

  last(): CloudRequest {
    const request = this.requests[this.requests.length - 1];
    if (!request) throw new Error("No cloud request was made");
    return request;
  }

  reset(): void {
    this.requests.length = 0;
  }
}
