/**
 * Place-file tests: the generated .rbxlx must be well-formed Roblox XML with
 * the right services/instances, and every path must stay inside the sandbox.
 */
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { NodeHostFileSystem } from "../server/src/native/runner.js";
import {
  buildPlaceXml,
  createPlaceFile,
  describePlaceFile,
  listPlaceFiles,
  PLACE_TEMPLATES,
  PlacePathError,
  resolvePlaceDirectory,
  resolvePlacePath,
} from "../server/src/native/places.js";

const fs = new NodeHostFileSystem();

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  isArray: (name) => name === "Item" || name === "External",
});

interface XmlItem {
  "@class": string;
  "@referent": string;
  Properties: Record<string, unknown>;
  Item?: XmlItem[];
}

function parsePlace(xml: string): { Item: XmlItem[] } {
  const parsed = parser.parse(xml) as { roblox: { Item: XmlItem[] } };
  return parsed.roblox;
}

/** Read a named property of any XML type out of a parsed Properties bag. */
function property(item: XmlItem, name: string): unknown {
  for (const value of Object.values(item.Properties)) {
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      if (entry && typeof entry === "object" && (entry as Record<string, unknown>)["@name"] === name) {
        return entry;
      }
    }
  }
  return undefined;
}

function scalar(item: XmlItem, name: string): unknown {
  const node = property(item, name) as Record<string, unknown> | undefined;
  return node ? node["#text"] : undefined;
}

describe("place file generation", () => {
  it("produces well-formed XML for every template", () => {
    for (const template of PLACE_TEMPLATES) {
      const xml = buildPlaceXml(template.id);
      expect(xml.startsWith('<roblox xmlns:xmime=')).toBe(true);
      expect(xml.trimEnd().endsWith("</roblox>")).toBe(true);
      expect(() => parsePlace(xml)).not.toThrow();

      const services = parsePlace(xml).Item.map((item) => item["@class"]);
      expect(services).toEqual(["Workspace", "Lighting"]);

      // Referents must be unique or Studio rejects the file.
      const referents = xml.match(/referent="([^"]+)"/g) ?? [];
      expect(new Set(referents).size).toBe(referents.length);
    }
  });

  it("builds the baseplate template with a locked baseplate and a spawn on top", () => {
    const place = parsePlace(buildPlaceXml("baseplate"));
    const workspace = place.Item.find((item) => item["@class"] === "Workspace") as XmlItem;
    const children = workspace.Item ?? [];
    expect(children.map((child) => child["@class"])).toEqual(["Part", "SpawnLocation"]);

    const baseplate = children[0];
    expect(scalar(baseplate, "Name")).toBe("Baseplate");
    expect(scalar(baseplate, "Anchored")).toBe(true);
    expect(scalar(baseplate, "Locked")).toBe(true);
    const size = property(baseplate, "size") as Record<string, number>;
    expect([size.X, size.Y, size.Z]).toEqual([512, 20, 512]);
    const cframe = property(baseplate, "CFrame") as Record<string, number>;
    expect([cframe.X, cframe.Y, cframe.Z]).toEqual([0, -10, 0]);
    // Identity rotation.
    expect([cframe.R00, cframe.R11, cframe.R22]).toEqual([1, 1, 1]);
    // Medium stone grey (163,162,165) packed as 0xFFA3A2A5.
    expect(scalar(baseplate, "Color3uint8")).toBe(4288914085);
    expect(scalar(baseplate, "Material")).toBe(256);

    const spawn = children[1];
    const spawnCFrame = property(spawn, "CFrame") as Record<string, number>;
    expect(spawnCFrame.Y).toBe(0.5);
    expect(scalar(spawn, "Locked")).toBe(false);
  });

  it("builds the flat template with a large grass ground", () => {
    const place = parsePlace(buildPlaceXml("flat"));
    const workspace = place.Item.find((item) => item["@class"] === "Workspace") as XmlItem;
    const ground = (workspace.Item ?? [])[0];
    expect(scalar(ground, "Name")).toBe("Ground");
    const size = property(ground, "size") as Record<string, number>;
    expect([size.X, size.Y, size.Z]).toEqual([2048, 4, 2048]);
    expect(scalar(ground, "Material")).toBe(1280); // Enum.Material.Grass
  });

  it("builds the empty template with no geometry", () => {
    const place = parsePlace(buildPlaceXml("empty"));
    const workspace = place.Item.find((item) => item["@class"] === "Workspace") as XmlItem;
    expect(workspace.Item).toBeUndefined();
    const lighting = place.Item.find((item) => item["@class"] === "Lighting") as XmlItem;
    expect(scalar(lighting, "Technology")).toBe(3); // ShadowMap
    expect(scalar(lighting, "ClockTime")).toBe(14.5);
  });

  it("is deterministic across calls", () => {
    expect(buildPlaceXml("baseplate")).toBe(buildPlaceXml("baseplate"));
  });
});

