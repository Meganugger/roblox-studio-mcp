import { createHash } from "node:crypto";
import { NodeCloudHttpClient } from "./http.js";
import {
  CloudHttpClient,
  CloudHttpMethod,
  CloudResponse,
  OpenCloudRequestError,
  OpenCloudTransportError,
  OpenCloudUnavailableError,
} from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger("cloud");

/** Legacy-versioned host for the place-publishing endpoint (the only v1 API left). */
export const PUBLISH_BASE = "https://apis.roblox.com/universes/v1";
/** Open Cloud v2 base, used for everything else. */
export const CLOUD_V2_BASE = "https://apis.roblox.com/cloud/v2";

const DEFAULT_TIMEOUT_MS = 60_000;
/** Uploading a place is the one call that can legitimately take minutes. */
const UPLOAD_TIMEOUT_MS = 300_000;

/** Where the API key came from, so the user can tell which credential is live. */
export type ApiKeySource = "env" | "file";

export interface OpenCloudConfig {
  /** Master gate. Off by default: publishing changes what real players see. */
  allowPublish: boolean;
  apiKey?: string;
  apiKeySource?: ApiKeySource;
  /** Path that was checked for a key file (reported even when absent). */
  apiKeyPath?: string;
  defaultUniverseId?: number;
  defaultPlaceId?: number;
  /** When non-empty, only these universes may be touched. */
  allowedUniverseIds: number[];
  maxUploadBytes: number;
}

export interface OpenCloudClientOptions {
  config: OpenCloudConfig;
  http?: CloudHttpClient;
}

/** Which Open Cloud API-key permission each tool needs. */
export const REQUIRED_SCOPES = {
  publishPlace: "Place Publishing API -> write (universe-places:write)",
  readUniverse: "universe:read",
  readPlace: "universe.place:read",
  writePlace: "universe.place:write",
  restartServers: "universe:write",
  publishMessage: "universe-messaging-service:publish",
} as const;

export type PlaceUploadFormat = "xml" | "binary";

export interface PublishOutcome {
  universeId: number;
  placeId: number;
  versionType: "Saved" | "Published";
  versionNumber: number | null;
  bytes: number;
  format: PlaceUploadFormat;
  contentType: string;
  /** Raw response text, kept for the rare case Roblox changes the shape. */
  response: unknown;
}

export interface CloudStatus {
  gates: { publishing: boolean };
  apiKey: { configured: boolean; source: ApiKeySource | null; fingerprint: string | null; path: string | null };
  defaults: { universeId: number | null; placeId: number | null };
  allowedUniverseIds: number[];
  maxUploadBytes: number;
  requiredScopes: typeof REQUIRED_SCOPES;
  endpoints: { publish: string; cloudV2: string };
  notes: string[];
}

/**
 * Facade over the Roblox Open Cloud API.
 *
 * Holds everything that must behave identically for every endpoint: the
 * publishing gate, API-key resolution and redaction, the universe allowlist,
 * upload validation, and HTTP error messages that name the exact fix (wrong
 * key, missing permission, IP not allowlisted, rate limit) instead of leaking a
 * raw status code to the agent.
 *
 * The API key never appears in a return value, a log line or an error message:
 * only a short SHA-256 fingerprint is ever exposed, and every outgoing string
 * is scrubbed as a defence in depth.
 */
export class OpenCloudClient {
  private readonly config: OpenCloudConfig;
  private readonly http: CloudHttpClient;

  constructor(options: OpenCloudClientOptions) {
    this.config = options.config;
    this.http = options.http ?? new NodeCloudHttpClient();
  }

