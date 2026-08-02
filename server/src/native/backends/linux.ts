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
  ToolStatus,
  WindowInfo,
} from "../types.js";
import { createLogger } from "../../logger.js";

const log = createLogger("native:linux");

/** Window-title fragment Studio uses on every platform. */
const WINDOW_NAME_PATTERN = "Roblox Studio";
/** Matches both a native binary and a Wine-hosted RobloxStudioBeta.exe. */
const PROCESS_PATTERN = "RobloxStudio";

/** Screenshot tools we know how to drive, in order of preference. */
const SCREENSHOT_TOOLS = ["import", "magick", "scrot", "gnome-screenshot", "spectacle"] as const;
type ScreenshotTool = (typeof SCREENSHOT_TOOLS)[number];

/** Translate a keystroke into an xdotool key expression. */
export function toXdotoolKey(stroke: KeyStroke): string {
  const parts: string[] = [];
  if (stroke.modifiers.includes("primary")) parts.push("ctrl");
  if (stroke.modifiers.includes("shift")) parts.push("shift");
  if (stroke.modifiers.includes("alt")) parts.push("alt");

  const key = stroke.key;
  if (/^F\d{1,2}$/.test(key)) {
    parts.push(key);
  } else if (key === "Escape") {
    parts.push("Escape");
  } else if (key === "Enter") {
    parts.push("Return");
  } else if (key === "Tab") {
    parts.push("Tab");
  } else if (/^[A-Za-z0-9]$/.test(key)) {
    parts.push(key.toLowerCase());
  } else {
    throw new NativeOperationError(`Unsupported key for Linux input: ${key}`);
  }
  return parts.join("+");
}

export interface LinuxBackendOptions {
  runner: CommandRunner;
  fs: HostFileSystem;
  env: Record<string, string | undefined>;
  studioPathOverride?: string;
}

export class LinuxBackend implements NativeBackend {
  readonly platform = "linux" as const;
  readonly description = "Linux/X11 (xdotool window control + input, ImageMagick capture)";

  private screenshotTool: ScreenshotTool | null = null;

  constructor(private readonly options: LinuxBackendOptions) {}

  async probe(): Promise<BackendProbe> {
    const [xdotool, pgrep] = await Promise.all([
      this.options.runner.which("xdotool"),
      this.options.runner.which("pgrep"),
    ]);
    const screenshotTool = await this.resolveScreenshotTool().catch(() => null);
    // xdotool and `import` both speak X11, so an X display is the real requirement.
    const hasX11 = Boolean(this.options.env.DISPLAY);
    const hasWayland = Boolean(this.options.env.WAYLAND_DISPLAY);

    const notes = [
      "Roblox does not ship a Linux build of Studio. This backend exists so the MCP server can run and be " +
        "tested on Linux, and can drive a Wine/Proton Studio install via ROBLOX_MCP_STUDIO_PATH.",
    ];
    let displayHint: string | undefined;
    if (!hasX11 && !hasWayland) {
      displayHint = "No DISPLAY is set (headless host).";
      notes.push("No DISPLAY/WAYLAND_DISPLAY is set: this is a headless host, so window control and screenshots cannot work.");
    } else if (!hasX11) {
      displayHint = "Only WAYLAND_DISPLAY is set; start XWayland or set DISPLAY.";
      notes.push("Wayland without XWayland: xdotool cannot control native Wayland windows.");
    }

    const xdotoolStatus: ToolStatus = xdotool
      ? { available: hasX11, via: "xdotool", hint: displayHint }
      : { available: false, hint: "Install xdotool (e.g. `apt install xdotool`) for window control and input." };

    return {
      processControl: pgrep
        ? { available: true, via: "pgrep / pkill" }
        : { available: false, hint: "Install procps (pgrep/pkill) for process control." },
      windowControl: xdotoolStatus,
      inputSimulation: xdotoolStatus,
      screenshot: screenshotTool
        ? { available: hasX11, via: screenshotTool, hint: displayHint }
        : {
            available: false,
            hint: `Install one of: ${SCREENSHOT_TOOLS.join(", ")} (ImageMagick provides \`import\`).`,
          },
      notes,
    };
  }

  async findStudio(): Promise<string | null> {
    const { fs, studioPathOverride } = this.options;
    if (studioPathOverride) {
      if (!fs.exists(studioPathOverride)) {
        throw new NativeUnavailableError(
          `ROBLOX_MCP_STUDIO_PATH points at ${studioPathOverride}, which does not exist.`,
        );
      }
      return studioPathOverride;
    }
    return null;
  }

