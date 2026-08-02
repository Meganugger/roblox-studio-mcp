import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { NodeCommandRunner, NodeHostFileSystem } from "./runner.js";
import { LinuxBackend } from "./backends/linux.js";
import { MacBackend } from "./backends/macos.js";
import { WindowsBackend } from "./backends/windows.js";
import { describeShortcuts, getShortcut, ShortcutName } from "./shortcuts.js";
import {
  BackendProbe,
  CaptureOutcome,
  CommandRunner,
  HostFileSystem,
  NativeBackend,
  NativePlatform,
  NativeUnavailableError,
  StudioProcess,
  WindowInfo,
} from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger("native:host");

/** Images larger than this are not inlined into the MCP response. */
export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

/** Configuration the native layer needs (a subset of ServerConfig). */
export interface NativeConfig {
  allowNative: boolean;
  allowNativeInput: boolean;
  studioPath?: string;
  screenshotDir: string;
}

export interface NativeHostOptions {
  config: NativeConfig;
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
  fs?: HostFileSystem;
  env?: Record<string, string | undefined>;
  homeDir?: string;
}

export interface HostCapabilities {
  platform: string;
  supported: boolean;
  backend: string | null;
  gates: { nativeControl: boolean; inputSimulation: boolean };
  studio: { executablePath: string | null; running: boolean; processes: StudioProcess[] };
  probe: BackendProbe | null;
  shortcuts: Array<{ name: ShortcutName; keys: string; description: string }>;
  screenshotDir: string;
  notes: string[];
}

export interface ScreenshotResult extends CaptureOutcome {
  /** Base64 PNG, omitted when the file is too large to inline. */
  base64?: string;
  bytes: number;
  inlined: boolean;
}

/**
 * Facade over the platform backends.
 *
 * Adds the things that must behave identically on every OS: the security
 * gates, the shortcut allowlist, screenshot storage, and error messages that
 * tell the agent (and the user) exactly what to fix.
 */
export class NativeHost {
  readonly platform: NodeJS.Platform;
  private readonly backend: NativeBackend | null;
  private readonly config: NativeConfig;
  private readonly fs: HostFileSystem;

  constructor(options: NativeHostOptions) {
    this.platform = options.platform ?? osPlatform();
    this.config = options.config;
    const runner = options.runner ?? new NodeCommandRunner();
    this.fs = options.fs ?? new NodeHostFileSystem();
    const env = options.env ?? process.env;
    const homeDir = options.homeDir ?? homedir();

    switch (this.platform) {
      case "win32":
        this.backend = new WindowsBackend({
          runner,
          fs: this.fs,
          env,
          studioPathOverride: this.config.studioPath,
        });
        break;
      case "darwin":
        this.backend = new MacBackend({
          runner,
          fs: this.fs,
          homeDir,
          studioPathOverride: this.config.studioPath,
        });
        break;
      case "linux":
        this.backend = new LinuxBackend({
          runner,
          fs: this.fs,
          env,
          studioPathOverride: this.config.studioPath,
        });
        break;
      default:
        this.backend = null;
    }
  }

  get nativePlatform(): NativePlatform | null {
    return this.backend?.platform ?? null;
  }

  /** Full capability report; never throws, so the agent can always orient itself. */
  async capabilities(): Promise<HostCapabilities> {
    const shortcuts = describeShortcuts(this.platform === "darwin");
    const base: HostCapabilities = {
      platform: this.platform,
      supported: this.backend !== null,
      backend: this.backend?.description ?? null,
      gates: {
        nativeControl: this.config.allowNative,
        inputSimulation: this.config.allowNative && this.config.allowNativeInput,
      },
      studio: { executablePath: null, running: false, processes: [] },
      probe: null,
      shortcuts,
      screenshotDir: this.config.screenshotDir,
      notes: [],
    };

    if (!this.backend) {
      base.notes.push(
        `No native backend exists for platform "${this.platform}". Studio launching, window control, input ` +
          "simulation and screenshots are unavailable; every other tool works normally.",
      );
      return base;
    }
    if (!this.config.allowNative) {
      base.notes.push(
        "Native host control is disabled (ROBLOX_MCP_ALLOW_NATIVE=0). Set it to 1 to allow launching Studio, " +
          "window control, screenshots and shortcut input.",
      );
    }
    if (this.config.allowNative && !this.config.allowNativeInput) {
      base.notes.push(
        "Input simulation is disabled (ROBLOX_MCP_ALLOW_NATIVE_INPUT=0): send_studio_shortcut, " +
          "start_play_solo, stop_play_solo and native saving are blocked. Everything else still works.",
      );
    }

    base.probe = await this.backend.probe().catch((err) => {
      base.notes.push(`Capability probe failed: ${String(err instanceof Error ? err.message : err)}`);
      return null;
    });

    try {
      base.studio.executablePath = await this.backend.findStudio();
    } catch (err) {
      base.notes.push(String(err instanceof Error ? err.message : err));
    }
    if (!base.studio.executablePath) {
      base.notes.push(
        "Roblox Studio was not found automatically. Set ROBLOX_MCP_STUDIO_PATH to the Studio executable " +
          "(Windows: ...\\Roblox\\Versions\\version-xxxx\\RobloxStudioBeta.exe, macOS: /Applications/RobloxStudio.app).",
      );
    }
    try {
      base.studio.processes = await this.backend.listProcesses();
      base.studio.running = base.studio.processes.length > 0;
    } catch (err) {
      base.notes.push(String(err instanceof Error ? err.message : err));
    }
    return base;
  }

