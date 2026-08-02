import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { HostFileSystem } from "./types.js";

/**
 * Local place-file support: generate real `.rbxlx` places from templates,
 * validate/describe existing place files, and keep every path inside a
 * configured sandbox root.
 *
 * `.rbxlx` is Roblox's XML place format: the document root holds one `<Item>`
 * per service. Services that are omitted are created by Studio on load, so a
 * template only needs to describe what makes it distinctive.
 */

export const PLACE_EXTENSIONS = [".rbxlx", ".rbxl"] as const;

export type PlaceTemplateId = "baseplate" | "flat" | "empty";

export interface PlaceTemplate {
  id: PlaceTemplateId;
  title: string;
  description: string;
}

export const PLACE_TEMPLATES: readonly PlaceTemplate[] = [
  {
    id: "baseplate",
    title: "Baseplate",
    description:
      "Roblox's classic starting point: a 512x20x512 anchored, locked Baseplate at y=-10 with a SpawnLocation " +
      "on top and daylight lighting. Best default for building a game from scratch.",
  },
  {
    id: "flat",
    title: "Large flat ground",
    description:
      "A 2048x4x2048 grass ground plane with a SpawnLocation and daylight lighting - room for a full map, " +
      "obby or simulator world without generating terrain first.",
  },
  {
    id: "empty",
    title: "Empty place",
    description:
      "Only Workspace and Lighting, with no geometry at all. Use it when the agent will generate terrain or " +
      "build the whole environment itself.",
  },
];

export class PlacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlacePathError";
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Serialized-property helpers, using Roblox's XML property names. */
const xml = {
  string: (name: string, value: string) => `<string name="${name}">${escapeXml(value)}</string>`,
  bool: (name: string, value: boolean) => `<bool name="${name}">${value ? "true" : "false"}</bool>`,
  float: (name: string, value: number) => `<float name="${name}">${value}</float>`,
  token: (name: string, value: number) => `<token name="${name}">${value}</token>`,
  vector3: (name: string, [x, y, z]: [number, number, number]) =>
    `<Vector3 name="${name}"><X>${x}</X><Y>${y}</Y><Z>${z}</Z></Vector3>`,
  /** Identity-rotation CFrame at the given position (templates never rotate). */
  cframe: (name: string, [x, y, z]: [number, number, number]) =>
    `<CoordinateFrame name="${name}"><X>${x}</X><Y>${y}</Y><Z>${z}</Z>` +
    `<R00>1</R00><R01>0</R01><R02>0</R02>` +
    `<R10>0</R10><R11>1</R11><R12>0</R12>` +
    `<R20>0</R20><R21>0</R21><R22>1</R22></CoordinateFrame>`,
  color3: (name: string, [r, g, b]: [number, number, number]) =>
    `<Color3 name="${name}"><R>${r}</R><G>${g}</G><B>${b}</B></Color3>`,
  /** Modern BasePart colour property: 0xAARRGGBB packed into a uint32. */
  color3uint8: (name: string, [r, g, b]: [number, number, number]) =>
    `<Color3uint8 name="${name}">${(((0xff << 24) | (r << 16) | (g << 8) | b) >>> 0).toString()}</Color3uint8>`,
};

/** Enum.Material token values used by the templates. */
const MATERIAL = { Plastic: 256, Grass: 1280 } as const;
/** Enum.Technology.ShadowMap - supported by every Studio version that reads v4 XML. */
const LIGHTING_TECHNOLOGY_SHADOWMAP = 3;

let referentCounter = 0;
const nextReferent = (): string => `RBX${(referentCounter++).toString().padStart(4, "0")}`;

function item(className: string, properties: string[], children: string[], indent: number): string {
  const pad = "\t".repeat(indent);
  const lines = [`${pad}<Item class="${className}" referent="${nextReferent()}">`, `${pad}\t<Properties>`];
  for (const property of properties) lines.push(`${pad}\t\t${property}`);
  lines.push(`${pad}\t</Properties>`);
  for (const child of children) lines.push(child);
  lines.push(`${pad}</Item>`);
  return lines.join("\n");
}