  async listProcesses(): Promise<StudioProcess[]> {
    const result = await this.options.runner.run("pgrep", ["-f", PROCESS_PATTERN], { timeoutMs: 8_000 });
    if (result.missing) {
      throw new NativeUnavailableError("pgrep is not installed, so Studio processes cannot be listed.");
    }
    const pids = result.stdout
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
    return pids.map((pid) => ({ pid, name: PROCESS_PATTERN }));
  }

  async launch(request: LaunchRequest): Promise<LaunchOutcome> {
    const args: string[] = [];
    if (request.placeFilePath) args.push(request.placeFilePath);
    else if (request.placeId !== undefined) args.push(`roblox-studio:1+launchmode:edit+task:EditPlace+placeId:${request.placeId}`);
    const pid = await this.options.runner.spawnDetached(request.executablePath, args);
    log.info("Launched Studio via ROBLOX_MCP_STUDIO_PATH", { pid, args });
    return { pid, command: request.executablePath, args };
  }

  async close(force: boolean): Promise<{ closed: number; forced: boolean }> {
    const processes = await this.listProcesses();
    if (processes.length === 0) return { closed: 0, forced: false };
    if (!force) {
      const window = await this.findWindow();
      await this.xdotool(["windowclose", window.id]);
      return { closed: 1, forced: false };
    }
    const result = await this.options.runner.run("pkill", ["-9", "-f", PROCESS_PATTERN], { timeoutMs: 10_000 });
    if (result.missing) throw new NativeUnavailableError("pkill is not installed on this host.");
    return { closed: processes.length, forced: true };
  }

  async focus(): Promise<WindowInfo> {
    const window = await this.findWindow();
    await this.activate(window.id);
    return this.windowInfo(window.id);
  }

  async sendKeys(stroke: KeyStroke): Promise<void> {
    const window = await this.findWindow();
    const info = await this.windowInfo(window.id);
    if (!info.title.includes(WINDOW_NAME_PATTERN)) {
      throw new NativeOperationError(
        `Refusing to send input: the target window is "${info.title}", which is not Roblox Studio.`,
      );
    }
    const activated = await this.activate(window.id);
    const key = toXdotoolKey(stroke);
    if (activated) {
      await this.xdotool(["key", "--clearmodifiers", key]);
      return;
    }
    // Without an EWMH-compliant window manager the window cannot be activated,
    // so address it directly. Some applications ignore synthetic events, hence
    // activation is always preferred.
    await this.xdotool(["key", "--window", window.id, "--clearmodifiers", key]);
  }

  async capture(request: CaptureRequest): Promise<CaptureOutcome> {
    const tool = await this.resolveScreenshotTool();
    let windowId: string | null = null;
    if (!request.fullScreen) {
      const window = await this.findWindow();
      // Best effort: `import -window` can capture a window that is not focused.
      await this.activate(window.id);
      windowId = window.id;
    }

    const invocation = this.captureArgs(tool, windowId, request.outputPath);
    const result = await this.options.runner.run(invocation.program, invocation.args, { timeoutMs: 30_000 });
    if (result.missing) throw new NativeUnavailableError(`${invocation.program} is not installed on this host.`);
    if (result.code !== 0) {
      throw new NativeOperationError(
        `${invocation.program} failed (exit ${result.code}): ${result.stderr.trim() || "no output"}`,
      );
    }

    let scaled = false;
    if (request.maxWidth > 0) {
      const converter = (await this.options.runner.which("magick")) ? "magick" : "convert";
      const resize = await this.options.runner.run(
        converter,
        [request.outputPath, "-resize", `${request.maxWidth}x>`, request.outputPath],
        { timeoutMs: 25_000 },
      );
      scaled = resize.code === 0;
    }
    const dimensions = await this.imageSize(request.outputPath);
    return { path: request.outputPath, width: dimensions.width, height: dimensions.height, scaled, via: tool };
  }