describe("place path sandboxing", () => {
  const root = join(tmpdir(), "sandbox-root");
  const defaultDir = join(root, "places");
  const options = { root, defaultDir };

  it("resolves bare names into the places directory", () => {
    expect(resolvePlacePath("MyGame.rbxlx", options)).toBe(join(defaultDir, "MyGame.rbxlx"));
  });

  it("accepts absolute paths inside the root", () => {
    const target = join(root, "nested", "Game.rbxl");
    expect(resolvePlacePath(target, options)).toBe(target);
  });

  it("rejects paths outside the sandbox root", () => {
    expect(() => resolvePlacePath("/etc/passwd.rbxlx", options)).toThrow(PlacePathError);
    expect(() => resolvePlacePath(`..${sep}..${sep}escape.rbxlx`, options)).toThrow(/outside the allowed place directory/);
    expect(() => resolvePlaceDirectory("/etc", options)).toThrow(PlacePathError);
  });

  it("rejects paths that are not place files", () => {
    expect(() => resolvePlacePath("notes.txt", options)).toThrow(/must end in/);
    expect(() => resolvePlacePath("model.rbxmx", options)).toThrow(/must end in/);
  });

  it("only allows the XML format when creating places", () => {
    expect(() => resolvePlacePath("Binary.rbxl", { ...options, xmlOnly: true })).toThrow(/\.rbxlx/);
    expect(resolvePlacePath("Xml.rbxlx", { ...options, xmlOnly: true })).toBe(join(defaultDir, "Xml.rbxlx"));
  });

  it("rejects empty paths and NUL bytes", () => {
    expect(() => resolvePlacePath("   ", options)).toThrow(/must not be empty/);
    expect(() => resolvePlacePath("a\0b.rbxlx", options)).toThrow(/NUL byte/);
  });
});

describe("place files on disk", () => {
  it("creates a place file, refuses to clobber, then overwrites on request", () => {
    const directory = mkdtempSync(join(tmpdir(), "mcp-places-"));
    const target = join(directory, "deep", "Sim.rbxlx");

    const created = createPlaceFile({ path: target, template: "baseplate", overwrite: false }, fs);
    expect(created).toMatchObject({ exists: true, format: "xml", template: "baseplate", overwritten: false });
    expect(created.bytes).toBeGreaterThan(500);
    expect(created.services).toEqual(["Workspace", "Part", "SpawnLocation", "Lighting"]);

    expect(() => createPlaceFile({ path: target, template: "flat", overwrite: false }, fs)).toThrow(
      /already exists/,
    );
    const replaced = createPlaceFile({ path: target, template: "flat", overwrite: true }, fs);
    expect(replaced.overwritten).toBe(true);
    expect(replaced.services).toContain("Part");
  });

  it("describes existing, binary, unknown and missing files", () => {
    const directory = mkdtempSync(join(tmpdir(), "mcp-describe-"));
    const xmlPlace = join(directory, "a.rbxlx");
    createPlaceFile({ path: xmlPlace, template: "empty", overwrite: false }, fs);
    expect(describePlaceFile(xmlPlace, fs)).toMatchObject({ exists: true, format: "xml" });

    const binaryPlace = join(directory, "b.rbxl");
    writeFileSync(binaryPlace, "<roblox!\x89\xff\x0d\x0a\x1a\x0a");
    expect(describePlaceFile(binaryPlace, fs).format).toBe("binary");

    const junk = join(directory, "c.rbxlx");
    writeFileSync(junk, "not a place at all");
    expect(describePlaceFile(junk, fs).format).toBe("unknown");

    expect(describePlaceFile(join(directory, "missing.rbxlx"), fs)).toMatchObject({
      exists: false,
      bytes: 0,
      modifiedAt: null,
    });
  });

  it("lists place files newest first, optionally recursing, and flags truncation", () => {
    const directory = mkdtempSync(join(tmpdir(), "mcp-list-"));
    mkdirSync(join(directory, "sub"), { recursive: true });
    const older = join(directory, "older.rbxlx");
    const newer = join(directory, "newer.rbxl");
    const nested = join(directory, "sub", "nested.rbxlx");
    for (const [path, seconds] of [
      [older, 1_000_000],
      [newer, 2_000_000],
      [nested, 1_500_000],
    ] as Array<[string, number]>) {
      writeFileSync(path, "<roblox version=\"4\"></roblox>");
      utimesSync(path, seconds, seconds);
    }
    writeFileSync(join(directory, "ignore.txt"), "nope");

    const shallow = listPlaceFiles({ directory, recursive: false, maxResults: 10 }, fs);
    expect(shallow.files.map((file) => file.name)).toEqual(["newer.rbxl", "older.rbxlx"]);
    expect(shallow.truncated).toBe(false);

    const deep = listPlaceFiles({ directory, recursive: true, maxResults: 10 }, fs);
    expect(deep.files.map((file) => file.name)).toEqual(["newer.rbxl", "nested.rbxlx", "older.rbxlx"]);

    const capped = listPlaceFiles({ directory, recursive: true, maxResults: 1 }, fs);
    expect(capped.files).toHaveLength(1);
    expect(capped.truncated).toBe(true);
  });
});
