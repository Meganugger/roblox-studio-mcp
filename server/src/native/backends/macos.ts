import { join } from "node:path";
import {
  BackendProbe,
  CaptureOutcome,
  CaptureRequest,
  CommandRunner,
  HostFileSystem,
  KeyStroke,
  LaunchOutcome,
  LaunchRequest,
  NativeBackend,
  NativeOperationError,
  NativeUnavailableError,
  StudioProcess,
  WindowInfo,
} from "../types.js";
import { createLogger } from "../../logger.js";

const log = createLogger("native:darwin");

const APP_NAME = "RobloxStudio";
const PROCESS_NAME = "RobloxStudio";

/** Virtual key codes used by AppleScript's `key code` command. */
const MAC_KEY_CODES: Record<string, number> = {
  F1: 122,
  F2: 120,
  F3: 99,
  F4: 118,
  F5: 96,
  F6: 97,
  F7: 98,
  F8: 100,
  F9: 101,
  F10: 109,
  F11: 103,
  F12: 111,
  Escape: 53,
  Enter: 36,
  Tab: 48,
};

/** AppleScript that reports the Studio window's geometry and title. */
const WINDOW_INFO_SCRIPT = [
  `tell application "System Events"`,
  `  if not (exists process "${PROCESS_NAME}") then error "NO_STUDIO_WINDOW"`,
  `  tell process "${PROCESS_NAME}"`,
  `    if (count of windows) is 0 then error "NO_STUDIO_WINDOW"`,
  `    set winPosition to position of window 1`,
  `    set winSize to size of window 1`,
  `    set winTitle to name of window 1`,
  `    set isFront to frontmost`,
  `    return ((item 1 of winPosition) as string) & "|" & ((item 2 of winPosition) as string) & "|" & ((item 1 of winSize) as string) & "|" & ((item 2 of winSize) as string) & "|" & (isFront as string) & "|" & winTitle`,
  `  end tell`,
  `end tell`,
].join("\n");

/** Translate a keystroke into an AppleScript statement for System Events. */
export function toAppleScriptKeystroke(stroke: KeyStroke): string {
  const modifiers: string[] = [];
  if (stroke.modifiers.includes("primary")) modifiers.push("command down");
  if (stroke.modifiers.includes("shift")) modifiers.push("shift down");
  if (stroke.modifiers.includes("alt")) modifiers.push("option down");
  const using = modifiers.length > 0 ? ` using {${modifiers.join(", ")}}` : "";

  const keyCode = MAC_KEY_CODES[stroke.key];
  if (keyCode !== undefined) {
    return `tell application "System Events" to key code ${keyCode}${using}`;
  }
  if (!/^[A-Za-z0-9]$/.test(stroke.key)) {
    throw new NativeOperationError(`Unsupported key for macOS input: ${stroke.key}`);
  }
  return `tell application "System Events" to keystroke "${stroke.key.toLowerCase()}"${using}`;
}

export interface MacBackendOptions {
  runner: CommandRunner;
  fs: HostFileSystem;
  homeDir: string;
  studioPathOverride?: string;
}

export class MacBackend implements NativeBackend {
  readonly platform = "darwin" as const;
  readonly description = "macOS (AppleScript window control + System Events input + screencapture)";

  constructor(private readonly options: MacBackendOptions) {}

  async probe(): Promise<BackendProbe> {
    const [osascript, screencapture, sips] = await Promise.all([
      this.options.runner.which("osascript"),
      this.options.runner.which("screencapture"),
      this.options.runner.which("sips"),
    ]);
    const notes = [
      "macOS gates automation: grant your MCP client (or terminal) Accessibility permission for input " +
        "simulation and Screen Recording permission for screenshots in System Settings > Privacy & Security. " +
        "The first attempt triggers the permission prompt.",
    ];
    if (!sips) notes.push("`sips` is missing, so screenshots cannot be downscaled server-side.");
    return {
      processControl: osascript
        ? { available: true, via: "open / pgrep / osascript" }
        : { available: false, hint: "osascript is missing; this does not look like a standard macOS install." },
      windowControl: osascript
        ? { available: true, via: "AppleScript (System Events)" }
        : { available: false, hint: "osascript is required for window control." },
      inputSimulation: osascript
        ? { available: true, via: "AppleScript System Events keystrokes" }
        : { available: false, hint: "osascript is required for input simulation." },
      screenshot: screencapture
        ? { available: true, via: "screencapture" }
        : { available: false, hint: "screencapture is missing; it ships with macOS." },
      notes,
    };
  }

  async findStudio(): Promise<string | null> {
    const { fs, studioPathOverride, homeDir } = this.options;
    if (studioPathOverride) {
      if (!fs.exists(studioPathOverride)) {
        throw new NativeUnavailableError(
          `ROBLOX_MCP_STUDIO_PATH points at ${studioPathOverride}, which does not exist.`,
        );
      }
      return studioPathOverride;
    }
    const candidates = [
      `/Applications/${APP_NAME}.app`,
      join(homeDir, "Applications", `${APP_NAME}.app`),
    ];
    for (const candidate of candidates) {
      if (fs.exists(candidate)) return candidate;
    }
    return null;
  }

  async listProcesses(): Promise<StudioProcess[]> {
    const result = await this.options.runner.run("pgrep", ["-x", PROCESS_NAME], { timeoutMs: 8_000 });
    if (result.missing) {
      throw new NativeUnavailableError("pgrep is not available, so Studio processes cannot be listed.");
    }
    // pgrep exits 1 when nothing matched, which is not an error here.
    const pids = result.stdout
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    if (pids.length === 0) return [];

    let windowTitle: string | undefined;
    try {
      windowTitle = (await this.windowInfo()).title;
    } catch {
      windowTitle = undefined;
    }
    return pids.map((pid, index) => ({
      pid,
      name: PROCESS_NAME,
      windowTitle: index === 0 ? windowTitle : undefined,
    }));
  }

