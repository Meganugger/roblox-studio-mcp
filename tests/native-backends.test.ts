/**
 * Backend-level tests for the native host layer.
 *
 * Roblox Studio does not exist on the CI host, so what is verified here is
 * everything that *can* be: the exact program + argv each platform invokes, the
 * key translations, the parsing of tool output, and the mapping of failures to
 * actionable errors.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LinuxBackend, toXdotoolKey } from "../server/src/native/backends/linux.js";
import { MacBackend, toAppleScriptKeystroke } from "../server/src/native/backends/macos.js";
import { WindowsBackend, toSendKeys } from "../server/src/native/backends/windows.js";
import { NativeOperationError, NativeUnavailableError } from "../server/src/native/types.js";
import { STUDIO_SHORTCUTS } from "../server/src/native/shortcuts.js";
import { FakeCommandRunner, FakeFileSystem } from "./helpers/fake-native.js";

const LOCAL_APP_DATA = join("C:", "Users", "dev", "AppData", "Local");
const VERSIONS = join(LOCAL_APP_DATA, "Roblox", "Versions");
const STUDIO_EXE = join(VERSIONS, "version-newer", "RobloxStudioBeta.exe");

function windowsBackend(options: {
  runner?: FakeCommandRunner;
  fs?: FakeFileSystem;
  studioPathOverride?: string;
} = {}) {
  const runner = options.runner ?? new FakeCommandRunner();
  runner.available = [...new Set([...runner.available, "powershell.exe", "reg.exe"])];
  const fs = options.fs ?? new FakeFileSystem();
  const backend = new WindowsBackend({
    runner,
    fs,
    env: { LOCALAPPDATA: LOCAL_APP_DATA },
    studioPathOverride: options.studioPathOverride,
  });
  return { backend, runner, fs };
}

/** Reply to the PowerShell toolkit for one mode with the given JSON payload. */
function powerShellJson(mode: string, payload: unknown) {
  return (call: { program: string; options?: { env?: Record<string, string | undefined> } }) =>
    call.program === "powershell.exe" && call.options?.env?.MCP_MODE === mode
      ? { code: 0, stdout: JSON.stringify(payload) }
      : undefined;
}