  /** Configuration report. Never throws, so the agent can always orient itself. */
  status(): CloudStatus {
    const notes: string[] = [];
    if (!this.config.allowPublish) {
      notes.push(
        "Publishing is disabled (ROBLOX_MCP_ALLOW_PUBLISH is not set to 1). This gate is off by default because " +
          "publishing changes what real players see. Set ROBLOX_MCP_ALLOW_PUBLISH=1 and restart the server to " +
          "enable the publish tools.",
      );
    }
    if (!this.config.apiKey) {
      notes.push(
        "No Open Cloud API key is configured. Create one at https://create.roblox.com/dashboard/credentials, " +
          "then either set ROBLOX_MCP_OPEN_CLOUD_KEY or write the key to " +
          `${this.config.apiKeyPath ?? "~/.roblox-studio-mcp/open-cloud-key"} (chmod 600). ` +
          "The key is never printed back by this server.",
      );
    }
    if (this.config.defaultUniverseId === undefined) {
      notes.push(
        "No default universe is configured (ROBLOX_MCP_UNIVERSE_ID). Pass universeId explicitly, or set it so " +
          "the publish tools can be called without arguments. The universeId is on the experience's page in the " +
          "Creator Dashboard (Settings -> Basic Information), not the placeId.",
      );
    }
    if (this.config.allowedUniverseIds.length === 0) {
      notes.push(
        "No universe allowlist is set (ROBLOX_MCP_ALLOWED_UNIVERSES), so any universe your API key can reach may " +
          "be modified. Set it to a comma-separated list of universe ids to limit the blast radius.",
      );
    }
    return {
      gates: { publishing: this.config.allowPublish },
      apiKey: {
        configured: Boolean(this.config.apiKey),
        source: this.config.apiKeySource ?? null,
        fingerprint: this.config.apiKey ? fingerprint(this.config.apiKey) : null,
        path: this.config.apiKeyPath ?? null,
      },
      defaults: {
        universeId: this.config.defaultUniverseId ?? null,
        placeId: this.config.defaultPlaceId ?? null,
      },
      allowedUniverseIds: [...this.config.allowedUniverseIds],
      maxUploadBytes: this.config.maxUploadBytes,
      requiredScopes: REQUIRED_SCOPES,
      endpoints: { publish: PUBLISH_BASE, cloudV2: CLOUD_V2_BASE },
      notes,
    };
  }

  /**
   * Resolve the universe to act on: the explicit argument, else the configured
   * default. Enforces the allowlist, which is the server's blast-radius control.
   */
  resolveUniverseId(explicit?: number): number {
    const universeId = explicit ?? this.config.defaultUniverseId;
    if (universeId === undefined) {
      throw new OpenCloudUnavailableError(
        "No universeId was given and no default is configured. Pass universeId, or set ROBLOX_MCP_UNIVERSE_ID. " +
          "Find it in the Creator Dashboard under the experience's Settings (it differs from the placeId).",
      );
    }
    const allowed = this.config.allowedUniverseIds;
    if (allowed.length > 0 && !allowed.includes(universeId)) {
      throw new OpenCloudUnavailableError(
        `Universe ${universeId} is not in the allowlist (ROBLOX_MCP_ALLOWED_UNIVERSES=${allowed.join(",")}). ` +
          "Add it there to allow this server to modify that experience.",
      );
    }
    return universeId;
  }

  resolvePlaceId(explicit?: number): number {
    const placeId = explicit ?? this.config.defaultPlaceId;
    if (placeId === undefined) {
      throw new OpenCloudUnavailableError(
        "No placeId was given and no default is configured. Pass placeId, or set ROBLOX_MCP_PLACE_ID. The " +
          "placeId is the number in the experience's URL (roblox.com/games/<placeId>/...).",
      );
    }
    return placeId;
  }

  /**
   * Upload a place file as a new version.
   *
   * `versionType: "Saved"` stores the version without releasing it; "Published"
   * makes it the live version for new servers. Saved is the default everywhere
   * so that the obvious call cannot surprise a live audience.
   */
  async publishPlace(options: {
    universeId?: number;
    placeId?: number;
    versionType: "Saved" | "Published";
    contents: Uint8Array;
    format: PlaceUploadFormat;
  }): Promise<PublishOutcome> {
    const universeId = this.resolveUniverseId(options.universeId);
    const placeId = this.resolvePlaceId(options.placeId);
    const bytes = options.contents.byteLength;
    if (bytes === 0) {
      throw new OpenCloudUnavailableError("The place file is empty (0 bytes), so there is nothing to publish.");
    }
    if (bytes > this.config.maxUploadBytes) {
      throw new OpenCloudUnavailableError(
        `The place file is ${bytes} bytes, over the ${this.config.maxUploadBytes}-byte upload limit. Raise ` +
          "ROBLOX_MCP_MAX_PLACE_UPLOAD_BYTES if this file is genuinely that large.",
      );
    }

    const contentType = options.format === "xml" ? "application/xml" : "application/octet-stream";
    const response = await this.request({
      method: "POST",
      url: `${PUBLISH_BASE}/${universeId}/places/${placeId}/versions?versionType=${options.versionType}`,
      contentType,
      body: options.contents,
      timeoutMs: UPLOAD_TIMEOUT_MS,
      operation: `Publishing place ${placeId} in universe ${universeId}`,
      scope: REQUIRED_SCOPES.publishPlace,
    });

    const parsed = parseJson(response.text);
    const versionNumber =
      parsed && typeof parsed === "object" && typeof (parsed as { versionNumber?: unknown }).versionNumber === "number"
        ? (parsed as { versionNumber: number }).versionNumber
        : null;
    log.info(
      `Uploaded place ${placeId} (universe ${universeId}) as ${options.versionType} version ` +
        `${versionNumber ?? "?"} (${bytes} bytes, ${contentType})`,
    );
    return {
      universeId,
      placeId,
      versionType: options.versionType,
      versionNumber,
      bytes,
      format: options.format,
      contentType,
      response: parsed ?? response.text,
    };
  }

