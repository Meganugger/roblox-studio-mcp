import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isEnumShorthand, isTaggedValue, isValidInstancePath, rbx } from "@roblox-studio-mcp/shared";

const ROOT = new URL("..", import.meta.url).pathname;

describe("shared property encoding", () => {
  it("constructs tagged values", () => {
    expect(rbx.vector3(1, 2, 3)).toEqual({ $type: "Vector3", value: [1, 2, 3] });
    expect(rbx.enum("Material", "Neon")).toEqual({ $type: "EnumItem", value: "Enum.Material.Neon" });
    expect(isTaggedValue(rbx.color3(1, 0, 0))).toBe(true);
    expect(isTaggedValue({ $type: "Bogus", value: 1 })).toBe(false);
    expect(isTaggedValue("hello")).toBe(false);
  });

  it("recognizes enum shorthand strings", () => {
    expect(isEnumShorthand("Enum.Material.Grass")).toBe(true);
    expect(isEnumShorthand("Enum.Font.Gotham Bold")).toBe(true);
    expect(isEnumShorthand("Material.Grass")).toBe(false);
    expect(isEnumShorthand(42)).toBe(false);
  });

  it("validates instance paths", () => {
    expect(isValidInstancePath("game")).toBe(true);
    expect(isValidInstancePath("game.Workspace.Map.Spawn Point")).toBe(true);
    expect(isValidInstancePath("game/Workspace/Part[2]")).toBe(true);
    expect(isValidInstancePath("Workspace.Part")).toBe(false);
    expect(isValidInstancePath("game.Work;space")).toBe(false);
    expect(isValidInstancePath("game." + "a".repeat(3000))).toBe(false);
  });
});

describe("plugin build", () => {
  it("packs the plugin into a valid rbxmx model", () => {
    execFileSync("node", [join(ROOT, "scripts/build-plugin.mjs")], { stdio: "pipe" });
    const artifact = join(ROOT, "studio-plugin/dist/RobloxStudioMCP.rbxmx");
    expect(existsSync(artifact)).toBe(true);

    const xml = readFileSync(artifact, "utf8");
    expect(xml.startsWith("<roblox version=\"4\">")).toBe(true);
    expect(xml.trimEnd().endsWith("</roblox>")).toBe(true);

    // The tree must mirror the source layout.
    for (const expected of [
      'class="Script"',
      ">Main<",
      ">Bridge<",
      ">Config<",
      ">Executors<",
      ">Instances<",
      ">Scripts<",
      ">RunCode<",
      ">Playtest<",
      ">World<",
      ">Project<",
      ">Serialization<",
      ">PathResolver<",
      ">OutputCapture<",
      ">UI<",
      ">Logger<",
    ]) {
      expect(xml, `missing ${expected}`).toContain(expected);
    }

    // Balanced Item tags and XML-escaped sources.
    const opens = xml.match(/<Item /g)?.length ?? 0;
    const closes = xml.match(/<\/Item>/g)?.length ?? 0;
    expect(opens).toBe(closes);
    expect(opens).toBeGreaterThanOrEqual(15);
    // No raw comparison operators may survive inside sources.
    const sources = xml.match(/<ProtectedString name="Source">([\s\S]*?)<\/ProtectedString>/g) ?? [];
    for (const block of sources) {
      const inner = block.slice(block.indexOf(">") + 1, block.lastIndexOf("<"));
      expect(inner).not.toMatch(/<(?!\/ProtectedString)/);
    }
  });
});