describe("Windows backend", () => {
  it("translates every allowlisted shortcut into SendKeys syntax", () => {
    expect(toSendKeys(STUDIO_SHORTCUTS.play.stroke)).toBe("{F5}");
    expect(toSendKeys(STUDIO_SHORTCUTS.run.stroke)).toBe("{F8}");
    expect(toSendKeys(STUDIO_SHORTCUTS.stop.stroke)).toBe("+{F5}");
    expect(toSendKeys(STUDIO_SHORTCUTS.save.stroke)).toBe("^s");
    expect(toSendKeys(STUDIO_SHORTCUTS.saveAs.stroke)).toBe("^+s");
    expect(toSendKeys(STUDIO_SHORTCUTS.undo.stroke)).toBe("^z");
    expect(toSendKeys(STUDIO_SHORTCUTS.redo.stroke)).toBe("^+z");
    expect(toSendKeys(STUDIO_SHORTCUTS.escape.stroke)).toBe("{ESC}");
    expect(toSendKeys(STUDIO_SHORTCUTS.confirm.stroke)).toBe("{ENTER}");
  });

  it("rejects keys outside the supported set", () => {
    expect(() => toSendKeys({ key: "{ENTER}(evil)", modifiers: [] })).toThrow(NativeOperationError);
  });

  it("finds the newest installed Studio version", async () => {
    const fs = new FakeFileSystem();
    fs.addDirectory(VERSIONS);
    fs.addFile(join(VERSIONS, "version-older", "RobloxStudioBeta.exe"), "old", 1_000);
    fs.addFile(STUDIO_EXE, "new", 9_000);
    const { backend } = windowsBackend({ fs });
    expect(await backend.findStudio()).toBe(STUDIO_EXE);
  });

  it("falls back to the roblox-studio protocol handler in the registry", async () => {
    const registryPath = join("D:", "Roblox", "Versions", "version-x", "RobloxStudioBeta.exe");
    const fs = new FakeFileSystem().addFile(registryPath, "exe");
    const runner = new FakeCommandRunner().onRun((call) =>
      call.program === "reg.exe"
        ? { code: 0, stdout: `    (Default)    REG_SZ    "${registryPath}" -protocolString %1` }
        : undefined,
    );
    const { backend } = windowsBackend({ fs, runner });
    expect(await backend.findStudio()).toBe(registryPath);
  });

  it("honours ROBLOX_MCP_STUDIO_PATH and rejects a bad override", async () => {
    const fs = new FakeFileSystem().addFile(STUDIO_EXE, "exe");
    const good = windowsBackend({ fs, studioPathOverride: STUDIO_EXE });
    expect(await good.backend.findStudio()).toBe(STUDIO_EXE);

    const bad = windowsBackend({ studioPathOverride: join("C:", "nope.exe") });
    await expect(bad.backend.findStudio()).rejects.toThrow(NativeUnavailableError);
  });

  it("launches Studio with the documented task arguments", async () => {
    const { backend, runner } = windowsBackend();
    const place = join("C:", "places", "Game.rbxlx");

    await backend.launch({ executablePath: STUDIO_EXE, placeFilePath: place });
    expect(runner.spawns.at(-1)).toMatchObject({
      program: STUDIO_EXE,
      args: ["-task", "EditFile", "-localPlaceFile", place],
    });

    await backend.launch({ executablePath: STUDIO_EXE, placeId: 987 });
    expect(runner.spawns.at(-1)?.args).toEqual(["-task", "EditPlace", "-placeId", "987"]);

    await backend.launch({ executablePath: STUDIO_EXE });
    expect(runner.spawns.at(-1)?.args).toEqual([]);
  });

  it("runs the toolkit through -EncodedCommand with inputs in the environment", async () => {
    const runner = new FakeCommandRunner().onRun(
      powerShellJson("focus", {
        title: "MyGame - Roblox Studio",
        windowId: "12345",
        x: 10,
        y: 20,
        width: 1600,
        height: 900,
        focused: true,
      }),
    );
    const { backend } = windowsBackend({ runner });

    const window = await backend.focus();
    expect(window).toMatchObject({ title: "MyGame - Roblox Studio", width: 1600, height: 900, focused: true });

    const call = runner.callsTo("powershell.exe")[0];
    expect(call.args.slice(0, 5)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
    ]);
    // The script is passed base64/UTF-16LE encoded, never string-interpolated.
    const script = Buffer.from(call.args[5], "base64").toString("utf16le");
    expect(script).toContain("SetForegroundWindow");
    expect(script).toContain("$env:MCP_MODE");
    expect(call.options?.env).toMatchObject({ MCP_MODE: "focus" });
  });

  it("sends shortcut keystrokes as SendKeys input", async () => {
    const runner = new FakeCommandRunner().onRun(powerShellJson("keys", { sent: "^s" }));
    const { backend } = windowsBackend({ runner });
    await backend.sendKeys(STUDIO_SHORTCUTS.save.stroke);
    expect(runner.calls.at(-1)?.options?.env).toMatchObject({ MCP_MODE: "keys", MCP_KEYS: "^s" });
  });

  it("passes capture options and parses the capture result", async () => {
    const runner = new FakeCommandRunner().onRun(
      powerShellJson("capture", {
        path: "C:\\shots\\a.png",
        width: 1280,
        height: 720,
        scaled: true,
        via: "System.Drawing",
      }),
    );
    const { backend } = windowsBackend({ runner });
    const outcome = await backend.capture({ outputPath: "C:\\shots\\a.png", maxWidth: 1280, fullScreen: false });
    expect(outcome).toEqual({
      path: "C:\\shots\\a.png",
      width: 1280,
      height: 720,
      scaled: true,
      via: "System.Drawing",
    });
    expect(runner.calls.at(-1)?.options?.env).toMatchObject({
      MCP_MODE: "capture",
      MCP_OUT: "C:\\shots\\a.png",
      MCP_MAXWIDTH: "1280",
      MCP_FULLSCREEN: "0",
    });
  });

  it("explains a missing Studio window instead of leaking PowerShell noise", async () => {
    const runner = new FakeCommandRunner().onRun((call) =>
      call.program === "powershell.exe" ? { code: 1, stderr: "NO_STUDIO_WINDOW" } : undefined,
    );
    const { backend } = windowsBackend({ runner });
    await expect(backend.focus()).rejects.toThrow(/No Roblox Studio window was found/);
  });

  it("refuses to type into a window that is not Studio", async () => {
    const runner = new FakeCommandRunner().onRun((call) =>
      call.program === "powershell.exe" ? { code: 1, stderr: "WINDOW_NOT_STUDIO:Online Banking" } : undefined,
    );
    const { backend } = windowsBackend({ runner });
    await expect(backend.sendKeys(STUDIO_SHORTCUTS.save.stroke)).rejects.toThrow(
      /Refusing to send input.*Online Banking/,
    );
  });

  it("reports missing .NET assemblies as unavailable capabilities", async () => {
    const runner = new FakeCommandRunner().onRun(
      powerShellJson("probe", { powerShell: "7.4.0", forms: false, drawing: false }),
    );
    const { backend } = windowsBackend({ runner });
    const probe = await backend.probe();
    expect(probe.windowControl.available).toBe(true);
    expect(probe.inputSimulation.available).toBe(false);
    expect(probe.inputSimulation.hint).toMatch(/System.Windows.Forms/);
    expect(probe.screenshot.hint).toMatch(/System.Drawing/);
  });

  it("reports no PowerShell as a total unavailability", async () => {
    const runner = new FakeCommandRunner();
    runner.available = [];
    const backend = new WindowsBackend({ runner, fs: new FakeFileSystem(), env: {} });
    const probe = await backend.probe();
    expect(probe.processControl.available).toBe(false);
    expect(probe.notes.join(" ")).toMatch(/No PowerShell interpreter/);
  });

  it("lists Studio processes from the toolkit payload", async () => {
    const runner = new FakeCommandRunner().onRun(
      powerShellJson("list", {
        processes: [
          { pid: 111, name: "RobloxStudioBeta", windowTitle: "Baseplate - Roblox Studio", executablePath: STUDIO_EXE },
        ],
      }),
    );
    const { backend } = windowsBackend({ runner });
    expect(await backend.listProcesses()).toEqual([
      { pid: 111, name: "RobloxStudioBeta", windowTitle: "Baseplate - Roblox Studio", executablePath: STUDIO_EXE },
    ]);
  });
});

