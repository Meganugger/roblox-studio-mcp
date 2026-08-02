import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolContext } from "./tool-helpers.js";
import { registerConnectionTools } from "./tools/connection.js";
import { registerInstanceTools } from "./tools/instances.js";
import { registerScriptTools } from "./tools/scripts.js";
import { registerCodeTools } from "./tools/code.js";
import { registerProjectTools } from "./tools/project.js";
import { registerPlaytestTools } from "./tools/playtest.js";
import { registerBreakpointTools } from "./tools/breakpoints.js";
import { registerWorldTools } from "./tools/world.js";
import { registerScaffoldTools } from "./tools/scaffold.js";
import { registerDocsTools } from "./tools/docs.js";
import { registerNativeTools } from "./tools/native.js";
import { registerPlaceTools } from "./tools/places.js";
import { SERVER_VERSION } from "../version.js";

export const SERVER_INSTRUCTIONS = `Roblox Studio MCP gives you full control of a live Roblox Studio session.
You can act as a complete Roblox development team: programmer, level designer, UI developer, gameplay engineer, tester and debugger.

Recommended workflow:
0. If Studio is not open (get_studio_status reports no edit peer), take control of the machine: get_host_capabilities tells you what this OS allows, create_place_file makes a fresh place, and launch_studio / open_place_file opens it and waits for the plugin to connect.
1. get_studio_status / get_project_info to orient yourself.
2. Check real API semantics with get_roblox_docs (classes, datatypes, enums) before writing unfamiliar code.
3. Build structure with create_instances_batch, terrain with generate_terrain, mood with set_lighting; use mass_set_properties / find_and_replace_in_scripts for bulk changes.
4. Install proven gameplay systems with list_scaffolds + install_scaffold (data saving, currency, shop, quests, combat, NPCs, rounds, UI kit), then customize the generated Luau with the script tools.
5. Write game-specific code with create_script / patch_script_source; use run_luau for anything not covered by a dedicated tool.
6. Verify continuously: analyze_scripts (syntax) -> start_playtest -> get_errors / get_output_logs (runtime) -> fix -> stop_playtest -> repeat. Never leave a system broken.
7. Runtime debugging: during a playtest, each DataModel connects as its own peer (get_connected_peers). Use eval_server_runtime / eval_client_runtime to inspect live game state, per-peer get_output_logs / get_errors to read each side's logs, and set_log_breakpoint to instrument suspicious code paths without pausing. You can start a real player session yourself with start_play_solo (no human needed) and end it with stop_play_solo.
8. Look at your work: capture_studio_screenshot returns an image of the Studio window, so you can visually check geometry, lighting and UI instead of guessing. Frame it first with set_camera.
9. When finished, call save_project (it sends the real Ctrl+S) so the work is persisted.

Notes:
- Instance paths look like "game.Workspace.Map.Spawn"; duplicate names can be indexed: "game.Workspace.Part[2]".
- Typed property values use tagged JSON, e.g. {"$type":"Vector3","value":[0,10,0]} or "Enum.Material.Neon".
- start_playtest runs Studio "Run" mode (server simulation, no player character) in the edit peer; start_play_solo presses F5 for a full play session with a player character, which adds server/client peers.
- Native host tools (launch_studio, send_studio_shortcut, capture_studio_screenshot, start_play_solo, native save) act on the user's machine. They can be disabled by configuration and are unavailable on hosts without a desktop; get_host_capabilities always explains exactly why something is unavailable, so report that instead of retrying.`;

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    {
      name: "roblox-studio-mcp",
      version: SERVER_VERSION,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  registerConnectionTools(server, ctx);
  registerInstanceTools(server, ctx);
  registerScriptTools(server, ctx);
  registerCodeTools(server, ctx);
  registerProjectTools(server, ctx);
  registerPlaytestTools(server, ctx);
  registerBreakpointTools(server, ctx);
  registerWorldTools(server, ctx);
  registerScaffoldTools(server, ctx);
  registerDocsTools(server, ctx);
  registerNativeTools(server, ctx);
  registerPlaceTools(server, ctx);

  return server;
}
