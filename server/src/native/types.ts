/**
 * Types for the native host-control layer (v3 "Studio host control").
 *
 * The MCP server talks to the *machine* through this layer: it finds and
 * launches Roblox Studio, focuses its window, sends allowlisted keyboard
 * shortcuts, and captures screenshots. Everything platform specific lives
 * behind `NativeBackend`, which has one implementation per OS. Backends never
 * touch `process.env` or spawn processes directly - they receive a
 * `CommandRunner` and a `HostFileSystem`, which makes every command line
 * assertable in tests on any OS.
 */

export type NativePlatform = "win32" | "darwin" | "linux";

/** Result of running an external program. */
export interface RunResult {
  /** Exit code, or null when the process was killed / never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the program could not be found on this system. */
  missing: boolean;
  /** True when the run exceeded its timeout and was killed. */
  timedOut: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  /** Extra environment variables (merged over the server's own environment). */
  env?: Record<string, string>;
  cwd?: string;
}

/** Injectable process runner. Never uses a shell: argv is passed verbatim. */
export interface CommandRunner {
  run(program: string, args: string[], options?: RunOptions): Promise<RunResult>;
  /** Start a program that outlives this server (used to launch Studio). */
  spawnDetached(program: string, args: string[], options?: RunOptions): Promise<number | undefined>;
  /** Whether a program is resolvable on PATH. Results may be cached. */
  which(program: string): Promise<boolean>;
}

/** Minimal file-system surface the backends need (injectable for tests). */
export interface HostFileSystem {
  exists(path: string): boolean;
  readDir(path: string): string[];
  isDirectory(path: string): boolean;
  /** Modification time in epoch milliseconds, or 0 when unknown. */
  modifiedAt(path: string): number;
  size(path: string): number;
  mkdirp(path: string): void;
  readFile(path: string): Buffer;
  /** Read at most `maxBytes` from the start of a file (format sniffing). */
  readHead(path: string, maxBytes: number): Buffer;
  writeFile(path: string, contents: string): void;
}

/** A running Roblox Studio process. */
export interface StudioProcess {
  pid: number;
  name: string;
  windowTitle?: string;
  executablePath?: string;
}

/** Geometry and focus state of the Studio window. */
export interface WindowInfo {
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  focused: boolean;
  /** Platform window handle/id, when the backend exposes one. */
  windowId?: string;
}

/** Modifier keys, expressed platform-independently. */
export type KeyModifier = "primary" | "shift" | "alt";

/**
 * One keystroke. `primary` maps to Ctrl on Windows/Linux and Command on macOS,
 * which is why shortcuts are declared once and translated per backend.
 */
export interface KeyStroke {
  key: string;
  modifiers: KeyModifier[];
}

export interface LaunchRequest {
  executablePath: string;
  /** Absolute path of a local .rbxl/.rbxlx to open in edit mode. */
  placeFilePath?: string;
  /** Cloud placeId to open in edit mode (requires the user to be signed in). */
  placeId?: number;
}

export interface LaunchOutcome {
  pid?: number;
  command: string;
  args: string[];
}

export interface CaptureRequest {
  /** Absolute destination path for the PNG. */
  outputPath: string;
  /** Downscale so the image is at most this wide (0 = keep native size). */
  maxWidth: number;
  /** Capture the whole screen instead of just the Studio window. */
  fullScreen: boolean;
}

export interface CaptureOutcome {
  path: string;
  width: number;
  height: number;
  /** True when the capture was downscaled to satisfy maxWidth. */
  scaled: boolean;
  /** What produced the image, e.g. "System.Drawing", "screencapture", "import". */
  via: string;
}

export interface ToolStatus {
  available: boolean;
  /** Which external tool provides the capability. */
  via?: string;
  /** Actionable instruction when unavailable. */
  hint?: string;
}

/** Which native capabilities this host actually supports. */
export interface BackendProbe {
  processControl: ToolStatus;
  windowControl: ToolStatus;
  inputSimulation: ToolStatus;
  screenshot: ToolStatus;
  notes: string[];
}

/** One OS implementation of the native layer. */
export interface NativeBackend {
  readonly platform: NativePlatform;
  /** Human-readable description, e.g. "Windows (PowerShell + Win32)". */
  readonly description: string;
  probe(): Promise<BackendProbe>;
  /** Absolute path of the Studio executable/app, or null when not found. */
  findStudio(): Promise<string | null>;
  listProcesses(): Promise<StudioProcess[]>;
  launch(request: LaunchRequest): Promise<LaunchOutcome>;
  close(force: boolean): Promise<{ closed: number; forced: boolean }>;
  /** Bring the Studio window to the foreground and report its geometry. */
  focus(): Promise<WindowInfo>;
  /** Send one keystroke to the Studio window (already focused by the host). */
  sendKeys(stroke: KeyStroke): Promise<void>;
  capture(request: CaptureRequest): Promise<CaptureOutcome>;
}

/** Raised when a native operation is impossible on this host, with a fix hint. */
export class NativeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeUnavailableError";
  }
}

/** Raised when a native operation ran but failed (window missing, tool error). */
export class NativeOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeOperationError";
  }
}
