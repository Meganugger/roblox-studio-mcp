/**
 * Canonical list of commands the Studio plugin understands.
 * The plugin's Executors/init.luau dispatcher mirrors this list 1:1.
 */
export const COMMAND_NAMES = [
  // Connection / status
  "Ping",
  "GetStudioStatus",

  // Explorer / instances
  "GetInstanceTree",
  "GetInstance",
  "GetInstanceChildren",
  "SearchInstances",
  "CreateInstance",
  "CreateInstancesBatch",
  "SetProperties",
  "RenameInstance",
  "MoveInstance",
  "CloneInstance",
  "DeleteInstance",
  "GetSelection",
  "SetSelection",

  // Scripts
  "CreateScript",
  "GetScriptSource",
  "SetScriptSource",
  "PatchScriptSource",
  "SearchScriptSource",
  "ListScripts",
  "AnalyzeScripts",

  // Code execution
  "RunLuau",

  // Project
  "GetProjectInfo",
  "RequestSave",
  "ExportProjectSnapshot",

  // Playtest / debugging
  "StartPlaytest",
  "StopPlaytest",
  "GetPlaytestState",
  "GetLogs",
  "ClearLogs",

  // World building
  "GenerateTerrain",
  "ClearTerrain",
  "SetLighting",
  "InsertAsset",
  "SetCamera",
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

export function isCommandName(name: string): name is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(name);
}

/** Log entry captured by the plugin's output buffer. */
export interface StudioLogEntry {
  /** Sequence number, monotonically increasing per Studio session. */
  seq: number;
  /** Unix timestamp in seconds (may be fractional). */
  timestamp: number;
  /** "Output" | "Info" | "Warning" | "Error" */
  level: "Output" | "Info" | "Warning" | "Error";
  message: string;
  /** Stack trace when the entry came from ScriptContext.Error. */
  stack?: string;
  /** Full name of the erroring script, when known. */
  script?: string;
}
