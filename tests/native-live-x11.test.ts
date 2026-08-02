/**
 * Live X11 verification of the Linux native backend.
 *
 * Runs the *real* NodeCommandRunner against a real X server (Xvfb) with a real
 * window titled like Studio, proving the backend's command construction works
 * end to end: window discovery, focus, geometry, keystroke delivery, window
 * capture and downscaling. Skipped automatically when no X display or tooling
 * is available (e.g. on a bare CI container), so it never makes CI flaky.
 *
 *   Xvfb :99 & DISPLAY=:99 xclock -title "Live - Roblox Studio" &
 *   DISPLAY=:99 npx vitest run tests/native-live-x11.test.ts
 */
import { execFileSync, spawn, ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LinuxBackend } from "../server/src/native/backends/linux.js";
import { NativeHost } from "../server/src/native/host.js";
import { NodeCommandRunner, NodeHostFileSystem } from "../server/src/native/runner.js";
import { STUDIO_SHORTCUTS } from "../server/src/native/shortcuts.js";

const has = (program: string): boolean => {
  try {
    execFileSync("which", [program], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
};

const display = process.env.DISPLAY;
const tooling = ["xdotool", "import", "identify", "convert", "xclock"].every(has);
const enabled = Boolean(display) && tooling;

describe.skipIf(!enabled)("Linux backend against a live X server", () => {
  const runner = new NodeCommandRunner();
  const fs = new NodeHostFileSystem();
  const backend = new LinuxBackend({ runner, fs, env: process.env });
  let screenshotDir = "";
  let windowProcess: ChildProcess | null = null;

  beforeAll(async () => {
    screenshotDir = mkdtempSync(join(tmpdir(), "live-x11-shots-"));
    // A real X window whose title matches what Studio uses. stdio must be
    // ignored, otherwise the pipes keep this test process waiting.
    windowProcess = spawn(
      "xclock",
      ["-geometry", "800x600+40+50", "-title", "LivePlace - Roblox Studio"],
      { stdio: "ignore", detached: true, env: process.env },
    );
    // Wait for the window to be mapped (there is no window manager here).
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        execFileSync("xdotool", ["search", "--name", "Roblox Studio"], { stdio: "pipe", env: process.env });
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("The test window never appeared on the X display.");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  });

  afterAll(() => {
    windowProcess?.kill("SIGKILL");
  });

  it("probes the host as fully capable", async () => {
    const probe = await backend.probe();
    expect(probe.windowControl.available).toBe(true);
    expect(probe.inputSimulation.available).toBe(true);
    expect(probe.screenshot.available).toBe(true);
    expect(probe.screenshot.via).toBe("import");
  });

  it("finds, activates and measures the real window", async () => {
    const window = await backend.focus();
    expect(window.title).toContain("Roblox Studio");
    expect(window.width).toBeGreaterThan(100);
    expect(window.height).toBeGreaterThan(100);
    expect(window.windowId).toMatch(/^\d+$/);
  });

  it("delivers a real keystroke to the window", async () => {
    // xdotool reports success only if the key was actually sent to the display.
    await expect(backend.sendKeys(STUDIO_SHORTCUTS.escape.stroke)).resolves.toBeUndefined();
  });

  it("captures the window to a real PNG and downscales it", async () => {
    const outputPath = join(screenshotDir, "window.png");
    const outcome = await backend.capture({ outputPath, maxWidth: 400, fullScreen: false });
    expect(existsSync(outputPath)).toBe(true);
    expect(outcome.via).toBe("import");
    expect(outcome.width).toBeLessThanOrEqual(400);
    expect(outcome.height).toBeGreaterThan(0);
    expect(outcome.scaled).toBe(true);
    // A real PNG signature, not an empty or truncated file.
    expect(fs.readFile(outputPath).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("captures the whole screen", async () => {
    const outputPath = join(screenshotDir, "screen.png");
    const outcome = await backend.capture({ outputPath, maxWidth: 0, fullScreen: true });
    expect(outcome.width).toBeGreaterThan(0);
    expect(existsSync(outputPath)).toBe(true);
  });

  it("returns an inlineable PNG through NativeHost", async () => {
    const host = new NativeHost({
      platform: "linux",
      runner,
      fs,
      env: process.env,
      config: { allowNative: true, allowNativeInput: true, screenshotDir },
    });
    const shot = await host.captureScreenshot({ maxWidth: 320, fullScreen: false, label: "live", inline: true });
    expect(shot.inlined).toBe(true);
    expect(shot.width).toBeLessThanOrEqual(320);
    const decoded = Buffer.from(shot.base64 as string, "base64");
    expect(decoded.subarray(1, 4).toString()).toBe("PNG");
    expect(decoded.length).toBe(shot.bytes);
  });

  it("reports real Studio processes as absent", async () => {
    // xclock is not Studio, so nothing should match the Studio process pattern.
    const processes = await backend.listProcesses();
    expect(processes.every((entry) => entry.pid !== windowProcess?.pid)).toBe(true);
  });
});
