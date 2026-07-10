# Acceptance scenario: "Create a polished Roblox simulator game."

This is the reference walkthrough of how an agent uses the tool suite to ship a complete
simulator game (collect → sell → upgrade loop) in one session. Tool names are real;
payloads are abbreviated for readability.

## Phase 0 — Orient

```
get_studio_status            → connected, empty baseplate
get_project_info             → Workspace: 2 children, 0 scripts anywhere
```

## Phase 1 — Level design

```
generate_terrain {shape:"hills", center:[0,-2,0], size:[600,60,600], material:"Grass", seed:11}
create_instances_batch       → in ONE call:
  Folder  game.Workspace.Map
  Part    Map.SpawnPlaza      (48×1×48 Slate, anchored)
  SpawnLocation Map.Spawn     (on the plaza)
  Folder  Map.CoinZone
  Part    Map.SellPad         (12×1×12 Neon gold, anchored)  + @SellPad attribute
  ... decorative pillars, trees (cylinders + spheres), zone borders
set_lighting {preset:"day", properties:{Brightness:2.4}}
set_camera {position:[80,60,80], lookAt:[0,0,0]}
get_instance_tree {path:"game.Workspace.Map"}     → verify structure
```

## Phase 2 — Core systems (one command)

```
install_scaffold {ids:["currency","shop","quests","progression","leaderboard","settings","ui-kit"]}
```

Dependency resolution auto-includes `core`, `data-profiles`, `inventory`. Installed:
Bootstrap + Net, DataService (DataStore profiles), CurrencyService, InventoryService,
ShopService + ShopCatalog, QuestService + QuestDefinitions, ProgressionService,
LeaderboardService, SettingsService, UIKit + HUD + MainMenu.

## Phase 3 — Game-specific code

```
patch_script_source game.ReplicatedStorage.Shared.ShopCatalog
  → replace default items with: Stone Pickaxe (100), Iron Pickaxe (750, +2x),
    Diamond Pickaxe (5000, +5x), Golden Trail (50 gems)

create_script Script "CoinSpawner" in game.ServerScriptService.Server
  → spawns glowing coins in Map.CoinZone on a timer; on Touched (server-side
    validation + debounce): CurrencyService:Add(player,"Coins", amount × pickaxe
    multiplier from InventoryService equipped slot), QuestService:AddProgress
    (player, "CoinsCollected", 1), ProgressionService:AddXP(player, 2)

create_script Script "SellPad" in game.ServerScriptService.Server
  → stands on pad → converts Coins to Gems at 1000:1 with a toast via Net

patch_script_source QuestDefinitions → quests tuned to the coin loop
```

## Phase 4 — UI polish

```
create_script LocalScript "ShopUI" in game.StarterPlayer.StarterPlayerScripts.Client
  → UIKit panel listing Net.invoke("Shop:GetCatalog"), buy buttons → "Shop:Buy",
    result toasts, equip-on-purchase for pickaxes
```

## Phase 5 — Verify (the loop that matters)

```
analyze_scripts              → 1 problem: CoinSpawner line 42 "expected ) got ="
patch_script_source          → fix
analyze_scripts              → clean ✓

start_playtest               → logSeq = 118
(wait)
get_errors {sinceSeq:118}    → ServerScriptService.Server.Services.ShopService:41:
                               attempt to index nil with 'ById'  (stack attached)
get_script_source ShopCatalog → agent's earlier patch dropped the `ById` export
patch_script_source ShopCatalog → restore export
stop_playtest → start_playtest → get_errors → none ✓
get_output_logs              → "[Bootstrap] Started 9 services" + coin spawn prints ✓
run_luau                     → probe: simulate a pickup by invoking the same server
                               API; assert leaderstats Coins incremented
stop_playtest
```

## Phase 6 — Ship

```
save_project {message:"Simulator game complete — please Ctrl+S / publish"}
set_selection [Map, Server, Client]     → show the user what was built
```

**Result:** terrain map, spawn/sell/collect zones, 9 running services, persistent player
data, shop with 4 items, 3 quests, XP/levels/achievements, global leaderboards, HUD +
menu + shop UI, all compile-clean and runtime-error-free.

## Why this works

- **Batching** keeps world-building fast and undoable.
- **Scaffolds** give production-quality foundations, so the agent spends its effort on
  game-specific logic instead of re-inventing DataStore handling.
- **The analyze → playtest → get_errors → patch loop** converts runtime stack traces
  into targeted fixes — the agent never ships a broken system.
