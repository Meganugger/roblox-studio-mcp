import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildInstallPlan, getScaffold, resolveInstallOrder, SCAFFOLDS } from "../server/src/scaffolds/index.js";

describe("scaffold registry", () => {
  it("has unique ids and non-empty metadata", () => {
    const ids = SCAFFOLDS.map((scaffold) => scaffold.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scaffold of SCAFFOLDS) {
      expect(scaffold.title.length).toBeGreaterThan(3);
      expect(scaffold.description.length).toBeGreaterThan(20);
      expect(scaffold.files.length).toBeGreaterThan(0);
    }
  });

  it("declares only known dependencies", () => {
    for (const scaffold of SCAFFOLDS) {
      for (const dep of scaffold.dependencies) {
        expect(getScaffold(dep), `${scaffold.id} depends on unknown ${dep}`).toBeDefined();
      }
    }
  });

  it("produces complete Luau sources with no placeholders", () => {
    for (const scaffold of SCAFFOLDS) {
      for (const file of scaffold.files) {
        if (file.className === "Folder") {
          expect(file.source).toBeUndefined();
          continue;
        }
        expect(file.source, `${scaffold.id}/${file.name} missing source`).toBeDefined();
        const source = file.source as string;
        expect(source.length).toBeGreaterThan(200);
        expect(source).not.toMatch(/\bTODO\b|\bFIXME\b|\bPLACEHOLDER\b/);
        // Every module/script starts in strict mode.
        expect(source.startsWith("--!strict")).toBe(true);
      }
    }
  });

  it("resolves dependency order (dependencies first)", () => {
    const order = resolveInstallOrder(["shop"]).map((scaffold) => scaffold.id);
    expect(order.indexOf("core")).toBeLessThan(order.indexOf("data-profiles"));
    expect(order.indexOf("data-profiles")).toBeLessThan(order.indexOf("currency"));
    expect(order.indexOf("currency")).toBeLessThan(order.indexOf("shop"));
    expect(order.indexOf("inventory")).toBeLessThan(order.indexOf("shop"));
  });

  it("rejects unknown scaffold ids with a helpful message", () => {
    expect(() => resolveInstallOrder(["does-not-exist"])).toThrow(/Unknown scaffold/);
  });

  it("builds a deduplicated install plan with folder chains", () => {
    const plan = buildInstallPlan(resolveInstallOrder(["currency", "settings"]));
    const keys = plan.map((file) => `${file.parentPath}::${file.name}`);
    expect(new Set(keys).size).toBe(keys.length);

    // Folder chain for ServerScriptService.Server.Services must be present
    // and ordered before the services that live inside it.
    const serverFolderIndex = keys.indexOf("game.ServerScriptService::Server");
    const servicesFolderIndex = keys.indexOf("game.ServerScriptService.Server::Services");
    const currencyIndex = keys.indexOf("game.ServerScriptService.Server.Services::CurrencyService");
    expect(serverFolderIndex).toBeGreaterThanOrEqual(0);
    expect(servicesFolderIndex).toBeGreaterThan(serverFolderIndex);
    expect(currencyIndex).toBeGreaterThan(servicesFolderIndex);
  });

  it("installing everything at once yields a valid plan", () => {
    const plan = buildInstallPlan(resolveInstallOrder(SCAFFOLDS.map((scaffold) => scaffold.id)));
    expect(plan.length).toBeGreaterThan(20);
    for (const file of plan) {
      expect(file.parentPath.startsWith("game.")).toBe(true);
    }
  });

  // Runs only when the official Luau compiler is available on PATH or /tmp.
  const luauCompile = process.env.LUAU_COMPILE_BIN ?? "/tmp/luau-compile";
  it.skipIf(!canRun(luauCompile))("every template compiles with the official Luau compiler", () => {
    const dir = mkdtempSync(join(tmpdir(), "scaffold-luau-"));
    for (const scaffold of SCAFFOLDS) {
      for (const file of scaffold.files) {
        if (!file.source) continue;
        const path = join(dir, `${scaffold.id}__${file.name}.luau`);
        writeFileSync(path, file.source);
        expect(
          () => execFileSync(luauCompile, ["--binary", path], { stdio: "pipe" }),
          `${scaffold.id}/${file.name} failed to compile`,
        ).not.toThrow();
      }
    }
  });
});

function canRun(bin: string): boolean {
  try {
    execFileSync(bin, ["--help"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