describe("macOS backend", () => {
  const APP = "/Applications/RobloxStudio.app";

  function macBackend(options: { runner?: FakeCommandRunner; fs?: FakeFileSystem } = {}) {
    const runner = options.runner ?? new FakeCommandRunner();
    runner.available = [...new Set([...runner.available, "osascript", "screencapture", "sips", "pgrep", "pkill", "open"])];
    const fs = options.fs ?? new FakeFileSystem().addFile(APP, "app");
    return { backend: new MacBackend({ runner, fs, homeDir: "/Users/dev" }), runner, fs };
  }

  it("translates shortcuts into System Events statements", () => {
    expect(toAppleScriptKeystroke(STUDIO_SHORTCUTS.play.stroke)).toBe(
      'tell application "System Events" to key code 96',
    );
    expect(toAppleScriptKeystroke(STUDIO_SHORTCUTS.stop.stroke)).toBe(
      'tell application "System Events" to key code 96 using {shift down}',
    );
    expect(toAppleScriptKeystroke(STUDIO_SHORTCUTS.save.stroke)).toBe(
      'tell application "System Events" to keystroke "s" using {command down}',
    );
    expect(toAppleScriptKeystroke(STUDIO_SHORTCUTS.redo.stroke)).toBe(
      'tell application "System Events" to keystroke "z" using {command down, shift down}',
    );
    expect(toAppleScriptKeystroke(STUDIO_SHORTCUTS.escape.stroke)).toBe(
      'tell application "System Events" to key code 53',
    );
  });

  it("finds the Studio app bundle", async () => {
    const { backend } = macBackend();
    expect(await backend.findStudio()).toBe(APP);
  });

  it("opens place files and cloud places through `open`", async () => {
    const { backend, runner } = macBackend();
    await backend.launch({ executablePath: APP, placeFilePath: "/Users/dev/places/Game.rbxlx" });
    expect(runner.calls.at(-1)).toMatchObject({
      program: "open",
      args: ["-a", APP, "/Users/dev/places/Game.rbxlx"],
    });

    await backend.launch({ executablePath: APP, placeId: 42 });
    expect(runner.calls.at(-1)?.args).toEqual(["roblox-studio:1+launchmode:edit+task:EditPlace+placeId:42"]);
  });

  it("captures the Studio window region and downscales it", async () => {
    const runner = new FakeCommandRunner()
      .onRun((call) =>
        call.program === "osascript" && call.args[1].includes("position of window 1")
          ? { code: 0, stdout: "12|34|1600|900|true|MyGame - Roblox Studio\n" }
          : undefined,
      )
      .onRun((call) =>
        call.program === "sips" && call.args.includes("pixelWidth")
          ? { code: 0, stdout: "  pixelWidth: 1280\n  pixelHeight: 720\n" }
          : undefined,
      );
    const { backend } = macBackend({ runner });

    const outcome = await backend.capture({ outputPath: "/tmp/shot.png", maxWidth: 1280, fullScreen: false });
    expect(outcome).toMatchObject({ path: "/tmp/shot.png", width: 1280, height: 720, scaled: true });

    const capture = runner.callsTo("screencapture")[0];
    expect(capture.args).toEqual(["-x", "-R", "12,34,1600,900", "/tmp/shot.png"]);
    expect(runner.callsTo("sips")[0].args).toEqual(["-Z", "1280", "/tmp/shot.png"]);
  });

  it("captures the whole screen without touching the window", async () => {
    const runner = new FakeCommandRunner().onRun((call) =>
      call.program === "sips" && call.args.includes("pixelWidth")
        ? { code: 0, stdout: "pixelWidth: 2560\npixelHeight: 1440\n" }
        : undefined,
    );
    const { backend } = macBackend({ runner });
    await backend.capture({ outputPath: "/tmp/full.png", maxWidth: 0, fullScreen: true });
    expect(runner.callsTo("screencapture")[0].args).toEqual(["-x", "/tmp/full.png"]);
    expect(runner.callsTo("sips").filter((call) => call.args[0] === "-Z")).toHaveLength(0);
  });

  it("turns a blocked automation request into an actionable permission error", async () => {
    const runner = new FakeCommandRunner().onRun((call) =>
      call.program === "osascript"
        ? { code: 1, stderr: "execution error: Not allowed assistive access. (-1743)" }
        : undefined,
    );
    const { backend } = macBackend({ runner });
    await expect(backend.focus()).rejects.toThrow(/Accessibility permission/);
  });

  it("reports a missing Studio window", async () => {
    const runner = new FakeCommandRunner().onRun((call) =>
      call.program === "osascript" && call.args[1].includes("position of window 1")
        ? { code: 1, stderr: 'execution error: NO_STUDIO_WINDOW (1)' }
        : undefined,
    );
    const { backend } = macBackend({ runner });
    await expect(backend.focus()).rejects.toThrow(/No Roblox Studio window was found/);
  });

  it("lists processes from pgrep", async () => {
    const runner = new FakeCommandRunner().onRun((call) =>
      call.program === "pgrep" ? { code: 0, stdout: "501\n" } : undefined,
    );
    const { backend } = macBackend({ runner });
    const processes = await backend.listProcesses();
    expect(processes[0]).toMatchObject({ pid: 501, name: "RobloxStudio" });
  });

  it("quits Studio gracefully and can force-kill", async () => {
    const runner = new FakeCommandRunner().onRun((call) =>
      call.program === "pgrep" ? { code: 0, stdout: "501\n" } : undefined,
    );
    const { backend } = macBackend({ runner });

    expect(await backend.close(false)).toEqual({ closed: 1, forced: false });
    expect(runner.callsTo("osascript").at(-1)?.args[1]).toBe('tell application "RobloxStudio" to quit');

    expect(await backend.close(true)).toEqual({ closed: 1, forced: true });
    expect(runner.callsTo("pkill").at(-1)?.args).toEqual(["-9", "-x", "RobloxStudio"]);
  });
});

