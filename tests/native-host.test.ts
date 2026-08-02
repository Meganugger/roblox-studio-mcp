/**
 * NativeHost tests: the security gates, the shortcut allowlist, screenshot
 * handling and the capability report - the parts that must behave identically
 * on every OS.
 */
import { describe, expect, it } from "vitest";
import { NativeHost, MAX_INLINE_IMAGE_BYTES } from "../server/src/native/host.js";
import { NativeUnavailableError } from "../server/src/native/types.js";
import { FakeCommandRunner, FakeFileSystem } from "./helpers/fake-native.js";
import { makeNativeConfig } from "./helpers/test-context.js";

const SCREENSHOT_DIR = "/tmp/mcp-shots";

interface HostSetup {
  platform?: NodeJS.Platform;
  allowNative?: boolean;
  allowNativeInput?: boolean;
  studioPath?: string;
  /** Bytes the capture "writes"; 0 simulates a failed capture. */
  captureBytes?: number;
}

function setupHost(setup: HostSetup = {}) {
  const fs = new FakeFileSystem();
  const runner = new FakeCommandRunner();
  runner.available = ["xdotool", "pgrep", "pkill", "import", "identify", "convert"];
  runner
    .onRun((call) => {
      if (call.program === "xdotool" && call.args[0] === "search") return { code: 0, stdout: "42\n" };
      if (call.program === "xdotool" && call.args[0] === "getwindowgeometry") {
        return { code: 0, stdout: "WINDOW=42\nX=0\nY=0\nWIDTH=1920\nHEIGHT=1080\n" };
      }
      if (call.program === "xdotool" && call.args[0] === "getwindowname") {
        return { code: 0, stdout: "MyGame - Roblox Studio\n" };
      }
      if (call.program === "xdotool" && call.args[0] === "getactivewindow") return { code: 0, stdout: "42\n" };
      return undefined;
    })
    .onRun((call) => {
      // `import` writes the PNG; mirror that into the fake file system.
      if (call.program !== "import") return undefined;
      const outputPath = call.args.at(-1) as string;
      const bytes = setup.captureBytes ?? 2048;
      if (bytes > 0) fs.addFile(outputPath, "P".repeat(bytes));
      return { code: 0, stdout: "" };
    })
    .onRun((call) => (call.program === "identify" ? { code: 0, stdout: "1280 720\n" } : undefined));

  const host = new NativeHost({
    platform: setup.platform ?? "linux",
    runner,
    fs,
    env: { DISPLAY: ":0" },
    homeDir: "/home/dev",
    config: makeNativeConfig({
      allowNative: setup.allowNative ?? true,
      allowNativeInput: setup.allowNativeInput ?? true,
      studioPath: setup.studioPath,
      screenshotDir: SCREENSHOT_DIR,
    }),
  });
  return { host, runner, fs };
}

describe("NativeHost gates", () => {
  it("blocks every native operation when native control is disabled, with the exact env var", async () => {
    const { host, runner } = setupHost({ allowNative: false });
    for (const operation of [
      () => host.focusWindow(),
      () => host.studioProcesses(),
      () => host.closeStudio(false),
      () => host.sendShortcut("save"),
      () => host.captureScreenshot({ maxWidth: 800, fullScreen: false, inline: true }),
      () => host.launchStudio({}),
    ]) {
      await expect(operation()).rejects.toThrow(/ROBLOX_MCP_ALLOW_NATIVE=1/);
    }
    // Nothing was executed on the machine.
    expect(runner.calls).toHaveLength(0);
    expect(runner.spawns).toHaveLength(0);
  });

  it("blocks only input when input simulation is disabled", async () => {
    const { host } = setupHost({ allowNativeInput: false });
    await expect(host.sendShortcut("play")).rejects.toThrow(/ROBLOX_MCP_ALLOW_NATIVE_INPUT=0/);
    // Window control and capture still work.
    await expect(host.focusWindow()).resolves.toMatchObject({ title: "MyGame - Roblox Studio" });
    await expect(
      host.captureScreenshot({ maxWidth: 800, fullScreen: false, inline: false }),
    ).resolves.toMatchObject({ width: 1280 });
  });

  it("reports gates and notes in the capability report without throwing", async () => {
    const { host } = setupHost({ allowNative: false });
    const capabilities = await host.capabilities();
    expect(capabilities.gates).toEqual({ nativeControl: false, inputSimulation: false });
    expect(capabilities.notes.join(" ")).toMatch(/ROBLOX_MCP_ALLOW_NATIVE=0/);
    expect(capabilities.shortcuts.map((shortcut) => shortcut.name)).toContain("play");
  });

  it("describes unsupported platforms instead of crashing", async () => {
    const { host } = setupHost({ platform: "freebsd" });
    const capabilities = await host.capabilities();
    expect(capabilities.supported).toBe(false);
    expect(capabilities.backend).toBeNull();
    expect(capabilities.notes.join(" ")).toMatch(/No native backend exists for platform "freebsd"/);
    await expect(host.focusWindow()).rejects.toThrow(NativeUnavailableError);
  });

  it("reports a missing Studio install with an actionable hint", async () => {
    const { host } = setupHost();
    const capabilities = await host.capabilities();
    expect(capabilities.studio.executablePath).toBeNull();
    expect(capabilities.notes.join(" ")).toMatch(/ROBLOX_MCP_STUDIO_PATH/);
    await expect(host.launchStudio({})).rejects.toThrow(/Roblox Studio was not found/);
  });

  it("launches Studio when an explicit path is configured", async () => {
    const { host, fs, runner } = setupHost({ studioPath: "/opt/studio/RobloxStudioBeta.exe" });
    fs.addFile("/opt/studio/RobloxStudioBeta.exe", "exe");
    const launch = await host.launchStudio({ placeFilePath: "/home/dev/places/Game.rbxlx" });
    expect(launch).toMatchObject({ executablePath: "/opt/studio/RobloxStudioBeta.exe", pid: 4242 });
    expect(runner.spawns[0].args).toEqual(["/home/dev/places/Game.rbxlx"]);
  });
});

