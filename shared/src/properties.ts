/**
 * JSON encoding for Roblox property values.
 *
 * Primitives (boolean, number, string) travel as plain JSON values.
 * Typed Roblox values travel as tagged objects: { "$type": "...", "value": ... }
 * Enums may also be written as the shorthand string "Enum.Material.Grass".
 *
 * The Studio plugin's Serialization.luau implements the exact mirror of this
 * encoding, so keep both files in sync.
 */

export const TYPED_VALUE_TAGS = [
  "Vector3",
  "Vector2",
  "CFrame",
  "Color3",
  "BrickColor",
  "UDim",
  "UDim2",
  "EnumItem",
  "Instance",
  "NumberRange",
  "Rect",
  "ColorSequence",
  "NumberSequence",
  "Font",
] as const;

export type TypedValueTag = (typeof TYPED_VALUE_TAGS)[number];

export interface TaggedValue {
  $type: TypedValueTag;
  value: unknown;
}

export type PropertyValue = boolean | number | string | TaggedValue;

export function isTaggedValue(value: unknown): value is TaggedValue {
  return (
    typeof value === "object" &&
    value !== null &&
    "$type" in value &&
    typeof (value as TaggedValue).$type === "string" &&
    (TYPED_VALUE_TAGS as readonly string[]).includes((value as TaggedValue).$type)
  );
}

/** Shorthand enum strings look like "Enum.Material.Grass". */
export function isEnumShorthand(value: unknown): value is string {
  return typeof value === "string" && /^Enum\.[A-Za-z0-9]+\.[A-Za-z0-9_ ]+$/.test(value);
}

// Convenience constructors used by server-side tools and tests.
export const rbx = {
  vector3: (x: number, y: number, z: number): TaggedValue => ({ $type: "Vector3", value: [x, y, z] }),
  vector2: (x: number, y: number): TaggedValue => ({ $type: "Vector2", value: [x, y] }),
  /** Position + optional look-at encoded as CFrame components (pos only here). */
  cframe: (components: number[]): TaggedValue => ({ $type: "CFrame", value: components }),
  color3: (r: number, g: number, b: number): TaggedValue => ({ $type: "Color3", value: [r, g, b] }),
  brickColor: (name: string): TaggedValue => ({ $type: "BrickColor", value: name }),
  udim: (scale: number, offset: number): TaggedValue => ({ $type: "UDim", value: [scale, offset] }),
  udim2: (sx: number, ox: number, sy: number, oy: number): TaggedValue => ({
    $type: "UDim2",
    value: [sx, ox, sy, oy],
  }),
  enum: (enumType: string, item: string): TaggedValue => ({
    $type: "EnumItem",
    value: `Enum.${enumType}.${item}`,
  }),
  instance: (path: string): TaggedValue => ({ $type: "Instance", value: path }),
  numberRange: (min: number, max: number): TaggedValue => ({ $type: "NumberRange", value: [min, max] }),
};

/**
 * Instance paths address objects in the DataModel:
 *   "game.Workspace.Map.Spawn" or "game/Workspace/Map/Spawn"
 * Duplicate sibling names can be disambiguated with a 1-based index suffix:
 *   "game.Workspace.Part[2]"
 */
export const INSTANCE_PATH_PATTERN = /^game([./][A-Za-z0-9_ \-()]+(\[\d+\])?)*$/;

export function isValidInstancePath(path: string): boolean {
  return path.length <= 2000 && INSTANCE_PATH_PATTERN.test(path);
}