  async getUniverse(universeId?: number): Promise<unknown> {
    const id = this.resolveUniverseId(universeId);
    const response = await this.request({
      method: "GET",
      url: `${CLOUD_V2_BASE}/universes/${id}`,
      operation: `Reading universe ${id}`,
      scope: REQUIRED_SCOPES.readUniverse,
    });
    return parseJson(response.text) ?? response.text;
  }

  async getPlace(universeId?: number, placeId?: number): Promise<unknown> {
    const universe = this.resolveUniverseId(universeId);
    const place = this.resolvePlaceId(placeId);
    const response = await this.request({
      method: "GET",
      url: `${CLOUD_V2_BASE}/universes/${universe}/places/${place}`,
      operation: `Reading place ${place} in universe ${universe}`,
      scope: REQUIRED_SCOPES.readPlace,
    });
    return parseJson(response.text) ?? response.text;
  }

  /**
   * Patch a place's configuration. Open Cloud v2 requires an explicit
   * `updateMask`, so only the fields the caller actually supplied are sent -
   * omitting it would blank out the others.
   */
  async updatePlace(options: {
    universeId?: number;
    placeId?: number;
    displayName?: string;
    description?: string;
    serverSize?: number;
  }): Promise<{ universeId: number; placeId: number; updateMask: string[]; place: unknown }> {
    const universeId = this.resolveUniverseId(options.universeId);
    const placeId = this.resolvePlaceId(options.placeId);

    const body: Record<string, unknown> = {};
    if (options.displayName !== undefined) body.displayName = options.displayName;
    if (options.description !== undefined) body.description = options.description;
    if (options.serverSize !== undefined) body.serverSize = options.serverSize;
    const updateMask = Object.keys(body);
    if (updateMask.length === 0) {
      throw new OpenCloudUnavailableError(
        "Nothing to update: pass at least one of displayName, description or serverSize.",
      );
    }

    const response = await this.request({
      method: "PATCH",
      url:
        `${CLOUD_V2_BASE}/universes/${universeId}/places/${placeId}` +
        `?updateMask=${encodeURIComponent(updateMask.join(","))}`,
      contentType: "application/json",
      body: JSON.stringify(body),
      operation: `Updating place ${placeId} in universe ${universeId}`,
      scope: REQUIRED_SCOPES.writePlace,
    });
    return { universeId, placeId, updateMask, place: parseJson(response.text) ?? response.text };
  }

  /** Shut down every running server so players rejoin on the published version. */
  async restartServers(universeId?: number): Promise<{ universeId: number; response: unknown }> {
    const id = this.resolveUniverseId(universeId);
    const response = await this.request({
      method: "POST",
      url: `${CLOUD_V2_BASE}/universes/${id}:restartServers`,
      contentType: "application/json",
      body: "{}",
      operation: `Restarting servers for universe ${id}`,
      scope: REQUIRED_SCOPES.restartServers,
    });
    return { universeId: id, response: parseJson(response.text) ?? response.text };
  }

  /** Send a MessagingService message to every running server in the universe. */
  async publishMessage(options: {
    universeId?: number;
    topic: string;
    message: string;
  }): Promise<{ universeId: number; topic: string; bytes: number; response: unknown }> {
    const id = this.resolveUniverseId(options.universeId);
    const response = await this.request({
      method: "POST",
      url: `${CLOUD_V2_BASE}/universes/${id}:publishMessage`,
      contentType: "application/json",
      body: JSON.stringify({ topic: options.topic, message: options.message }),
      operation: `Publishing a message to universe ${id} on topic "${options.topic}"`,
      scope: REQUIRED_SCOPES.publishMessage,
    });
    return {
      universeId: id,
      topic: options.topic,
      bytes: Buffer.byteLength(options.message, "utf8"),
      response: parseJson(response.text) ?? response.text,
    };
  }