describe("Linux backend", () => {
  function linuxBackend(
    options: { runner?: FakeCommandRunner; env?: Record<string, string | undefined> } = {},
  ) {
    const runner = options.runner ?? new FakeCommandRunner();
    runner.available = [...new Set([...runner.available, "xdotool", "pgrep", "pkill", "import", "identify", "convert"])];
    return {
      backend: new LinuxBackend({
        runner,
        fs: new FakeFileSystem(),
        env: options.env ?? { DISPLAY: ":0" },
      }),
      runner,
    };
  }

  const geometry = (id: string) => ({ code: 0, stdout: `WINDOW=${id}\nX=5\nY=10\nWIDTH=1920\nHEIGHT=1080\n` });

  it("translates shortcuts into xdotool key expressions", () => {
    expect(toXdotoolKey(STUDIO_SHORTCUTS.play.stroke)).toBe("F5");
    expect(toXdotoolKey(STUDIO_SHORTCUTS.stop.stroke)).toBe("shift+F5");
    expect(toXdotoolKey(STUDIO_SHORTCUTS.save.stroke)).toBe("ctrl+s");
    expect(toXdotoolKey(STUDIO_SHORTCUTS.redo.stroke)).toBe("ctrl+shift+z");
    expect(toXdotoolKey(STUDIO_SHORTCUTS.confirm.stroke)).toBe("Return");
  });

  it("activates the Studio window and reports geometry", async () => {
    const runner = new FakeCommandRunner().onRun((call) => {
      if (call.program !== "xdotool") return undefined;
      if (call.args[0] === "search") return { code: 0, stdout: "77\n" };
      if (call.args[0] === "getwindowgeometry") return geometry("77");
      if (call.args[0] === "getwindowname") return { code: 0, stdout: "Game - Roblox Studio\n" };
      if (call.args[0] === "getactivewindow") return { code: 0, stdout: "77\n" };
      return { code: 0, stdout: "" };
    });
    const { backend } = linuxBackend({ runner });

    const window = await backend.focus();
    expect(window).toMatchObject({ title: "Game - Roblox Studio", x: 5, y: 10, width: 1920, height: 1080, focused: true });
    expect(runner.callsTo("xdotool").map((call) => call.args[0])).toContain("windowactivate");
    expect(runner.callsTo("xdotool").find((call) => call.args[0] === "search")?.args).toEqual([
      "search",
      "--name",
      "Roblox Studio",
    ]);
  });

  it("refuses to send input when the window is not Studio", async () => {
    const runner = new FakeCommandRunner().onRun((call) => {
      if (call.program !== "xdotool") return undefined;
      if (call.args[0] === "search") return { code: 0, stdout: "77\n" };
      if (call.args[0] === "getwindowgeometry") return geometry("77");
      if (call.args[0] === "getwindowname") return { code: 0, stdout: "Password Manager\n" };
      return { code: 0, stdout: "" };
    });
    const { backend } = linuxBackend({ runner });
    await expect(backend.sendKeys(STUDIO_SHORTCUTS.save.stroke)).rejects.toThrow(/not Roblox Studio/);
    expect(runner.callsTo("xdotool").some((call) => call.args[0] === "key")).toBe(false);
  });

  it("captures a window with ImageMagick and resizes it", async () => {
    const runner = new FakeCommandRunner().onRun((call) => {
      if (call.program === "xdotool" && call.args[0] === "search") return { code: 0, stdout: "77\n" };
      if (call.program === "identify") return { code: 0, stdout: "1280 720\n" };
      return undefined;
    });
    const { backend } = linuxBackend({ runner });

    const outcome = await backend.capture({ outputPath: "/tmp/x.png", maxWidth: 1280, fullScreen: false });
    expect(outcome).toMatchObject({ width: 1280, height: 720, scaled: true, via: "import" });
    expect(runner.callsTo("import")[0].args).toEqual(["-window", "77", "/tmp/x.png"]);
    expect(runner.callsTo("convert")[0].args).toEqual(["/tmp/x.png", "-resize", "1280x>", "/tmp/x.png"]);
  });

  it("captures the root window for full-screen captures", async () => {
    const runner = new FakeCommandRunner().onRun((call) =>
      call.program === "identify" ? { code: 0, stdout: "800 600\n" } : undefined,
    );
    const { backend } = linuxBackend({ runner });
    await backend.capture({ outputPath: "/tmp/root.png", maxWidth: 0, fullScreen: true });
    expect(runner.callsTo("import")[0].args).toEqual(["-window", "root", "/tmp/root.png"]);
  });

  it("falls back to focus+raise when no window manager supports activation", async () => {
    // Bare X servers and minimal WMs reject windowactivate; input must still work.
    const runner = new FakeCommandRunner().onRun((call) => {
      if (call.program !== "xdotool") return undefined;
      switch (call.args[0]) {
        case "search":
          return { code: 0, stdout: "77\n" };
        case "getwindowgeometry":
          return geometry("77");
        case "getwindowname":
          return { code: 0, stdout: "Game - Roblox Studio\n" };
        case "windowactivate":
          return { code: 1, stderr: "Your windowmanager claims not to support _NET_ACTIVE_WINDOW" };
        default:
          return { code: 0, stdout: "" };
      }
    });
    const { backend } = linuxBackend({ runner });

    await backend.sendKeys(STUDIO_SHORTCUTS.play.stroke);
    const args = runner.callsTo("xdotool").map((call) => call.args.join(" "));
    expect(args).toContain("windowfocus --sync 77");
    expect(args).toContain("windowraise 77");
    expect(args).toContain("key --clearmodifiers F5");
  });

  it("addresses the window directly when it cannot be focused at all", async () => {
    const runner = new FakeCommandRunner().onRun((call) => {
      if (call.program !== "xdotool") return undefined;
      switch (call.args[0]) {
        case "search":
          return { code: 0, stdout: "77\n" };
        case "getwindowgeometry":
          return geometry("77");
        case "getwindowname":
          return { code: 0, stdout: "Game - Roblox Studio\n" };
        case "windowactivate":
        case "windowfocus":
          return { code: 1, stderr: "no window manager" };
        default:
          return { code: 0, stdout: "" };
      }
    });
    const { backend } = linuxBackend({ runner });

    await backend.sendKeys(STUDIO_SHORTCUTS.play.stroke);
    const args = runner.callsTo("xdotool").map((call) => call.args.join(" "));
    expect(args).toContain("key --window 77 --clearmodifiers F5");
    expect(args).not.toContain("key --clearmodifiers F5");
  });

  it("still captures a window that could not be activated", async () => {
    const runner = new FakeCommandRunner().onRun((call) => {
      if (call.program === "xdotool" && call.args[0] === "search") return { code: 0, stdout: "77\n" };
      if (call.program === "xdotool" && call.args[0] === "windowactivate") return { code: 1, stderr: "no WM" };
      if (call.program === "identify") return { code: 0, stdout: "640 480\n" };
      return undefined;
    });
    const { backend } = linuxBackend({ runner });
    const outcome = await backend.capture({ outputPath: "/tmp/nowm.png", maxWidth: 0, fullScreen: false });
    expect(outcome).toMatchObject({ width: 640, height: 480 });
    expect(runner.callsTo("import")[0].args).toEqual(["-window", "77", "/tmp/nowm.png"]);
  });

  it("explains missing tooling and headless hosts", async () => {
    const runner = new FakeCommandRunner();
    runner.available = ["pgrep"];
    const backend = new LinuxBackend({ runner, fs: new FakeFileSystem(), env: {} });
    const probe = await backend.probe();
    expect(probe.windowControl.available).toBe(false);
    expect(probe.windowControl.hint).toMatch(/xdotool/);
    expect(probe.screenshot.hint).toMatch(/ImageMagick/);
    expect(probe.notes.join(" ")).toMatch(/headless host/);
    await expect(backend.focus()).rejects.toThrow(NativeUnavailableError);
  });

  it("marks capabilities unavailable on Wayland without XWayland", async () => {
    const { backend } = linuxBackend({ env: { WAYLAND_DISPLAY: "wayland-0" } });
    const probe = await backend.probe();
    expect(probe.notes.join(" ")).toMatch(/Wayland/);
    expect(probe.windowControl.available).toBe(false);
  });

  it("requires ROBLOX_MCP_STUDIO_PATH because Studio has no Linux build", async () => {
    const { backend } = linuxBackend();
    expect(await backend.findStudio()).toBeNull();
  });
});