  /** Command line for each supported screenshot tool. */
  private captureArgs(
    tool: ScreenshotTool,
    windowId: string | null,
    outputPath: string,
  ): { program: string; args: string[] } {
    switch (tool) {
      case "import":
        return { program: "import", args: ["-window", windowId ?? "root", outputPath] };
      case "magick":
        return { program: "magick", args: ["import", "-window", windowId ?? "root", outputPath] };
      case "scrot":
        return { program: "scrot", args: windowId ? ["-u", "-o", outputPath] : ["-o", outputPath] };
      case "gnome-screenshot":
        return { program: "gnome-screenshot", args: windowId ? ["-w", "-f", outputPath] : ["-f", outputPath] };
      case "spectacle":
        return { program: "spectacle", args: windowId ? ["-b", "-n", "-a", "-o", outputPath] : ["-b", "-n", "-f", "-o", outputPath] };
    }
  }

  private async imageSize(path: string): Promise<{ width: number; height: number }> {
    const program = (await this.options.runner.which("identify")) ? "identify" : "magick";
    const args = program === "identify" ? ["-format", "%w %h", path] : ["identify", "-format", "%w %h", path];
    const result = await this.options.runner.run(program, args, { timeoutMs: 15_000 });
    const match = /(\d+)\s+(\d+)/.exec(result.stdout.trim());
    if (!match) return { width: 0, height: 0 };
    return { width: Number.parseInt(match[1], 10), height: Number.parseInt(match[2], 10) };
  }

  private async resolveScreenshotTool(): Promise<ScreenshotTool> {
    if (this.screenshotTool) return this.screenshotTool;
    for (const tool of SCREENSHOT_TOOLS) {
      if (await this.options.runner.which(tool)) {
        this.screenshotTool = tool;
        return tool;
      }
    }
    throw new NativeUnavailableError(
      `No screenshot tool found. Install one of: ${SCREENSHOT_TOOLS.join(", ")} (ImageMagick provides \`import\`).`,
    );
  }

  /**
   * Bring a window to the front. `windowactivate` requires a window manager
   * that implements _NET_ACTIVE_WINDOW; bare X servers and minimal WMs do not,
   * so fall back to focus + raise. Returns whether activation succeeded.
   */
  private async activate(windowId: string): Promise<boolean> {
    const activate = await this.options.runner.run("xdotool", ["windowactivate", "--sync", windowId], {
      timeoutMs: 20_000,
    });
    if (activate.missing) {
      throw new NativeUnavailableError(
        "xdotool is not installed. Install it (e.g. `apt install xdotool`) for window control, input " +
          "simulation and window screenshots on Linux.",
      );
    }
    if (activate.code === 0) return true;

    log.debug("windowactivate failed; falling back to windowfocus/windowraise", {
      stderr: activate.stderr.trim().slice(0, 200),
    });
    const focus = await this.options.runner.run("xdotool", ["windowfocus", "--sync", windowId], {
      timeoutMs: 20_000,
    });
    await this.options.runner.run("xdotool", ["windowraise", windowId], { timeoutMs: 20_000 });
    return focus.code === 0;
  }

  private async findWindow(): Promise<{ id: string }> {
    const result = await this.xdotool(["search", "--name", WINDOW_NAME_PATTERN]);
    const id = result
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .pop();
    if (!id) {
      throw new NativeOperationError(
        `No window matching "${WINDOW_NAME_PATTERN}" is open. Launch Studio first (launch_studio).`,
      );
    }
    return { id };
  }

  private async windowInfo(windowId: string): Promise<WindowInfo> {
    const geometry = await this.xdotool(["getwindowgeometry", "--shell", windowId]);
    const read = (key: string): number => {
      const match = new RegExp(`^${key}=(-?\\d+)$`, "m").exec(geometry);
      return match ? Number.parseInt(match[1], 10) : 0;
    };
    const name = (await this.xdotool(["getwindowname", windowId])).trim();
    const active = (await this.xdotool(["getactivewindow"]).catch(() => "")).trim();
    return {
      title: name,
      x: read("X"),
      y: read("Y"),
      width: read("WIDTH"),
      height: read("HEIGHT"),
      focused: active === windowId,
      windowId,
    };
  }

  private async xdotool(args: string[]): Promise<string> {
    const result = await this.options.runner.run("xdotool", args, { timeoutMs: 20_000 });
    if (result.missing) {
      throw new NativeUnavailableError(
        "xdotool is not installed. Install it (e.g. `apt install xdotool`) for window control, input " +
          "simulation and window screenshots on Linux.",
      );
    }
    if (result.code !== 0) {
      throw new NativeOperationError(
        `xdotool ${args[0]} failed (exit ${result.code}): ${result.stderr.trim() || "no output"}`,
      );
    }
    return result.stdout;
  }
}
