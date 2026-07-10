import { describe, expect, it } from "vitest";
import { CommandQueue, CommandTimeoutError, StudioCommandError } from "../server/src/bridge/command-queue.js";
import { BridgeCommand } from "@roblox-studio-mcp/shared";

describe("CommandQueue", () => {
  it("delivers commands FIFO and resolves with plugin results", async () => {
    const queue = new CommandQueue();

    const first = queue.dispatch("Ping", { n: 1 });
    const second = queue.dispatch("Ping", { n: 2 });

    const delivered1 = (await queue.takeNext(1000)) as BridgeCommand;
    const delivered2 = (await queue.takeNext(1000)) as BridgeCommand;
    expect(delivered1.payload).toEqual({ n: 1 });
    expect(delivered2.payload).toEqual({ n: 2 });

    expect(queue.complete({ id: delivered2.id, ok: true, result: { pong: 2 } })).toBe(true);
    expect(queue.complete({ id: delivered1.id, ok: true, result: { pong: 1 } })).toBe(true);

    await expect(first).resolves.toEqual({ pong: 1 });
    await expect(second).resolves.toEqual({ pong: 2 });
    expect(queue.size).toBe(0);
  });

  it("parks a poll until a command arrives", async () => {
    const queue = new CommandQueue();
    const pollPromise = queue.takeNext(5000);

    // Enqueue after the poll is already waiting.
    const resultPromise = queue.dispatch("GetSelection", {});
    const delivered = (await pollPromise) as BridgeCommand;
    expect(delivered.name).toBe("GetSelection");

    queue.complete({ id: delivered.id, ok: true, result: { paths: [] } });
    await expect(resultPromise).resolves.toEqual({ paths: [] });
  });

  it("returns null when the hold window expires with no work", async () => {
    const queue = new CommandQueue();
    const start = Date.now();
    const command = await queue.takeNext(100);
    expect(command).toBeNull();
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
  });

  it("rejects with CommandTimeoutError when the plugin never responds", async () => {
    const queue = new CommandQueue();
    const promise = queue.dispatch("Ping", {}, 1000);
    // Deliver but never complete.
    await queue.takeNext(100);
    await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
    expect(queue.size).toBe(0);
  });

  it("rejects with StudioCommandError carrying the Luau stack", async () => {
    const queue = new CommandQueue();
    const promise = queue.dispatch("RunLuau", { code: "error('boom')" });
    const delivered = (await queue.takeNext(1000)) as BridgeCommand;
    queue.complete({
      id: delivered.id,
      ok: false,
      error: { message: "boom", stack: "stacktrace here" },
    });
    await expect(promise).rejects.toMatchObject({ message: "boom", stack2: "stacktrace here" });
    await promise.catch((err) => expect(err).toBeInstanceOf(StudioCommandError));
  });

  it("ignores results for unknown command ids", () => {
    const queue = new CommandQueue();
    expect(queue.complete({ id: "nope", ok: true })).toBe(false);
  });

  it("rejects everything on shutdown", async () => {
    const queue = new CommandQueue();
    const p1 = queue.dispatch("Ping", {});
    const p2 = queue.dispatch("Ping", {});
    queue.rejectAll("shutdown");
    await expect(p1).rejects.toThrow("shutdown");
    await expect(p2).rejects.toThrow("shutdown");
  });
});
