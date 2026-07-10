# Usage guide

This guide shows how an AI agent (or you, driving one) gets real work done with the
tool suite. All examples are natural-language prompts; the agent maps them to tools.

## Orientation: understand the project first

> "What's in this place? Give me an overview."

The agent calls `get_project_info` (service stats), `get_instance_tree` (structure),
and `list_scripts` (code inventory). For deep dives: `export_project_snapshot`
(optionally with all script sources) produces a reviewable JSON of the whole game.

## Building worlds

> "Create a 512×512 grassy hills map with a stone spawn plaza and warm sunset lighting."

Typical tool flow:

1. `generate_terrain` — `{shape: "hills", center: [0,0,0], size: [512,80,512], material: "Grass", seed: 42}`
2. `create_instances_batch` — plaza floor, walls, spawn point, decoration parts in one
   atomic call (single undo step). Parts reference tagged property values:
   ```json
   { "className": "Part", "parentPath": "game.Workspace.Plaza", "name": "Floor",
     "properties": { "Size": {"$type":"Vector3","value":[64,1,64]},
                     "Material": "Enum.Material.Slate", "Anchored": true } }
   ```
3. `set_lighting` — `{preset: "sunset"}` then fine-tune with extra properties.
4. `set_camera` — frame the result to eyeball it, `get_instance_tree` to verify structure.

## Writing gameplay code

> "Add a coin pickup system: coins spawn on the map, players collect them for currency."

1. `install_scaffold {ids: ["currency"]}` — server-authoritative currency with
   leaderstats + client events (auto-installs `core` + `data-profiles`).
2. `create_script` — a `CoinSpawner` Script in `ServerScriptService` that spawns coin
   parts and calls `CurrencyService:Add(player, "Coins", n)` on touch.
3. `analyze_scripts` — compile check.
4. `start_playtest` → `get_errors` → fix with `patch_script_source` → retest.

### Editing code like an engineer

- `get_script_source` before editing — patches must match exactly.
- `patch_script_source` for surgical edits (atomic; fails loudly when the `find` text is
  missing or ambiguous — add context or `replaceAll`).
- `search_script_source` is grep for the whole game: find every caller before refactoring.
- `set_script_source` only for full rewrites.

## The autonomous test/debug loop

The core discipline: **never leave a system broken.**

```
analyze_scripts            → syntax problems? fix first
start_playtest             → note the returned logSeq
(wait a few seconds)
get_errors {sinceSeq}      → runtime errors with Luau stacks + script paths
get_script_source          → inspect the failing line
patch_script_source        → fix
stop_playtest → start_playtest → get_errors   → repeat until clean
get_output_logs            → verify expected prints (e.g. "[Bootstrap] Started 5 services")
stop_playtest
save_project               → user is prompted in Studio to Ctrl+S
```

Playtest runs in Studio **Run mode** (server simulation, no player character): perfect for
verifying services, spawners, data flow, and error-free startup. Player-dependent behavior
(character touch, UI) is verified by code review plus targeted `run_luau` probes — e.g.
simulating a touch by calling the same server API the touch handler uses.

## run_luau: the escape hatch

Anything without a dedicated tool: complex geometry, physics constraints, bulk edits,
service queries.

> "Build a spiral staircase of 40 neon steps around the tower."

```lua
local tower = workspace.Tower
for i = 1, 40 do
    local step = Instance.new("Part")
    step.Size = Vector3.new(6, 1, 3)
    step.Material = Enum.Material.Neon
    step.Anchored = true
    step.CFrame = tower.CFrame * CFrame.Angles(0, math.rad(i * 18), 0) * CFrame.new(8, i * 2, 0)
    step.Parent = tower
end
print("built 40 steps")
```

Returns captured prints plus serialized return values; the whole operation is one undo
waypoint. Timeouts are enforced (configurable up to 180 s), and runtime errors come back
with full stack traces.

## Game system scaffolds

`list_scaffolds` shows the catalog. Highlights:

| id | What you get |
| --- | --- |
| `core` | Service Bootstrap (Init/Start lifecycle) + `Net` module (namespaced remotes, rate limiting) |
| `data-profiles` | DataStore profiles: retries, reconciliation, autosave, BindToClose, Studio fallback |
| `currency` | Multi-currency, leaderstats, anti-exploit validation, client change events |
| `inventory` / `shop` | Stack inventory + equip slots; server-validated purchases against a catalog module |
| `quests` | Data-driven counters, claimable rewards, playtime driver |
| `progression` | XP/levels, level-up rewards, achievements |
| `leaderboard` | Global OrderedDataStore top-N with caching |
| `combat` / `npc` | Validated melee combat; NPC spawner with wander/chase/attack AI |
| `matchmaking` | Lobby → countdown → round → results loop with win conditions |
| `settings` | Schema-validated persisted player settings |
| `ui-kit` | Themed UI factory + HUD (currency/XP bound to remotes) + animated main menu + toasts |

Installs are idempotent: re-running skips existing files (default) or updates them
(`overwrite: true`). After installing, **customize the data modules**
(`ShopCatalog`, `QuestDefinitions`, `ProfileTemplate`) to the specific game.

## Multi-role workflow example

Prompt: *"Create a polished Roblox simulator game."* A strong agent behaves like a team:

1. **Producer** — `get_project_info`, plan the feature list.
2. **Level designer** — terrain, spawn area, collectible zones, lighting mood, camera checks.
3. **Systems engineer** — `install_scaffold` for data/currency/shop/quests/progression/ui-kit.
4. **Gameplay programmer** — game-specific scripts (collectible spawner, rebirth logic)
   wired into the scaffold services.
5. **UI developer** — extend the UIKit HUD with shop/quest panels via `create_script`.
6. **Tester/debugger** — the analyze → playtest → errors → patch loop until clean.
7. **Release** — `save_project`, summary of what was built and where it lives.

The full transcript-style walkthrough is in
[`examples/simulator-game.md`](../examples/simulator-game.md).
