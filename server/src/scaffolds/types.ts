/**
 * Scaffolds are production-quality Luau systems the MCP server can install
 * into a place in one batch operation. They give an AI agent the same head
 * start a senior Roblox team lead would give a new project: data profiles,
 * currency, shops, quests, combat, rounds, UI kit, etc.
 *
 * Conventions used by every scaffold (see docs/architecture):
 *   game.ServerScriptService.Server            - server code root (Folder)
 *   game.ServerScriptService.Server.Bootstrap  - service runner (Script)
 *   game.ServerScriptService.Server.Services   - ModuleScript services
 *   game.ReplicatedStorage.Shared              - shared modules (Net, configs)
 *   game.ReplicatedStorage.Remotes             - RemoteEvents/Functions (created by Net)
 *   game.StarterPlayer.StarterPlayerScripts.Client - client code root
 *
 * Services follow an Init/Start lifecycle:
 *   Service:Init(services) is called on every service first (wire references),
 *   then Service:Start() is called on every service.
 */

export interface ScaffoldFile {
  /** Parent path; missing Folders along the way are created by install. */
  parentPath: string;
  className: "Script" | "LocalScript" | "ModuleScript" | "Folder";
  name: string;
  /** Luau source (omit for Folders). */
  source?: string;
}

export interface Scaffold {
  id: string;
  title: string;
  description: string;
  /** Scaffold ids that must be installed for this one to work. */
  dependencies: string[];
  files: ScaffoldFile[];
}

/** Split "game.A.B" into ordered ancestor folder specs (excluding "game" and services). */
export function folderChain(parentPath: string): ScaffoldFile[] {
  const KNOWN_SERVICES = new Set([
    "Workspace",
    "ReplicatedStorage",
    "ServerScriptService",
    "ServerStorage",
    "StarterGui",
    "StarterPack",
    "StarterPlayer",
    "StarterPlayerScripts",
    "StarterCharacterScripts",
    "Lighting",
    "SoundService",
    "Teams",
  ]);
  const segments = parentPath.split(/[./]/);
  if (segments[0] !== "game") throw new Error(`Scaffold parentPath must start with "game": ${parentPath}`);
  const chain: ScaffoldFile[] = [];
  let current = "game";
  for (const segment of segments.slice(1)) {
    const parent = current;
    current = `${current}.${segment}`;
    if (KNOWN_SERVICES.has(segment)) continue;
    chain.push({ parentPath: parent, className: "Folder", name: segment });
  }
  return chain;
}
