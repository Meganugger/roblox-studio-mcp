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

const log = createLogger("native:win32");

/** Process names Roblox uses for Studio (Beta is the modern one). */
const STUDIO_PROCESS_NAMES = ["RobloxStudioBeta", "RobloxStudio"];
const STUDIO_EXECUTABLE = "RobloxStudioBeta.exe";
const LEGACY_STUDIO_EXECUTABLE = "RobloxStudio.exe";

/**
 * PowerShell toolkit driving Win32 for window control, input and capture.
 *
 * Invoked once per operation with `-EncodedCommand`, and all inputs arrive
 * through environment variables (MCP_MODE, MCP_KEYS, ...). Nothing is ever
 * string-interpolated into the script, so no argument can alter the code that
 * runs. Every mode prints a single compressed JSON object on stdout.
 */
const TOOLKIT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if (-not ('McpNative.Win32' -as [type])) {
  Add-Type -Namespace McpNative -Name Win32 -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@
}

$names = @('RobloxStudioBeta','RobloxStudio')

function Get-StudioProcesses {
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.ProcessName }
}

function Get-StudioWindowProcess {
  Get-StudioProcesses | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
}

function Get-WindowRect($handle) {
  $rect = New-Object McpNative.Win32+RECT
  if (-not [McpNative.Win32]::GetWindowRect($handle, [ref]$rect)) {
    throw 'GetWindowRect failed for the Studio window.'
  }
  return $rect
}

function Focus-Studio {
  $proc = Get-StudioWindowProcess
  if (-not $proc) { throw 'NO_STUDIO_WINDOW' }
  $handle = $proc.MainWindowHandle
  if ([McpNative.Win32]::IsIconic($handle)) { [void][McpNative.Win32]::ShowWindow($handle, 9) }
  [void][McpNative.Win32]::SetForegroundWindow($handle)
  if ([McpNative.Win32]::GetForegroundWindow() -ne $handle) {
    # SetForegroundWindow is refused when the caller is not the foreground app;
    # AppActivate goes through the shell, which Windows allows more often.
    try {
      $shell = New-Object -ComObject WScript.Shell
      [void]$shell.AppActivate($proc.Id)
    } catch { }
  }
  Start-Sleep -Milliseconds 250
  $rect = Get-WindowRect $handle
  return [ordered]@{
    title = $proc.MainWindowTitle
    windowId = $handle.ToString()
    pid = $proc.Id
    x = $rect.Left
    y = $rect.Top
    width = ($rect.Right - $rect.Left)
    height = ($rect.Bottom - $rect.Top)
    focused = ([McpNative.Win32]::GetForegroundWindow() -eq $handle)
  }
}

function Save-Png($bitmap, $path, $maxWidth) {
  $scaled = $false
  $image = $bitmap
  if ($maxWidth -gt 0 -and $bitmap.Width -gt $maxWidth) {
    $ratio = $maxWidth / $bitmap.Width
    $newWidth = [int]$maxWidth
    $newHeight = [Math]::Max(1, [int][Math]::Round($bitmap.Height * $ratio))
    $resized = New-Object System.Drawing.Bitmap $newWidth, $newHeight
    $graphics = [System.Drawing.Graphics]::FromImage($resized)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.DrawImage($bitmap, 0, 0, $newWidth, $newHeight)
    $graphics.Dispose()
    $image = $resized
    $scaled = $true
  }
  $image.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $result = [ordered]@{ path = $path; width = $image.Width; height = $image.Height; scaled = $scaled; via = 'System.Drawing' }
  if ($scaled) { $image.Dispose() }
  return $result
}

