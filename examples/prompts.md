# Prompt playbook

Battle-tested prompts per development role. Combine them freely — the agent keeps
context between steps.

## Orientation

- "Check the Roblox Studio connection and summarize this project: services, scripts, map contents."
- "Export a project snapshot with script sources and review the code for problems."

## Level design

- "Generate a 400×400 hills terrain map (seed 7), add a stone spawn plaza at the center
  with a SpawnLocation, and set sunset lighting. Frame the camera on the plaza when done."
- "Build a lobby: floor, four walls, ceiling lights, and an entrance archway — use a
  batch create so it's one undo step."
- "Scatter 30 collectible coin parts across the map at ground level, gold and glowing."

## Systems engineering

- "Install player data saving, currency, shop, and quests. Then customize the shop
  catalog for a mining game: 3 pickaxes with increasing power and price."
- "Add a rebirth system: at 10,000 coins players can rebirth, resetting coins but adding
  a permanent 2x multiplier. Persist rebirths in the profile and show them in leaderstats."
- "Wire kills to rewards: when combat reports a kill, grant 50 coins and 25 XP, and
  advance the EnemiesDefeated quest stat."

## UI development

- "Extend the HUD with a shop button that opens a shop panel listing the catalog with
  buy buttons wired to the Shop:Buy remote. Match the UIKit theme."
- "Add a quest tracker panel on the right side showing active quests with progress bars,
  live-updating on Quests:Updated."

## Testing & debugging

- "Run a full verification pass: compile-check all scripts, playtest for 10 seconds,
  report every error with its stack trace, then fix them all and prove it's clean."
- "Search all scripts for deprecated APIs (wait, spawn, delay) and refactor them to task.*."
- "The coin spawner throws an error on startup — find it, read the stack trace, fix the
  root cause, and retest."

## Full builds (acceptance-level)

- "Create a polished Roblox simulator game." *(see simulator-game.md)*
- "Create a round-based sword-fighting arena: lobby + arena map, matchmaking loop,
  combat, kill rewards, leaderboards, and a HUD showing round state."
- "Create an obby with 10 stages, checkpoints that persist between sessions, stage
  leaderstats, and a celebration screen at the finish."
