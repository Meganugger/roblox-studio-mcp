# Tool reference

All 39 tools, grouped by domain. Parameters marked * are required.

**Conventions**

- *Path* — instance path like `game.Workspace.Map.Spawn` (`.` or `/` separators; duplicate
  sibling names indexed as `Name[2]`).
- *Properties* — map of property name → value. Primitives are plain JSON; typed values are
  tagged (`{"$type": "Vector3", "value": [0,10,0]}`); enums accept `"Enum.Material.Neon"`;
  keys prefixed `@` write attributes. Supported tags: `Vector3`, `Vector2`, `CFrame`,
  `Color3`, `BrickColor`, `UDim`, `UDim2`, `EnumItem`, `Instance`, `NumberRange`, `Rect`,
  `ColorSequence`, `NumberSequence`, `Font`.

---

## Connection

### `get_studio_status`
Report plugin connectivity plus live place metadata (name, placeId, run state, selection
count, camera). Call this first.

### `ping_studio`
Round-trip latency through the full pipeline.

---

## Explorer / instances

### `get_instance_tree`
`path`\* · `maxDepth` (1–25, default 4) · `classFilter` · `maxNodes` (default 3000)
Nested `{name, className, path, children}` tree. With `classFilter`, ancestors of matches
are preserved. `truncated` flags budget exhaustion.

### `get_instance`
`path`\* · `properties` (explicit whitelist)
Class, path, readable properties (class-appropriate defaults), attributes, child names.

### `get_instance_children`
`path`\* — direct children: name/class/path.

### `search_instances`
`root` (default `game`) · `nameContains` · `className` (IsA-aware) · `maxResults` (default 200)

### `create_instance`
`className`\* · `parentPath`\* · `name` · `properties`
Creates one instance; returns its path.

### `create_instances_batch`
`items[]`\* (≤ 500 of `{className, parentPath, name, properties}`)
Atomic batch, one undo waypoint. Items may reference parents created earlier in the same
batch — ideal for maps and UI hierarchies. Precise per-item error attribution.

### `set_instance_properties`
`path`\* · `properties`\* — set properties and/or `@attributes`.

### `rename_instance` / `move_instance` / `clone_instance` / `delete_instance`
Rename (`newName`), reparent (`newParentPath`, cycle-safe), deep-copy (`newParentPath`,
`newName`), destroy. Protected containers (game, core services) refuse mutation.

### `get_selection` / `set_selection`
Read or set the Studio Explorer selection (`paths[]`).

---

## Scripts

### `create_script`
`scriptClass`\* (`Script` | `LocalScript` | `ModuleScript`) · `parentPath`\* · `name`\* ·
`source`\* · `runContext` (`Legacy`/`Server`/`Client`, Script only) · `overwrite` (default false)
Duplicate name+class at the same parent errors unless `overwrite`.

### `get_script_source`
`path`\* · `startLine` · `endLine` — source with line count and byte size.

### `set_script_source`
`path`\* · `source`\* — full replacement. Prefer `patch_script_source` for edits.

### `patch_script_source`
`path`\* · `edits[]`\* (≤ 50 of `{find, replace, replaceAll}`)
Exact-match find/replace. Each `find` must appear exactly once unless `replaceAll`.
Atomic: all edits or none, with actionable errors (missing/ambiguous matches).

### `search_script_source`
`query`\* · `isPattern` (Lua pattern) · `caseSensitive` · `root` · `maxResults`
Grep across all scripts: path + line number + line text.

### `list_scripts`
`root` · `classFilter` — every script with path, class, line count, enabled state.

### `analyze_scripts`
`root` · `path` (single script)
Luau compile check (loadstring) without execution → `{path, error, line}` per problem.
Run after batch edits and before playtesting.

---

## Code execution

### `run_luau`
`code`\* · `timeoutMs` (1 000–180 000, default 30 000) · `description` (undo label)
Execute Luau at plugin security level in the edit DataModel. Captures `print`/`warn`,
serializes return values (tables to depth 6, Instances → paths), enforces the timeout
(cancels the thread), single undo waypoint. Disable with `ROBLOX_MCP_ALLOW_RUN_LUAU=0`.

---

## Project

### `get_project_info`
Place name/ids, per-service child/descendant/script counts, lighting summary, spawn
locations.

### `save_project`
`message` — Studio forbids silent plugin saves; shows a prominent in-Studio notification
asking the user to Ctrl+S/Publish. Returns `notified`.

### `export_project_snapshot`
`includeScriptSources` (default false) · `root` · `maxNodes` (≤ 50 000)
Whole-place structural JSON export, bounded with a `truncated` flag.

---

## Playtest & debugging

### `start_playtest`
Start simulation via `RunService:Run()` — server scripts + physics in the current
DataModel (no player character). Returns `logSeq` to baseline log reads.

### `stop_playtest`
Stop the simulation. Script-made changes persist in the edit session — account for this
when verifying state.

### `get_playtest_state`
`{running, isEdit, latestLogSeq}`.

### `get_output_logs`
`sinceSeq` (default 0) · `level` (`All`/`Output`/`Info`/`Warning`/`Error`) · `maxEntries`
Captured output ring buffer (5 000 entries) with monotonic `seq` cursors.

### `get_errors`
`sinceSeq` · `maxEntries` — error entries only, including Luau stack traces and erroring
script paths. The primary debugging feed.

### `clear_output_logs`
Clear the plugin's buffer (not Studio's Output window).

---

## World building

### `generate_terrain`
`shape`\* (`block`/`ball`/`hills`) · `center`\* `[x,y,z]` · `size`\* `[x,y,z]` (≤ 2048/axis) ·
`material` (default Grass) · `seed` · `amplitude` (hills) · `frequency` (hills)
`hills` builds a Perlin-noise heightmap with adaptive column sizing and responsiveness
yields; `seed` makes maps reproducible.

### `clear_terrain`
Remove all smooth terrain.

### `set_lighting`
`preset` (`day`/`sunset`/`night`/`foggy-horror`/`neon-city`) · `properties`
Presets configure Lighting + Atmosphere/Bloom/ColorCorrection children; extra properties
fine-tune afterwards.

### `insert_asset`
`assetId`\* · `parentPath` (default Workspace) · `allowScripts` (default **false**)
InsertService catalog insertion. **Scripts inside inserted assets are stripped by
default** — only pass `allowScripts` for trusted content. Disable the tool entirely with
`ROBLOX_MCP_ALLOW_INSERT_ASSET=0`.

### `set_camera`
`position`\* · `lookAt` — frame the editor camera on what you built.

---

## Game system scaffolds

### `list_scaffolds`
Catalog of installable systems with descriptions, dependencies, and file manifests:
`core`, `data-profiles`, `currency`, `inventory`, `shop`, `quests`, `progression`,
`leaderboard`, `combat`, `npc`, `matchmaking`, `settings`, `ui-kit`.

### `install_scaffold`
`ids[]`\* · `overwrite` (default false)
Installs scaffolds + transitive dependencies (topologically ordered) in one atomic batch.
Idempotent: folders reused; existing scripts skipped, or updated in place with
`overwrite`. Follow up with `analyze_scripts` + a playtest cycle, then customize the
generated data modules (ShopCatalog, QuestDefinitions, ProfileTemplate).
