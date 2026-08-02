/**
 * In-memory doubles for the native layer's two ports (process runner and file
 * system). They let the Windows/macOS/Linux backends be exercised - and their
 * exact command lines asserted - from any host, including CI on Linux.
 */
import { CommandRunner, HostFileSystem, RunOptions, RunResult } from "../../server/src/native/types.js";

export interface FakeCall {
  program: string;
  args: string[];
  options?: RunOptions;
}

export type RunHandler = (call: FakeCall) => Partial<RunResult> | undefined;

const complete = (partial: Partial<RunResult>): RunResult => ({
  code: partial.code ?? 0,
  stdout: partial.stdout ?? "",
  stderr: partial.stderr ?? "",
  missing: partial.missing ?? false,
  timedOut: partial.timedOut ?? false,
});

export class FakeCommandRunner implements CommandRunner {
  readonly calls: FakeCall[] = [];
  readonly spawns: FakeCall[] = [];
  /** Programs that `which` should resolve. */
  available: string[] = [];
  /** Pid returned by spawnDetached. */
  spawnPid: number | undefined = 4242;
  /** Called after every spawnDetached (used to simulate Studio booting). */
  onSpawn?: (call: FakeCall) => void | Promise<void>;
  /**
   * When true (the default), running a program that is not in `available` and
   * has no explicit handler reports `missing`, exactly like execFile's ENOENT.
   * This keeps the fake honest about which tools a host actually has.
   */
  strictAvailability = true;

  private readonly handlers: RunHandler[] = [];
  private fallback: Partial<RunResult> = { code: 0, stdout: "" };

  /** Register a response for matching calls; first match wins. */
  onRun(handler: RunHandler): this {
    this.handlers.push(handler);
    return this;
  }

  /** Register a response that takes precedence over already-registered ones. */
  onRunFirst(handler: RunHandler): this {
    this.handlers.unshift(handler);
    return this;
  }

  /** Response for calls no handler matched. */
  setFallback(result: Partial<RunResult>): this {
    this.fallback = result;
    return this;
  }

  async run(program: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    const call: FakeCall = { program, args, options };
    this.calls.push(call);
    for (const handler of this.handlers) {
      const result = handler(call);
      if (result) return complete(result);
    }
    if (this.strictAvailability && !this.available.includes(program)) {
      return complete({ code: null, missing: true, stderr: `${program}: command not found` });
    }
    return complete(this.fallback);
  }

  async spawnDetached(program: string, args: string[], options: RunOptions = {}): Promise<number | undefined> {
    const call: FakeCall = { program, args, options };
    this.spawns.push(call);
    await this.onSpawn?.(call);
    return this.spawnPid;
  }

  async which(program: string): Promise<boolean> {
    return this.available.includes(program);
  }

  /** Calls whose program matches, for assertions. */
  callsTo(program: string): FakeCall[] {
    return this.calls.filter((call) => call.program === program);
  }

  /** The mode a PowerShell toolkit invocation ran (from its injected env). */
  modes(): string[] {
    return this.calls.map((call) => call.options?.env?.MCP_MODE).filter((mode): mode is string => Boolean(mode));
  }

  reset(): void {
    this.calls.length = 0;
    this.spawns.length = 0;
  }
}

export class FakeFileSystem implements HostFileSystem {
  readonly files = new Map<string, { content: Buffer; modifiedAt: number }>();
  readonly directories = new Set<string>();
  readonly written: string[] = [];

  /**
   * Keys are stored with "/" separators so the same fake works whether the code
   * under test built its paths with node:path on Windows or POSIX.
   */
  private key(path: string): string {
    return path.replace(/\\/g, "/");
  }

  addFile(path: string, content = "", modifiedAt = 1_000): this {
    const key = this.key(path);
    this.files.set(key, { content: Buffer.from(content), modifiedAt });
    let parent = key.slice(0, key.lastIndexOf("/"));
    while (parent.length > 1) {
      this.directories.add(parent);
      parent = parent.slice(0, parent.lastIndexOf("/"));
    }
    return this;
  }

  addDirectory(path: string): this {
    this.directories.add(this.key(path));
    return this;
  }

  exists(path: string): boolean {
    const key = this.key(path);
    return this.files.has(key) || this.directories.has(key);
  }

  readDir(path: string): string[] {
    const key = this.key(path);
    const prefix = key.endsWith("/") ? key : `${key}/`;
    const entries = new Set<string>();
    for (const candidate of [...this.files.keys(), ...this.directories]) {
      if (!candidate.startsWith(prefix)) continue;
      const rest = candidate.slice(prefix.length);
      if (rest.length === 0) continue;
      entries.add(rest.split("/")[0]);
    }
    return [...entries];
  }

  isDirectory(path: string): boolean {
    return this.directories.has(this.key(path));
  }

  modifiedAt(path: string): number {
    return this.files.get(this.key(path))?.modifiedAt ?? 0;
  }

  size(path: string): number {
    return this.files.get(this.key(path))?.content.length ?? 0;
  }

  mkdirp(path: string): void {
    this.directories.add(this.key(path));
  }

  readFile(path: string): Buffer {
    const file = this.files.get(this.key(path));
    if (!file) throw new Error(`ENOENT: ${path}`);
    return file.content;
  }

  readHead(path: string, maxBytes: number): Buffer {
    return this.readFile(path).subarray(0, maxBytes);
  }

  writeFile(path: string, contents: string): void {
    this.written.push(this.key(path));
    this.addFile(path, contents, Date.now());
  }
}