  /** Gate + auth check, request dispatch, and status-to-fix-hint mapping. */
  private async request(options: {
    method: CloudHttpMethod;
    url: string;
    contentType?: string;
    body?: string | Uint8Array;
    timeoutMs?: number;
    operation: string;
    scope: string;
  }): Promise<CloudResponse> {
    const apiKey = this.requireKey();
    const headers: Record<string, string> = {
      "x-api-key": apiKey,
      accept: "application/json",
      "user-agent": "roblox-studio-mcp",
    };
    if (options.contentType) headers["content-type"] = options.contentType;

    let response: CloudResponse;
    try {
      response = await this.http.send({
        method: options.method,
        url: options.url,
        headers,
        body: options.body,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    } catch (err) {
      if (err instanceof OpenCloudTransportError) throw err;
      throw new OpenCloudTransportError(
        `${options.operation} failed before reaching Roblox: ${redact(
          String(err instanceof Error ? err.message : err),
          apiKey,
        )}`,
      );
    }

    if (response.status >= 200 && response.status < 300) return response;

    const body = redact(response.text.slice(0, 2_000), apiKey);
    throw new OpenCloudRequestError(
      `${options.operation} failed with HTTP ${response.status}. ${explainStatus(response, options.scope)}` +
        (body ? ` Roblox said: ${body}` : ""),
      response.status,
      body,
    );
  }

  private requireKey(): string {
    if (!this.config.allowPublish) {
      throw new OpenCloudUnavailableError(
        "Publishing to Roblox is disabled on this server (ROBLOX_MCP_ALLOW_PUBLISH is not 1). This gate is off " +
          "by default because these tools change a live experience. Ask the user to set " +
          "ROBLOX_MCP_ALLOW_PUBLISH=1 and restart the server; do not retry until they have.",
      );
    }
    if (!this.config.apiKey) {
      throw new OpenCloudUnavailableError(
        "No Roblox Open Cloud API key is configured. The user must create one at " +
          "https://create.roblox.com/dashboard/credentials (add the experience and the permissions listed by " +
          "get_publish_capabilities), then set ROBLOX_MCP_OPEN_CLOUD_KEY or save it to " +
          `${this.config.apiKeyPath ?? "~/.roblox-studio-mcp/open-cloud-key"} and restart the server.`,
      );
    }
    return this.config.apiKey;
  }
}

/** Short, non-reversible identifier so the user can confirm which key is loaded. */
export function fingerprint(key: string): string {
  return `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

/**
 * Remove the API key from any text that leaves this module. Roblox does not echo
 * the key back, so this is defence in depth against a future endpoint that does.
 */
export function redact(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join("[redacted-api-key]");
}

function parseJson(text: string): unknown {
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Turn an Open Cloud status code into the action that actually fixes it. */
export function explainStatus(response: CloudResponse, scope: string): string {
  switch (response.status) {
    case 400:
      return (
        "Roblox rejected the request as malformed. For a publish, this usually means the file is not a valid " +
        "place, or the Content-Type does not match it (.rbxlx must be sent as XML, .rbxl as binary)."
      );
    case 401:
      return (
        "The API key was rejected. It is missing, mistyped or has been revoked - create a new key at " +
        "https://create.roblox.com/dashboard/credentials and update ROBLOX_MCP_OPEN_CLOUD_KEY."
      );
    case 403:
      return (
        `The API key is valid but not allowed to do this. Add the "${scope}" permission for this experience to ` +
        "the key, and check the key's IP allowlist (Open Cloud keys are restricted by CIDR - 0.0.0.0/0 allows " +
        "any address). The key's owner must also have edit rights on the experience."
      );
    case 404:
      return (
        "Roblox could not find that universe or place. Verify the universeId (Creator Dashboard -> experience -> " +
        "Settings) and the placeId (the number in the game URL), and that both belong to the key's account or group."
      );
    case 409:
      return "The place is being modified by another operation. Wait a moment and try again.";
    case 429: {
      const retryAfter = response.headers["retry-after"];
      return (
        "Open Cloud rate limit reached." +
        (retryAfter ? ` Retry after ${retryAfter} seconds.` : " Wait before retrying.") +
        " Publishing is rate-limited per universe, so do not retry in a loop."
      );
    }
    default:
      if (response.status >= 500) {
        return "Roblox's API had a server-side error. This is not a problem with the request; retry shortly.";
      }
      return "See the response body below for details.";
  }
}
