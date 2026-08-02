import { execFile, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { CommandRunner, HostFileSystem, RunOptions, RunResult } from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger("native");

const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Runs external programs with execFile (never a shell), so arguments are passed
 * verbatim to the OS and no user-controlled string is ever interpreted as
 * shell syntax.
 */
export class NodeCommandRunner implements CommandRunner {
  private readonly whichCache = new Map<string, boolean>();

  run(program: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<RunResult>((resolve) => {
      execFile(
        program,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          cwd: options.cwd,
          env: options.env ? { ...process.env, ...options.env } : process.env,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (error) {
            const code = typeof error.code === "number" ? error.code : null;
            const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
            const timedOut = (error as { killed?: boolean }).killed === true && code === null;
            log.debug(`run ${program} failed`, { args, code, missing, timedOut, stderr: stderr.slice(0, 500) });
            resolve({
              code,
              stdout: stdout ?? "",
              stderr: stderr || String(error.message ?? error),
              missing,
              timedOut,
            });
            return;
          }
          resolve({ code: 0, stdout: stdout ?? "", stderr: stderr ?? "", missing: false, timedOut: false });
        },
      );
    });
  }

  async spawnDetached(program: string, args: string[], options: RunOptions = {}): Promise<number | undefined> {
    return new Promise<number | undefined>((resolve, reject) => {
      const child = spawn(program, args, {
        detached: true,
        stdio: "ignore",
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve(child.pid);
      });
    });
  }

  async which(program: string): Promise<boolean> {
    const cached = this.whichCache.get(program);
    if (cached !== undefined) return cached;
    const finder = process.platform === "win32" ? "where" : "which";
    const result = await this.run(finder, [program], { timeoutMs: 8_000 });
    const found = result.code === 0 && result.stdout.trim().length > 0;
    this.whichCache.set(program, found);
    return found;
  }
}

/** Real file system implementation of the small surface the backends need. */
export class NodeHostFileSystem implements HostFileSystem {
  exists(path: string): boolean {
    return existsSync(path);
  }

  readDir(path: string): string[] {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  }

  isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  modifiedAt(path: string): number {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  }

  size(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }

  mkdirp(path: string): void {
    mkdirSync(path, { recursive: true });
  }

  readFile(path: string): Buffer {
    return readFileSync(path);
  }

  readHead(path: string, maxBytes: number): Buffer {
    const handle = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const read = readSync(handle, buffer, 0, maxBytes, 0);
      return buffer.subarray(0, read);
    } finally {
      closeSync(handle);
    }
  }

  writeFile(path: string, contents: string): void {
    writeFileSync(path, contents, "utf8");
  }
}
