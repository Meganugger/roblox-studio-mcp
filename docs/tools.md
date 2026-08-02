# Tool reference

All 61 tools, grouped by domain. Parameters marked * are required.

**Conventions**

- *Path* — instance path like `game.Workspace.Map.Spawn` (`.` or `/` separators; duplicate
  sibling names indexed as `Name[2]`).
- *Properties* — map of property name → value. Primitives are plain JSON; typed values are
  tagged (`{"$type": "Vector3", "value": [0,10,0]}`); enums accept `"Enum.Material.Neon"`;
  keys prefixed `@` write attributes. Supported tags: `Vector3`, `Vector2`, `CFrame`,
  `Color3`, `BrickColor`, `UDim`, `UDim2`, `EnumItem`, `Instance`, `NumberRange`, `Rect`,
  `ColorSequence`, `NumberSequence`, `Font`.
- *Peer* — which connected Studio DataModel a tool targets: `edit` (default), `server`
  (playtest server), `client` (playtest client), or an explicit `sessionId` from
  `get_connected_peers` when several clients are connected. During play-solo / multiplayer
  tests the plugin auto-connects one peer per DataModel.

---

## Connection

### `get_studio_status`
Report plugin connectivity plus live place metadata (name, placeId, run state, selection
count, camera) and the connected peer list. Call this first.

### `get_connected_peers`
List every connected peer: `{sessionId, context, connected, placeName, userName, userId,
lastSeenAt}`. Use a peer's `sessionId` (or the `edit`/`server`/`client` shortcuts) as the
`peer` argument of runtime tools.

### `ping_studio`
`peer` — round-trip latency through the full pipeline to any connected peer.

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

### `mass_set_properties`
`properties`\* · targets: `paths[]` **or** filter (`root` + `className`/`nameContains`) ·
`maxInstances` (default 1000) · `dryRun`
Set the same properties on many instances in one atomic operation (single undo waypoint).
Filter mode requires at least one of `className`/`nameContains` (refuses to bulk-edit every
descendant). Returns `{updated, matched, failures[], truncated}`; `dryRun` previews matches.

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

### `find_and_replace_in_scripts`
`find`\* · `replace`\* · `root` (default `game`) · `caseSensitive` (default true) ·
`classFilter` · `maxScripts` (default 500) · `dryRun`
Literal find/replace across every script under a root, one undo waypoint. Ideal for
project-wide refactors (renaming a RemoteEvent, migrating a deprecated API). `dryRun`
returns per-script match counts without changing anything.

### `list_scripts`
`root` · `classFilter` — every script with path, class, line count, enabled state.

### `analyze_scripts`
`root` · `path` (single script)
Luau compile check (loadstring) without execution → `{path, error, line}` per problem.
Run after batch edits and before playtesting.

---

## Code execution

### `run_luau`
`code`\* · `timeoutMs` (1 000–180 000, default 30 000) · `description` (undo label) · `peer`
Execute Luau at plugin security level in any connected DataModel (edit by default).
Captures `print`/`warn`, serializes return values (tables to depth 6, Instances → paths),
enforces the timeout (cancels the thread), single undo waypoint.
Disable with `ROBLOX_MCP_ALLOW_RUN_LUAU=0`.

### `eval_server_runtime`
`code`\* · `timeoutMs`
Run Luau inside the **live playtest server** DataModel — inspect and mutate running game
state mid-playtest (round data, spawned NPCs, leaderstats). Requires an active
play-solo/multiplayer playtest. Same capture/serialization as `run_luau`.

### `eval_client_runtime`
`code`\* · `timeoutMs` · `peer` (default `client`)
Run Luau inside a **live playtest client** DataModel — PlayerGui, camera, local character,
UI state. Pass a `sessionId` as `peer` to pick a specific client in multiplayer tests.

---

## Project

### `get_project_info`
Place name/ids, per-service child/descendant/script counts, lighting summary, spawn
locations.

### `save_project`
`native` (default true) · `message`
Persists the place. Studio forbids silent plugin saves, so this sends the real **Ctrl+S / ⌘S**
to the Studio window, then pings the plugin to confirm Studio is still responsive (a place that
has never been saved opens a Save As dialog instead — the response says so and
`send_studio_shortcut escape` cancels it). Returns `keystrokeDelivered`, `verified`,
`studioResponsive`, `saved` — `verified: false` means the keystroke was delivered but no plugin
peer was connected to confirm the outcome. With `native: false`, or when native input is unavailable/disabled, it falls back to a
prominent in-Studio notification asking the user to save.

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
`peer` — `{running, isEdit, latestLogSeq}` for that peer.

### `get_output_logs`
`sinceSeq` (default 0) · `level` (`All`/`Output`/`Info`/`Warning`/`Error`) · `maxEntries` · `peer`
Captured output ring buffer (5 000 entries) with monotonic `seq` cursors. Every peer keeps
its own buffer including boot-time prints, so server and client logs are read independently
during playtests.

### `get_errors`
`sinceSeq` · `maxEntries` · `peer` — error entries only, including Luau stack traces and
erroring script paths. The primary debugging feed; check `peer=server` and `peer=client`
separately during playtests.

### `clear_output_logs`
`peer` — clear that peer's buffer (not Studio's Output window).