function partItem(options: {
  className: "Part" | "SpawnLocation";
  name: string;
  position: [number, number, number];
  size: [number, number, number];
  color: [number, number, number];
  material: number;
  locked: boolean;
  indent: number;
}): string {
  return item(
    options.className,
    [
      xml.string("Name", options.name),
      xml.bool("Anchored", true),
      xml.bool("CanCollide", true),
      xml.bool("Locked", options.locked),
      xml.cframe("CFrame", options.position),
      xml.vector3("size", options.size),
      xml.token("Material", options.material),
      xml.color3uint8("Color3uint8", options.color),
    ],
    [],
    options.indent,
  );
}

function lightingItem(): string {
  return item(
    "Lighting",
    [
      xml.string("Name", "Lighting"),
      xml.float("Brightness", 3),
      xml.float("ClockTime", 14.5),
      xml.float("GeographicLatitude", 41.7),
      xml.bool("GlobalShadows", true),
      xml.color3("Ambient", [0, 0, 0]),
      xml.color3("OutdoorAmbient", [0.4, 0.4, 0.4]),
      xml.token("Technology", LIGHTING_TECHNOLOGY_SHADOWMAP),
    ],
    [],
    1,
  );
}

function workspaceItem(children: string[]): string {
  return item(
    "Workspace",
    [xml.string("Name", "Workspace"), xml.float("Gravity", 196.2), xml.bool("StreamingEnabled", false)],
    children,
    1,
  );
}

/** Build the XML source of a place file for the given template. */
export function buildPlaceXml(template: PlaceTemplateId): string {
  referentCounter = 0;
  const children: string[] = [];

  if (template === "baseplate") {
    children.push(
      partItem({
        className: "Part",
        name: "Baseplate",
        position: [0, -10, 0],
        size: [512, 20, 512],
        color: [163, 162, 165],
        material: MATERIAL.Plastic,
        locked: true,
        indent: 2,
      }),
      partItem({
        className: "SpawnLocation",
        name: "SpawnLocation",
        position: [0, 0.5, 0],
        size: [12, 1, 12],
        color: [163, 162, 165],
        material: MATERIAL.Plastic,
        locked: false,
        indent: 2,
      }),
    );
  } else if (template === "flat") {
    children.push(
      partItem({
        className: "Part",
        name: "Ground",
        position: [0, -2, 0],
        size: [2048, 4, 2048],
        color: [75, 151, 75],
        material: MATERIAL.Grass,
        locked: true,
        indent: 2,
      }),
      partItem({
        className: "SpawnLocation",
        name: "SpawnLocation",
        position: [0, 0.5, 0],
        size: [12, 1, 12],
        color: [163, 162, 165],
        material: MATERIAL.Plastic,
        locked: false,
        indent: 2,
      }),
    );
  }

  return [
    '<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">',
    "\t<External>null</External>",
    "\t<External>nil</External>",
    workspaceItem(children),
    lightingItem(),
    "</roblox>",
    "",
  ].join("\n");
}

export interface PlacePathOptions {
  /** Sandbox root; every place path must resolve inside it. */
  root: string;
  /** Directory used when a bare file name is given. */
  defaultDir: string;
  /** Restrict to the XML format (place creation only writes .rbxlx). */
  xmlOnly?: boolean;
}

/** Resolve a path against the sandbox, rejecting anything that escapes it. */
function resolveInsideRoot(rawPath: string, root: string, defaultDir: string, subject: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) throw new PlacePathError(`${subject} must not be empty.`);
  if (trimmed.includes("\0")) throw new PlacePathError(`${subject} contains an illegal NUL byte.`);

  const resolved = isAbsolute(trimmed) ? resolve(trimmed) : resolve(defaultDir, trimmed);
  const resolvedRoot = resolve(root);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
    throw new PlacePathError(
      `Refusing to touch ${resolved}: it is outside the allowed place directory ${resolvedRoot}. ` +
        "Set ROBLOX_MCP_PLACES_ROOT to widen the sandbox.",
    );
  }
  return resolved;
}

/**
 * Resolve and validate a place-file path.
 *
 * Rejects unknown extensions and anything that escapes the sandbox root, which
 * is what stops the agent from reading or overwriting unrelated files through
 * the place tools.
 */
