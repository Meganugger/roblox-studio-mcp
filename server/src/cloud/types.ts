/**
 * Types for the Open Cloud layer (v4 "publishing").
 *
 * This is the only part of the server that talks to Roblox's servers instead of
 * the local machine, so it is deliberately narrow: one injectable transport
 * (`CloudHttpClient`) that every request goes through, which makes each URL,
 * header and body assertable in tests without any network access.
 */

export type CloudHttpMethod = "GET" | "POST" | "PATCH";

export interface CloudRequest {
  method: CloudHttpMethod;
  url: string;
  headers: Record<string, string>;
  /** JSON text or raw place bytes. */
  body?: string | Uint8Array;
  timeoutMs: number;
}

export interface CloudResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/** Injectable HTTPS transport for the Open Cloud API. */
export interface CloudHttpClient {
  send(request: CloudRequest): Promise<CloudResponse>;
}

/**
 * Raised when a cloud operation is impossible with the current configuration
 * (gate off, no API key, no universe id, universe not allowlisted). The message
 * always states the exact setting to change.
 */
export class OpenCloudUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCloudUnavailableError";
  }
}

/** Raised when Roblox answered with a non-success status. */
export class OpenCloudRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "OpenCloudRequestError";
  }
}

/** Raised when the request never reached Roblox (DNS, TLS, timeout). */
export class OpenCloudTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCloudTransportError";
  }
}
