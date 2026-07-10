import { Scaffold, ScaffoldFile, folderChain } from "./types.js";
import { coreScaffold } from "./luau/core.js";
import { dataProfilesScaffold } from "./luau/data-profiles.js";
import { currencyScaffold } from "./luau/currency.js";
import { inventoryScaffold } from "./luau/inventory.js";
import { shopScaffold } from "./luau/shop.js";
import { questsScaffold } from "./luau/quests.js";
import { progressionScaffold } from "./luau/progression.js";
import { leaderboardScaffold } from "./luau/leaderboard.js";
import { combatScaffold } from "./luau/combat.js";
import { npcScaffold } from "./luau/npc.js";
import { matchmakingScaffold } from "./luau/matchmaking.js";
import { settingsScaffold } from "./luau/settings.js";
import { uiKitScaffold } from "./luau/ui-kit.js";

export const SCAFFOLDS: readonly Scaffold[] = [
  coreScaffold,
  dataProfilesScaffold,
  currencyScaffold,
  inventoryScaffold,
  shopScaffold,
  questsScaffold,
  progressionScaffold,
  leaderboardScaffold,
  combatScaffold,
  npcScaffold,
  matchmakingScaffold,
  settingsScaffold,
  uiKitScaffold,
];

const byId = new Map(SCAFFOLDS.map((scaffold) => [scaffold.id, scaffold]));

export function getScaffold(id: string): Scaffold | undefined {
  return byId.get(id);
}

/**
 * Resolve a set of scaffold ids plus all transitive dependencies into a
 * topologically ordered install list (dependencies first).
 */
export function resolveInstallOrder(ids: string[]): Scaffold[] {
  const visited = new Set<string>();
  const ordered: Scaffold[] = [];

  const visit = (id: string, chain: string[]): void => {
    if (visited.has(id)) return;
    if (chain.includes(id)) {
      throw new Error(`Scaffold dependency cycle detected: ${[...chain, id].join(" -> ")}`);
    }
    const scaffold = byId.get(id);
    if (!scaffold) {
      throw new Error(`Unknown scaffold "${id}". Available: ${[...byId.keys()].join(", ")}`);
    }
    for (const dep of scaffold.dependencies) visit(dep, [...chain, id]);
    visited.add(id);
    ordered.push(scaffold);
  };

  for (const id of ids) visit(id, []);
  return ordered;
}

/**
 * Flatten scaffolds into deduplicated batch-create items: folder chains first,
 * then folders/scripts in declaration order. Later duplicates are dropped
 * (first declaration wins), so shared folders/modules install once.
 */
export function buildInstallPlan(scaffolds: Scaffold[]): ScaffoldFile[] {
  const seen = new Set<string>();
  const plan: ScaffoldFile[] = [];

  const push = (file: ScaffoldFile): void => {
    const key = `${file.parentPath}::${file.name}::${file.className}`;
    if (seen.has(key)) return;
    seen.add(key);
    plan.push(file);
  };

  for (const scaffold of scaffolds) {
    for (const file of scaffold.files) {
      for (const folder of folderChain(file.parentPath)) push(folder);
      push(file);
    }
  }
  return plan;
}