  async launch(request: LaunchRequest): Promise<LaunchOutcome> {
    const args: string[] = [];
    if (request.placeId !== undefined && !request.placeFilePath) {
      // The protocol handler is the only supported way to open a cloud place.
      args.push(`roblox-studio:1+launchmode:edit+task:EditPlace+placeId:${request.placeId}`);
    } else {
      args.push("-a", request.executablePath);
      if (request.placeFilePath) args.push(request.placeFilePath);
    }
    const result = await this.options.runner.run("open", args, { timeoutMs: 30_000 });
    if (result.missing) throw new NativeUnavailableError("`open` is not available on this macOS host.");
    if (result.code !== 0) {
      throw new NativeOperationError(`open failed (exit ${result.code}): ${result.stderr.trim() || "no output"}`);
    }
    log.info("Launched Roblox Studio", { args });
    return { command: "open", args };
  }

  async close(force: boolean): Promise<{ closed: number; forced: boolean }> {
    const before = await this.listProcesses();
    if (before.length === 0) return { closed: 0, forced: false };
    if (force) {
      const result = await this.options.runner.run("pkill", ["-9", "-x", PROCESS_NAME], { timeoutMs: 10_000 });
      if (result.missing) throw new NativeUnavailableError("pkill is not available on this host.");
      return { closed: before.length, forced: true };
    }
    await this.osascript(`tell application "${APP_NAME}" to quit`);
    return { closed: before.length, forced: false };
  }

  async focus(): Promise<WindowInfo> {
    await this.osascript(`tell application "${APP_NAME}" to activate`);
    return this.windowInfo();
  }

  async sendKeys(stroke: KeyStroke): Promise<void> {
    await this.osascript(toAppleScriptKeystroke(stroke));
  }

  async capture(request: CaptureRequest): Promise<CaptureOutcome> {
    const args = ["-x"];
    let via = "screencapture";
    if (!request.fullScreen) {
      const window = await this.focus();
      if (window.width <= 0 || window.height <= 0) {
        throw new NativeOperationError("The Studio window has no visible area (minimized?).");
      }
      args.push("-R", `${window.x},${window.y},${window.width},${window.height}`);
      via = "screencapture (window region)";
    }
    args.push(request.outputPath);

    const result = await this.options.runner.run("screencapture", args, { timeoutMs: 30_000 });
    if (result.missing) throw new NativeUnavailableError("screencapture is not available on this host.");
    if (result.code !== 0) {
      throw new NativeOperationError(
        `screencapture failed (exit ${result.code}): ${result.stderr.trim() || "no output"}. ` +
          "Grant Screen Recording permission to the process running this MCP server.",
      );
    }

    let scaled = false;
    if (request.maxWidth > 0) {
      const resize = await this.options.runner.run(
        "sips",
        ["-Z", String(request.maxWidth), request.outputPath],
        { timeoutMs: 20_000 },
      );
      scaled = resize.code === 0;
    }
    const dimensions = await this.imageSize(request.outputPath);
    return { path: request.outputPath, width: dimensions.width, height: dimensions.height, scaled, via };
  }

  private async imageSize(path: string): Promise<{ width: number; height: number }> {
    const result = await this.options.runner.run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], {
      timeoutMs: 15_000,
    });
    const width = Number.parseInt(/pixelWidth:\s*(\d+)/.exec(result.stdout)?.[1] ?? "0", 10);
    const height = Number.parseInt(/pixelHeight:\s*(\d+)/.exec(result.stdout)?.[1] ?? "0", 10);
    return { width: Number.isFinite(width) ? width : 0, height: Number.isFinite(height) ? height : 0 };
  }

  private async windowInfo(): Promise<WindowInfo> {
    const output = await this.osascript(WINDOW_INFO_SCRIPT);
    const parts = output.trim().split("|");
    if (parts.length < 6) {
      throw new NativeOperationError(`Unexpected AppleScript window info: ${output.slice(0, 200)}`);
    }
    const [x, y, width, height, frontmost, ...titleParts] = parts;
    return {
      title: titleParts.join("|").trim(),
      x: Number.parseInt(x, 10) || 0,
      y: Number.parseInt(y, 10) || 0,
      width: Number.parseInt(width, 10) || 0,
      height: Number.parseInt(height, 10) || 0,
      focused: frontmost.trim() === "true",
    };
  }

  private async osascript(script: string): Promise<string> {
    const result = await this.options.runner.run("osascript", ["-e", script], { timeoutMs: 30_000 });
    if (result.missing) throw new NativeUnavailableError("osascript is not available on this host.");
    if (result.code !== 0) {
      const stderr = result.stderr.trim();
      if (stderr.includes("NO_STUDIO_WINDOW")) {
        throw new NativeOperationError(
          "No Roblox Studio window was found. Launch Studio (launch_studio) first.",
        );
      }
      if (/not allowed|assistive|-1743|-25211/.test(stderr)) {
        throw new NativeUnavailableError(
          "macOS blocked the automation request. Grant Accessibility permission to the app running this MCP " +
            "server in System Settings > Privacy & Security > Accessibility, then retry. " +
            `(osascript said: ${stderr})`,
        );
      }
      throw new NativeOperationError(`osascript failed (exit ${result.code}): ${stderr || "no output"}`);
    }
    return result.stdout;
  }
}