export function resolvePlacePath(rawPath: string, options: PlacePathOptions): string {
  const resolved = resolveInsideRoot(rawPath, options.root, options.defaultDir, "Place path");
  const allowed = options.xmlOnly ? [".rbxlx"] : [...PLACE_EXTENSIONS];
  if (!allowed.some((extension) => resolved.toLowerCase().endsWith(extension))) {
    throw new PlacePathError(
      `Place files must end in ${allowed.join(" or ")} (got ${resolved}).` +
        (options.xmlOnly ? " New places are written in the XML format so they stay diff-friendly." : ""),
    );
  }
  return resolved;
}

/** Resolve a directory (for listing) against the same sandbox rules. */
export function resolvePlaceDirectory(rawPath: string, options: Omit<PlacePathOptions, "xmlOnly">): string {
  return resolveInsideRoot(rawPath, options.root, options.defaultDir, "Directory");
}

export interface PlaceFileInfo {
  path: string;
  exists: boolean;
  format: "xml" | "binary" | "unknown";
  bytes: number;
  modifiedAt: number | null;
  /** Top-level service classes, for XML places. */
  services?: string[];
}

/** Inspect a place file on disk without opening Studio. */
export function describePlaceFile(path: string, fs: HostFileSystem): PlaceFileInfo {
  if (!fs.exists(path)) {
    return { path, exists: false, format: "unknown", bytes: 0, modifiedAt: null };
  }
  const bytes = fs.size(path);
  const text = fs.readHead(path, 64 * 1024).toString("utf8");
  const info: PlaceFileInfo = {
    path,
    exists: true,
    format: text.startsWith("<roblox!") ? "binary" : text.includes("<roblox") ? "xml" : "unknown",
    bytes,
    modifiedAt: fs.modifiedAt(path) || null,
  };
  if (info.format === "xml") {
    const services = new Set<string>();
    for (const match of text.matchAll(/<Item class="([A-Za-z0-9_]+)"/g)) services.add(match[1]);
    info.services = [...services];
  }
  return info;
}

export interface CreatePlaceResult extends PlaceFileInfo {
  template: PlaceTemplateId;
  overwritten: boolean;
}

/** Write a new place file from a template. Never overwrites unless asked to. */
export function createPlaceFile(
  options: { path: string; template: PlaceTemplateId; overwrite: boolean },
  fs: HostFileSystem,
): CreatePlaceResult {
  const existed = fs.exists(options.path);
  if (existed && !options.overwrite) {
    throw new PlacePathError(
      `${options.path} already exists. Pass overwrite=true to replace it, or choose another name.`,
    );
  }
  fs.mkdirp(dirname(options.path));
  fs.writeFile(options.path, buildPlaceXml(options.template));
  return {
    ...describePlaceFile(options.path, fs),
    template: options.template,
    overwritten: existed,
  };
}

export interface PlaceListing {
  directory: string;
  files: Array<{ path: string; name: string; bytes: number; modifiedAt: number | null }>;
  truncated: boolean;
}

/** List place files in a directory (optionally recursing), inside the sandbox. */
export function listPlaceFiles(
  options: { directory: string; recursive: boolean; maxResults: number },
  fs: HostFileSystem,
): PlaceListing {
  const files: PlaceListing["files"] = [];
  let truncated = false;
  const MAX_DIRECTORIES = 2_000;
  const queue: string[] = [options.directory];
  let visited = 0;

  while (queue.length > 0) {
    const directory = queue.shift() as string;
    if (++visited > MAX_DIRECTORIES) {
      truncated = true;
      break;
    }
    for (const entry of fs.readDir(directory).sort()) {
      const full = join(directory, entry);
      if (fs.isDirectory(full)) {
        if (options.recursive && !entry.startsWith(".")) queue.push(full);
        continue;
      }
      if (!PLACE_EXTENSIONS.some((extension) => entry.toLowerCase().endsWith(extension))) continue;
      if (files.length >= options.maxResults) {
        truncated = true;
        continue;
      }
      files.push({ path: full, name: entry, bytes: fs.size(full), modifiedAt: fs.modifiedAt(full) || null });
    }
  }

  files.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
  return { directory: options.directory, files, truncated };
}