  async studioProcesses(): Promise<StudioProcess[]> {
    return this.requireBackend().listProcesses();
  }

  async findStudioExecutable(): Promise<string> {
    const executable = await this.requireBackend().findStudio();
    if (!executable) {
      throw new NativeUnavailableError(
        "Roblox Studio was not found on this machine. Install Studio, or set ROBLOX_MCP_STUDIO_PATH to its " +
          "executable path and restart the MCP server. (Windows: " +
          "%LOCALAPPDATA%\\Roblox\\Versions\\version-xxxx\\RobloxStudioBeta.exe, macOS: /Applications/RobloxStudio.app)",
      );
    }
    return executable;
  }

  async launchStudio(request: { placeFilePath?: string; placeId?: number }): Promise<{
    pid?: number;
    command: string;
    args: string[];
    executablePath: string;
  }> {
    const backend = this.requireBackend();
    const executablePath = await this.findStudioExecutable();
    const outcome = await backend.launch({ executablePath, ...request });
    return { ...outcome, executablePath };
  }

  async closeStudio(force: boolean): Promise<{ closed: number; forced: boolean }> {
    return this.requireBackend().close(force);
  }

  async focusWindow(): Promise<WindowInfo> {
    return this.requireBackend().focus();
  }

  /**
   * Send one allowlisted Studio shortcut. The backend focuses Studio and
   * verifies the target window before delivering the keystroke.
   */
  async sendShortcut(name: ShortcutName): Promise<{ shortcut: ShortcutName; keys: string; window: WindowInfo }> {
    const backend = this.requireBackend();
    if (!this.config.allowNativeInput) {
      throw new NativeUnavailableError(
        "Input simulation is disabled on this server (ROBLOX_MCP_ALLOW_NATIVE_INPUT=0). Set it to 1 to allow " +
          "sending Studio shortcuts such as play, stop and save.",
      );
    }
    const definition = getShortcut(name);
    const window = await backend.focus();
    await backend.sendKeys(definition.stroke);
    const keys = this.platform === "darwin" ? definition.combo.primaryIsCommand : definition.combo.primaryIsCtrl;
    log.info(`Sent Studio shortcut ${name} (${keys})`);
    return { shortcut: name, keys, window };
  }

  /** Capture the Studio window (or the whole screen) to a PNG under screenshotDir. */
  async captureScreenshot(options: {
    maxWidth: number;
    fullScreen: boolean;
    label?: string;
    inline: boolean;
  }): Promise<ScreenshotResult> {
    const backend = this.requireBackend();
    this.fs.mkdirp(this.config.screenshotDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeLabel = (options.label ?? "studio").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
    const outputPath = join(this.config.screenshotDir, `${safeLabel}-${stamp}.png`);

    const outcome = await backend.capture({
      outputPath,
      maxWidth: options.maxWidth,
      fullScreen: options.fullScreen,
    });

    const bytes = this.fs.size(outcome.path);
    if (bytes === 0) {
      throw new NativeUnavailableError(
        `The screenshot tool reported success but produced no image at ${outcome.path}. On macOS grant Screen ` +
          "Recording permission; on Linux make sure an X display is available.",
      );
    }
    const inlined = options.inline && bytes <= MAX_INLINE_IMAGE_BYTES;
    return {
      ...outcome,
      bytes,
      inlined,
      base64: inlined ? this.fs.readFile(outcome.path).toString("base64") : undefined,
    };
  }

  private requireBackend(): NativeBackend {
    if (!this.config.allowNative) {
      throw new NativeUnavailableError(
        "Native host control is disabled on this server (ROBLOX_MCP_ALLOW_NATIVE=0). Set ROBLOX_MCP_ALLOW_NATIVE=1 " +
          "and restart the server to allow launching Studio, focusing its window, sending shortcuts and taking " +
          "screenshots.",
      );
    }
    if (!this.backend) {
      throw new NativeUnavailableError(
        `Native host control is not supported on platform "${this.platform}". Roblox Studio runs on Windows and ` +
          "macOS; the remaining tools work over the plugin bridge regardless of where this server runs.",
      );
    }
    return this.backend;
  }
}