### `set_log_breakpoint`
`path`\* · `line`\* (1-based) · `message` · `expressions[]` (≤ 10 single-line Luau expressions)
Insert a marker-tagged `print` before the given line — non-pausing instrumentation that
fires in every execution context. Output lines are prefixed `[MCP:BP:<id>]` and land in the
executing peer's log buffer. Returns the breakpoint `id` and the inserted line. Line numbers
shift by one per inserted breakpoint; re-read the source before adding more.

### `list_log_breakpoints`
`path` — list active breakpoints `{id, path, line, text}` (place-wide without `path`).

### `clear_log_breakpoints`
`id` · `path` — remove one breakpoint, all in a script, or every breakpoint in the place
(no arguments). Always clean up after a debugging session.

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

---

## Native host control

These tools act on the machine Studio runs on, not through the plugin bridge. They are gated by
`ROBLOX_MCP_ALLOW_NATIVE` / `ROBLOX_MCP_ALLOW_NATIVE_INPUT` and unavailable on hosts without a
desktop. See [native-control.md](native-control.md) for the per-OS implementation, prerequisites
and security model.

### `get_host_capabilities`
Call this first. Reports the platform and backend, whether Studio was found (and where), running
Studio processes, per-capability availability (`processControl`, `windowControl`,
`inputSimulation`, `screenshot`) each with the tool used or a `hint` naming the exact fix, the
security gates, the screenshot directory and the shortcut allowlist.

### `get_studio_processes`
Running Studio processes: `pid`, process name, window title.

### `launch_studio`
`placeFilePath` · `placeId` · `waitForPlugin` (default true) · `timeoutMs` (default 180 000)
Starts Studio, optionally opening a local place file (sandboxed path) or a cloud `placeId`, then
waits for the plugin's **edit** peer to connect and returns it. Pass one of `placeFilePath` /
`placeId`, not both. When no peer appears, the response explains what to check.

### `close_studio`
`force` (default false)
Asks the Studio window to close (Studio may prompt about unsaved changes). `force: true` kills
the process and **discards unsaved work** — call `save_project` first.

### `focus_studio_window`
Brings Studio to the foreground; returns title, position, size and `focused`.

### `send_studio_shortcut`
`shortcut`\* — one of `play` (F5), `run` (F8), `stop` (Shift+F5), `save` (Ctrl/⌘+S), `saveAs`,
`undo`, `redo`, `escape`, `confirm`.
Studio is focused and its window title verified before the keystroke is delivered; arbitrary
text/keys cannot be injected. Prefer `start_play_solo` / `stop_play_solo` / `save_project`, which
wrap these with the right waiting and verification; use this for `escape`/`confirm` (dialogs)
and `undo`/`redo`.

### `capture_studio_screenshot`
`maxWidth` (320–3840, default 1280) · `fullScreen` (default false) · `label` ·
`includeImage` (default true)
Captures the Studio window (or the whole screen) to a PNG and returns it as an **image block**
plus metadata (`path`, `width`, `height`, `bytes`, `scaled`, `via`). This is how you visually
verify a build — frame the subject with `set_camera` first. Images above 8 MiB are saved to disk
only.

### `start_play_solo`
`waitForPeers` (default true) · `timeoutMs` (default 90 000)
Presses Play (F5) and waits for the playtest peers, returning `serverPeer` / `clientPeer`. Unlike
`start_playtest` (Run mode, no player character) this is a full play session, so
`eval_server_runtime`, `eval_client_runtime` and per-peer logs work against the real game. This
is what makes the build → test → fix loop fully autonomous.

### `stop_play_solo`
`settleMs` (default 1500)
Presses Stop (Shift+F5) and reports peer state afterwards.

---

## Place files (projects)

Local `.rbxlx` / `.rbxl` management, sandboxed to `ROBLOX_MCP_PLACES_ROOT`.

### `list_place_templates`
The templates `create_place_file` can generate, plus the configured places directory and sandbox
root.

### `create_place_file`
`name` | `path` (one of them) · `template` (`baseplate` | `flat` | `empty`, default `baseplate`) ·
`overwrite` (default false)
Writes a brand-new Roblox place (`.rbxlx`) without Studio being involved: `baseplate` is the
classic 512×20×512 anchored baseplate + SpawnLocation + daylight, `flat` a 2048×4×2048 grass
ground + SpawnLocation, `empty` just Workspace and Lighting. A bare `name` lands in the places
directory. Follow with `launch_studio { placeFilePath }`; because a file exists, `save_project`
then saves silently.

### `open_place_file`
`path`\* · `waitForPlugin` (default true) · `timeoutMs`
Inspects the file first (missing / empty / not a Roblox place is reported *before* Studio is
launched), then opens it in Studio and waits for the edit peer.

### `list_place_files`
`directory` (default: places directory) · `recursive` (default false) · `maxResults` (default 100)
Place files newest first, with size and modification time.

---

## Reference

### `get_roblox_docs`
`name`\* (e.g. `ProximityPrompt`, `CFrame`, `Material`, `task`, `string`) ·
`category` (`auto`/`class`/`datatype`/`enum`/`global`/`library`, default `auto`) · `member`
Fetch the **official Roblox engine API reference** (from the source of docs.roblox.com) and
return it condensed: summaries, property types, method/event signatures, parameters and
deprecation notes. Use it to verify API semantics before writing unfamiliar code. `member`
narrows the response to one property/method/event. Requires outbound HTTPS to
`raw.githubusercontent.com`; responses are cached in memory.
