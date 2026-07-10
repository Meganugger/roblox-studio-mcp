import {
  PeerContext,
  PeerInfo,
  PluginHello,
  PLUGIN_TIMEOUT_MS,
  SESSION_PRUNE_MS,
} from "@roblox-studio-mcp/shared";
import { CommandQueue } from "./command-queue.js";
import { createLogger } from "../logger.js";

const log = createLogger("sessions");

/** One connected Studio DataModel (edit, play server, or play client). */
export interface PeerSession {
  hello: PluginHello;
  lastSeenAt: number;
  queue: CommandQueue;
}

export class UnknownPeerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownPeerError";
  }
}

/**
 * Registry of connected plugin peers, keyed by the plugin-generated sessionId.
 *
 * Every peer owns an independent CommandQueue, so commands to the edit
 * session, the playtest server, and each playtest client are routed and
 * long-polled independently. Stale sessions (e.g. a closed playtest) are
 * pruned lazily.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, PeerSession>();

  /** Register or refresh a peer from its hello handshake. */
  upsert(hello: PluginHello): PeerSession {
    this.prune();
    let session = this.sessions.get(hello.sessionId);
    if (!session) {
      session = { hello, lastSeenAt: Date.now(), queue: new CommandQueue() };
      this.sessions.set(hello.sessionId, session);
      log.info(
        `Peer connected: ${hello.context} "${hello.placeName}" (session=${hello.sessionId.slice(0, 8)}, plugin v${hello.pluginVersion})`,
      );
    } else {
      session.hello = hello;
      session.lastSeenAt = Date.now();
    }
    return session;
  }

  /** Mark a session as alive (called on every poll/result). */
  touch(sessionId: string): PeerSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) session.lastSeenAt = Date.now();
    return session;
  }

  get(sessionId: string): PeerSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Resolve a peer selector to a live session.
   * Selectors: "edit" | "server" | "client" | an explicit sessionId.
   * When several client peers are connected, "client" is ambiguous and the
   * error lists each candidate so the caller can pick a sessionId.
   */
  resolve(selector: string): PeerSession {
    this.prune();
    const bySessionId = this.sessions.get(selector);
    if (bySessionId) {
      if (!this.isConnected(bySessionId)) {
        throw new UnknownPeerError(
          `Peer session ${selector} is no longer connected (last seen ${Math.round((Date.now() - bySessionId.lastSeenAt) / 1000)}s ago).`,
        );
      }
      return bySessionId;
    }

    if (selector === "edit" || selector === "server" || selector === "client") {
      const matches = this.connected().filter((s) => s.hello.context === selector);
      if (matches.length === 1) return matches[0];
      if (matches.length === 0) {
        throw new UnknownPeerError(
          selector === "edit"
            ? "No edit-mode Studio session is connected. Open Roblox Studio with the MCP plugin enabled."
            : `No ${selector} peer is connected. Start a playtest first (in play-solo / multiplayer test mode the ` +
              `plugin auto-connects from each DataModel); then call get_connected_peers.`,
        );
      }
      throw new UnknownPeerError(
        `Multiple ${selector} peers are connected; pass an explicit sessionId. Candidates: ` +
          matches
            .map((s) => `${s.hello.sessionId} (${s.hello.userName ?? s.hello.placeName})`)
            .join(", "),
      );
    }

    throw new UnknownPeerError(
      `Unknown peer selector "${selector}". Use "edit", "server", "client" or a sessionId from get_connected_peers.`,
    );
  }

  /** All live (recently seen) sessions. */
  connected(): PeerSession[] {
    this.prune();
    return [...this.sessions.values()].filter((s) => this.isConnected(s));
  }

  /** Public listing for the get_connected_peers tool. */
  list(): PeerInfo[] {
    this.prune();
    const order: Record<PeerContext, number> = { edit: 0, server: 1, client: 2 };
    return [...this.sessions.values()]
      .sort((a, b) => order[a.hello.context] - order[b.hello.context] || a.lastSeenAt - b.lastSeenAt)
      .map((s) => ({
        sessionId: s.hello.sessionId,
        context: s.hello.context,
        connected: this.isConnected(s),
        lastSeenAt: s.lastSeenAt,
        placeName: s.hello.placeName,
        placeId: s.hello.placeId,
        pluginVersion: s.hello.pluginVersion,
        userName: s.hello.userName,
        userId: s.hello.userId,
      }));
  }

  /** The edit session, when connected (used for default routing / status). */
  editSession(): PeerSession | undefined {
    return this.connected().find((s) => s.hello.context === "edit");
  }

  rejectAll(reason: string): void {
    for (const session of this.sessions.values()) {
      session.queue.rejectAll(reason);
    }
    this.sessions.clear();
  }

  private isConnected(session: PeerSession): boolean {
    return Date.now() - session.lastSeenAt < PLUGIN_TIMEOUT_MS;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeenAt > SESSION_PRUNE_MS) {
        session.queue.rejectAll("Peer session pruned (disconnected too long)");
        this.sessions.delete(id);
        log.info(`Pruned stale peer session ${id.slice(0, 8)} (${session.hello.context})`);
      }
    }
  }
}