switch ($env:MCP_MODE) {
  'probe' {
    $forms = $false
    $drawing = $false
    try { Add-Type -AssemblyName System.Windows.Forms; $forms = $true } catch { }
    try { Add-Type -AssemblyName System.Drawing; $drawing = $true } catch { }
    [ordered]@{
      powerShell = $PSVersionTable.PSVersion.ToString()
      forms = $forms
      drawing = $drawing
      studioRunning = ((Get-StudioProcesses | Measure-Object).Count -gt 0)
    } | ConvertTo-Json -Compress
  }
  'list' {
    $items = @()
    foreach ($proc in Get-StudioProcesses) {
      $path = $null
      try { $path = $proc.Path } catch { }
      $items += [ordered]@{
        pid = $proc.Id
        name = $proc.ProcessName
        windowTitle = $proc.MainWindowTitle
        executablePath = $path
      }
    }
    [ordered]@{ processes = $items } | ConvertTo-Json -Compress -Depth 4
  }
  'focus' {
    (Focus-Studio) | ConvertTo-Json -Compress
  }
  'keys' {
    Add-Type -AssemblyName System.Windows.Forms
    $window = Focus-Studio
    if (-not ($window.title -match 'Roblox Studio')) {
      # Refuse to type into a window we cannot positively identify as Studio.
      throw ('WINDOW_NOT_STUDIO:' + $window.title)
    }
    [System.Windows.Forms.SendKeys]::SendWait($env:MCP_KEYS)
    Start-Sleep -Milliseconds 150
    [ordered]@{ sent = $env:MCP_KEYS; title = $window.title } | ConvertTo-Json -Compress
  }
  'capture' {
    Add-Type -AssemblyName System.Drawing
    [void][McpNative.Win32]::SetProcessDPIAware()
    $maxWidth = [int]$env:MCP_MAXWIDTH
    if ($env:MCP_FULLSCREEN -eq '1') {
      Add-Type -AssemblyName System.Windows.Forms
      $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $x = $bounds.X; $y = $bounds.Y; $w = $bounds.Width; $h = $bounds.Height
      $title = 'Virtual screen'
    } else {
      $window = Focus-Studio
      $x = $window.x; $y = $window.y; $w = $window.width; $h = $window.height
      $title = $window.title
    }
    if ($w -le 0 -or $h -le 0) { throw 'Studio window has no visible area (minimized?).' }
    $bitmap = New-Object System.Drawing.Bitmap $w, $h
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
    $graphics.Dispose()
    $result = Save-Png $bitmap $env:MCP_OUT $maxWidth
    $bitmap.Dispose()
    $result.title = $title
    $result | ConvertTo-Json -Compress
  }
  'close' {
    $closed = 0
    $forced = $false
    foreach ($proc in Get-StudioProcesses) {
      if ($env:MCP_FORCE -eq '1') {
        Stop-Process -Id $proc.Id -Force
        $forced = $true
        $closed++
      } elseif ($proc.CloseMainWindow()) {
        $closed++
      }
    }
    [ordered]@{ closed = $closed; forced = $forced } | ConvertTo-Json -Compress
  }
  default { throw ('Unknown mode: ' + $env:MCP_MODE) }
}
`;

export interface WindowsBackendOptions {
  runner: CommandRunner;
  fs: HostFileSystem;
  env: Record<string, string | undefined>;
  studioPathOverride?: string;
}

interface WindowPayload {
  title?: string;
  windowId?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  focused?: boolean;
}

/** Translate a platform-independent keystroke into a SendKeys expression. */
export function toSendKeys(stroke: KeyStroke): string {
  let prefix = "";
  if (stroke.modifiers.includes("primary")) prefix += "^";
  if (stroke.modifiers.includes("shift")) prefix += "+";
  if (stroke.modifiers.includes("alt")) prefix += "%";

  const key = stroke.key;
  if (/^F\d{1,2}$/.test(key)) return `${prefix}{${key}}`;
  switch (key) {
    case "Escape":
      return `${prefix}{ESC}`;
    case "Enter":
      return `${prefix}{ENTER}`;
    case "Tab":
      return `${prefix}{TAB}`;
    default:
      if (!/^[A-Za-z0-9]$/.test(key)) {
        throw new NativeOperationError(`Unsupported key for Windows input: ${key}`);
      }
      // Lowercase: an uppercase letter would imply an extra Shift in SendKeys.
      return `${prefix}${key.toLowerCase()}`;
  }
}

export class WindowsBackend implements NativeBackend {
  readonly platform = "win32" as const;
  readonly description = "Windows (PowerShell + Win32: window control, SendKeys input, GDI+ capture)";

  private powerShellExecutable: string | null = null;
  private readonly encodedToolkit = Buffer.from(TOOLKIT, "utf16le").toString("base64");

  constructor(private readonly options: WindowsBackendOptions) {}

  async probe(): Promise<BackendProbe> {
    const shell = await this.resolvePowerShell().catch(() => null);
    if (!shell) {
      const missing: BackendProbe = {
        processControl: { available: false, hint: "powershell.exe / pwsh.exe was not found on PATH." },
        windowControl: { available: false, hint: "powershell.exe / pwsh.exe was not found on PATH." },
        inputSimulation: { available: false, hint: "powershell.exe / pwsh.exe was not found on PATH." },
        screenshot: { available: false, hint: "powershell.exe / pwsh.exe was not found on PATH." },
        notes: ["No PowerShell interpreter is available, so no native operation can run."],
      };
      return missing;
    }

    const notes: string[] = [];
    let forms = false;
    let drawing = false;
    try {
      const payload = await this.invoke<{ powerShell?: string; forms?: boolean; drawing?: boolean }>("probe", {});
      forms = payload.forms === true;
      drawing = payload.drawing === true;
      if (payload.powerShell) notes.push(`PowerShell ${payload.powerShell} via ${shell}.`);
    } catch (err) {
      notes.push(`PowerShell probe failed: ${String(err instanceof Error ? err.message : err)}`);
    }

    return {
      processControl: { available: true, via: shell },
      windowControl: { available: true, via: `${shell} + user32.dll` },
      inputSimulation: forms
        ? { available: true, via: "System.Windows.Forms.SendKeys" }
        : {
            available: false,
            hint:
              "System.Windows.Forms could not be loaded. Use Windows PowerShell 5.1 (powershell.exe) or " +
              "install the .NET Windows Desktop runtime for PowerShell 7.",
          },
      screenshot: drawing
        ? { available: true, via: "System.Drawing (GDI+ CopyFromScreen)" }
        : {
            available: false,
            hint:
              "System.Drawing could not be loaded. Use Windows PowerShell 5.1 (powershell.exe) or install " +
              "the .NET Windows Desktop runtime for PowerShell 7.",
          },
      notes,
    };
  }

  async findStudio(): Promise<string | null> {
    const { fs, env, studioPathOverride } = this.options;
    if (studioPathOverride) {
      if (!fs.exists(studioPathOverride)) {
        throw new NativeUnavailableError(
          `ROBLOX_MCP_STUDIO_PATH points at ${studioPathOverride}, which does not exist.`,
        );
      }
      return studioPathOverride;
    }

    const roots = [
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Roblox", "Versions") : undefined,
      env["ProgramFiles(x86)"] ? join(env["ProgramFiles(x86)"] as string, "Roblox", "Versions") : undefined,
      env.ProgramFiles ? join(env.ProgramFiles, "Roblox", "Versions") : undefined,
    ].filter((value): value is string => Boolean(value));

    let best: { path: string; modifiedAt: number } | null = null;
    for (const root of roots) {
      if (!fs.isDirectory(root)) continue;
      for (const versionDir of fs.readDir(root)) {
        for (const executable of [STUDIO_EXECUTABLE, LEGACY_STUDIO_EXECUTABLE]) {
          const candidate = join(root, versionDir, executable);
          if (!fs.exists(candidate)) continue;
          const modifiedAt = fs.modifiedAt(candidate);
          if (!best || modifiedAt > best.modifiedAt) best = { path: candidate, modifiedAt };
        }
      }
    }
    if (best) return best.path;

    // Fall back to the roblox-studio: protocol handler registered by the installer.
    const registry = await this.options.runner.run(
      "reg.exe",
      ["query", "HKCU\\Software\\Classes\\roblox-studio\\shell\\open\\command", "/ve"],
      { timeoutMs: 10_000 },
    );
    if (registry.code === 0) {
      const match = /"([^"]+RobloxStudio[^"]*\.exe)"/i.exec(registry.stdout);
      if (match && fs.exists(match[1])) return match[1];
    }
    return null;
  }

  async listProcesses(): Promise<StudioProcess[]> {
    const payload = await this.invoke<{ processes?: unknown }>("list", {});
    const raw = Array.isArray(payload.processes)
      ? payload.processes
      : payload.processes
        ? [payload.processes]
        : [];
    return raw
      .map((entry) => entry as { pid?: number; name?: string; windowTitle?: string; executablePath?: string })
      .filter((entry) => typeof entry.pid === "number")
      .map((entry) => ({
        pid: entry.pid as number,
        name: entry.name ?? STUDIO_PROCESS_NAMES[0],
        windowTitle: entry.windowTitle || undefined,
        executablePath: entry.executablePath || undefined,
      }));
  }

  async launch(request: LaunchRequest): Promise<LaunchOutcome> {
    const args: string[] = [];
    if (request.placeFilePath) {
      args.push("-task", "EditFile", "-localPlaceFile", request.placeFilePath);
    } else if (request.placeId !== undefined) {
      args.push("-task", "EditPlace", "-placeId", String(request.placeId));
    }
    const pid = await this.options.runner.spawnDetached(request.executablePath, args);
    log.info(`Launched Roblox Studio`, { pid, args });
    return { pid, command: request.executablePath, args };
  }

  async close(force: boolean): Promise<{ closed: number; forced: boolean }> {
    const payload = await this.invoke<{ closed?: number; forced?: boolean }>("close", {
      MCP_FORCE: force ? "1" : "0",
    });
    return { closed: payload.closed ?? 0, forced: payload.forced === true };
  }

  async focus(): Promise<WindowInfo> {
    const payload = await this.invoke<WindowPayload>("focus", {});
    return this.toWindowInfo(payload);
  }

  async sendKeys(stroke: KeyStroke): Promise<void> {
    await this.invoke("keys", { MCP_KEYS: toSendKeys(stroke) });
  }

  async capture(request: CaptureRequest): Promise<CaptureOutcome> {
    const payload = await this.invoke<{
      path?: string;
      width?: number;
      height?: number;
      scaled?: boolean;
      via?: string;
    }>("capture", {
      MCP_OUT: request.outputPath,
      MCP_MAXWIDTH: String(request.maxWidth),
      MCP_FULLSCREEN: request.fullScreen ? "1" : "0",
    });
    return {
      path: payload.path ?? request.outputPath,
      width: payload.width ?? 0,
      height: payload.height ?? 0,
      scaled: payload.scaled === true,
      via: payload.via ?? "System.Drawing",
    };
  }

  private toWindowInfo(payload: WindowPayload): WindowInfo {
    return {
      title: payload.title ?? "",
      x: payload.x ?? 0,
      y: payload.y ?? 0,
      width: payload.width ?? 0,
      height: payload.height ?? 0,
      focused: payload.focused === true,
      windowId: payload.windowId,
    };
  }

  private async resolvePowerShell(): Promise<string> {
    if (this.powerShellExecutable) return this.powerShellExecutable;
    for (const candidate of ["powershell.exe", "pwsh.exe"]) {
      if (await this.options.runner.which(candidate)) {
        this.powerShellExecutable = candidate;
        return candidate;
      }
    }
    throw new NativeUnavailableError(
      "Neither powershell.exe nor pwsh.exe is available on PATH, so Windows window control, input " +
        "simulation and screenshots cannot run.",
    );
  }

  /** Run one toolkit mode and parse its JSON result. */
  private async invoke<T>(mode: string, env: Record<string, string>): Promise<T> {
    const shell = await this.resolvePowerShell();
    const result = await this.options.runner.run(
      shell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", this.encodedToolkit],
      { env: { ...env, MCP_MODE: mode }, timeoutMs: 40_000 },
    );

    if (result.missing) {
      this.powerShellExecutable = null;
      throw new NativeUnavailableError(`${shell} could not be executed.`);
    }
    if (result.timedOut) {
      throw new NativeOperationError(`PowerShell ${mode} timed out after 40s.`);
    }
    if (result.code !== 0) {
      const stderr = result.stderr.trim();
      if (stderr.includes("NO_STUDIO_WINDOW")) {
        throw new NativeOperationError(
          "No Roblox Studio window was found. Launch Studio (launch_studio) and make sure it is not minimized " +
            "to the system tray.",
        );
      }
      const notStudio = /WINDOW_NOT_STUDIO:(.*)/.exec(stderr);
      if (notStudio) {
        throw new NativeOperationError(
          `Refusing to send input: the focused window is "${notStudio[1].trim()}", which is not Roblox Studio.`,
        );
      }
      throw new NativeOperationError(`PowerShell ${mode} failed (exit ${result.code}): ${stderr || "no output"}`);
    }

    const text = result.stdout.trim();
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new NativeOperationError(`PowerShell ${mode} returned unparseable output: ${text.slice(0, 400)}`);
    }
  }
}
