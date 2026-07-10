import { randomUUID } from "node:crypto";
import {
  BridgeCommand,
  BridgeResult,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  CommandName,
} from "@roblox-studio-mcp/shared";
import { createLogger } from "../logger.js";

const log = createLogger("queue");

export class CommandTimeoutError extends Error {
  constructor(command: BridgeCommand) {
    super(
      `Command ${command.name} (${command.id}) timed out after ${command.timeoutMs}ms. ` +
        `Make sure Roblox Studio is open, the MCP plugin is connected, and the operation is not blocked by a modal dialog.`,
    );
    this.name = "CommandTimeoutError";
  }
}

export class StudioCommandError extends Error {
  readonly stack2: string | undefined;
  constructor(message: string, stack?: string) {
    super(message);
    this.name = "StudioCommandError";
    this.stack2 = stack;
  }
}

interface PendingCommand {
  command: BridgeCommand;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  /** True once the command has been handed to the plugin via /plugin/poll. */
  delivered: boolean;
}

/**
 * FIFO command queue bridging async MCP tool calls to the long-polling plugin.
 *
 * - `dispatch` enqueues a command and returns a promise resolved by the
 *   plugin's /plugin/result post (or rejected on timeout).
 * - `takeNext` hands the oldest undelivered command to a waiting poll.
 * - Commands time out from the moment they are enqueued, so a disconnected
 *   plugin cannot strand tool calls forever.
 */
export class CommandQueue {
  private readonly pending = new Map<string, PendingCommand>();
  private readonly order: string[] = [];
  private pollWaiter: ((command: BridgeCommand | null) => void) | null = null;
  private pollWaiterTimer: NodeJS.Timeout | null = null;

  dispatch(name: CommandName, payload: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const effectiveTimeout = Math.min(
      Math.max(timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, 1_000),
      MAX_COMMAND_TIMEOUT_MS,
    );
    const command: BridgeCommand = {
      id: randomUUID(),
      name,
      payload,
      timeoutMs: effectiveTimeout,
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        const index = this.order.indexOf(command.id);
        if (index !== -1) this.order.splice(index, 1);
        reject(new CommandTimeoutError(command));
      }, effectiveTimeout);
      timer.unref?.();

      this.pending.set(command.id, { command, resolve, reject, timer, delivered: false });
      this.order.push(command.id);
      log.debug(`Enqueued ${command.name}`, { id: command.id });
      this.flushToWaiter();
    });
  }

  /**
   * Called by the /plugin/poll handler. Resolves immediately when a command is
   * waiting, otherwise parks the poll until `holdMs` elapses (null) or a
   * command arrives.
   */
  takeNext(holdMs: number): Promise<BridgeCommand | null> {
    const immediate = this.nextUndelivered();
    if (immediate) {
      immediate.delivered = true;
      return Promise.resolve(immediate.command);
    }

    // Only one parked poll at a time; release any previous poll with "no work".
    this.releaseWaiter(null);

    return new Promise<BridgeCommand | null>((resolve) => {
      this.pollWaiter = resolve;
      this.pollWaiterTimer = setTimeout(() => this.releaseWaiter(null), holdMs);
      this.pollWaiterTimer.unref?.();
    });
  }

  /** Called by the /plugin/result handler. Returns false for unknown ids. */
  complete(result: BridgeResult): boolean {
    const entry = this.pending.get(result.id);
    if (!entry) {
      log.warn(`Result for unknown or timed-out command`, { id: result.id });
      return false;
    }
    clearTimeout(entry.timer);
    this.pending.delete(result.id);
    const index = this.order.indexOf(result.id);
    if (index !== -1) this.order.splice(index, 1);

    if (result.ok) {
      entry.resolve(result.result);
    } else {
      const message = result.error?.message ?? "Unknown Studio error";
      entry.reject(new StudioCommandError(message, result.error?.stack));
    }
    return true;
  }

  /** Number of commands waiting for delivery or completion. */
  get size(): number {
    return this.pending.size;
  }

  /** Reject everything (used on shutdown). */
  rejectAll(reason: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
    this.order.length = 0;
    this.releaseWaiter(null);
  }

  private nextUndelivered(): PendingCommand | null {
    for (const id of this.order) {
      const entry = this.pending.get(id);
      if (entry && !entry.delivered) return entry;
    }
    return null;
  }

  private flushToWaiter(): void {
    if (!this.pollWaiter) return;
    const entry = this.nextUndelivered();
    if (!entry) return;
    entry.delivered = true;
    this.releaseWaiter(entry.command);
  }

  private releaseWaiter(command: BridgeCommand | null): void {
    if (this.pollWaiterTimer) {
      clearTimeout(this.pollWaiterTimer);
      this.pollWaiterTimer = null;
    }
    const waiter = this.pollWaiter;
    this.pollWaiter = null;
    waiter?.(command);
  }
}