describe("NativeHost shortcuts", () => {
  it("focuses Studio before sending keys and reports the platform key combo", async () => {
    const { host, runner } = setupHost();
    const result = await host.sendShortcut("save");
    expect(result).toMatchObject({ shortcut: "save", keys: "Ctrl+S" });
    const xdotoolArgs = runner.callsTo("xdotool").map((call) => call.args.join(" "));
    expect(xdotoolArgs.some((args) => args.startsWith("windowactivate"))).toBe(true);
    expect(xdotoolArgs).toContain("key --clearmodifiers ctrl+s");
  });

  it("uses Command instead of Ctrl on macOS", async () => {
    const runner = new FakeCommandRunner();
    runner.available = ["osascript", "screencapture", "sips", "pgrep"];
    const host = new NativeHost({
      platform: "darwin",
      runner,
      fs: new FakeFileSystem(),
      homeDir: "/Users/dev",
      config: makeNativeConfig({ screenshotDir: SCREENSHOT_DIR }),
    });
    runner.onRun((call) =>
      call.program === "osascript" && call.args[1].includes("position of window 1")
        ? { code: 0, stdout: "0|0|1600|900|true|Game - Roblox Studio" }
        : undefined,
    );
    const result = await host.sendShortcut("save");
    expect(result.keys).toBe("Command+S");
  });
});

describe("NativeHost screenshots", () => {
  it("writes into the configured directory with a sanitized label and inlines the PNG", async () => {
    const { host } = setupHost();
    const shot = await host.captureScreenshot({
      maxWidth: 1280,
      fullScreen: false,
      label: "lobby/../after lighting!",
      inline: true,
    });
    expect(shot.path.startsWith(`${SCREENSHOT_DIR}/`)).toBe(true);
    expect(shot.path).toMatch(/lobby_.._after_lighting_-\d{4}-\d{2}-\d{2}T[\d-]+Z\.png$/);
    expect(shot.inlined).toBe(true);
    expect(Buffer.from(shot.base64 as string, "base64").length).toBe(shot.bytes);
    expect(shot.bytes).toBeLessThan(MAX_INLINE_IMAGE_BYTES);
  });

  it("skips inlining when asked to", async () => {
    const { host } = setupHost();
    const shot = await host.captureScreenshot({ maxWidth: 1280, fullScreen: false, inline: false });
    expect(shot.inlined).toBe(false);
    expect(shot.base64).toBeUndefined();
    expect(shot.bytes).toBeGreaterThan(0);
  });

  it("fails clearly when the capture tool produced no image", async () => {
    const { host } = setupHost({ captureBytes: 0 });
    await expect(host.captureScreenshot({ maxWidth: 1280, fullScreen: false, inline: true })).rejects.toThrow(
      /produced no image/,
    );
  });

  it("does not inline images above the size limit", async () => {
    const { host } = setupHost({ captureBytes: MAX_INLINE_IMAGE_BYTES + 1 });
    const shot = await host.captureScreenshot({ maxWidth: 3840, fullScreen: true, inline: true });
    expect(shot.inlined).toBe(false);
    expect(shot.base64).toBeUndefined();
  });
});
