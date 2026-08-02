import { KeyStroke } from "./types.js";

/**
 * Allowlist of Studio keyboard shortcuts the MCP server may synthesize.
 *
 * SECURITY: this is deliberately a closed set of *named actions*, not a
 * free-form "type these keys" API. The server can therefore never be used to
 * inject arbitrary text or dangerous key combinations into the user's desktop,
 * and every action here is one a Roblox developer performs by hand anyway.
 * The host additionally verifies that the focused window belongs to Roblox
 * Studio before any keystroke is delivered.
 */
export interface ShortcutDefinition {
  stroke: KeyStroke;
  /** What Studio does with it. */
  description: string;
  /** Human-readable key combination, per platform family. */
  combo: { primaryIsCtrl: string; primaryIsCommand: string };
}

export const STUDIO_SHORTCUTS = {
  play: {
    stroke: { key: "F5", modifiers: [] },
    description: "Play solo: starts a full play session (server + local client DataModels).",
    combo: { primaryIsCtrl: "F5", primaryIsCommand: "F5" },
  },
  run: {
    stroke: { key: "F8", modifiers: [] },
    description: "Run: simulates the server without a player character.",
    combo: { primaryIsCtrl: "F8", primaryIsCommand: "F8" },
  },
  stop: {
    stroke: { key: "F5", modifiers: ["shift"] },
    description: "Stop the current play/run session and return to edit mode.",
    combo: { primaryIsCtrl: "Shift+F5", primaryIsCommand: "Shift+F5" },
  },
  save: {
    stroke: { key: "S", modifiers: ["primary"] },
    description: "Save the place to its current file (the only way a place can be saved silently).",
    combo: { primaryIsCtrl: "Ctrl+S", primaryIsCommand: "Command+S" },
  },
  saveAs: {
    stroke: { key: "S", modifiers: ["primary", "shift"] },
    description: "Open the Save As dialog (a modal dialog will require user interaction).",
    combo: { primaryIsCtrl: "Ctrl+Shift+S", primaryIsCommand: "Command+Shift+S" },
  },
  undo: {
    stroke: { key: "Z", modifiers: ["primary"] },
    description: "Undo the last change in Studio's history.",
    combo: { primaryIsCtrl: "Ctrl+Z", primaryIsCommand: "Command+Z" },
  },
  redo: {
    stroke: { key: "Z", modifiers: ["primary", "shift"] },
    description: "Redo the last undone change.",
    combo: { primaryIsCtrl: "Ctrl+Shift+Z", primaryIsCommand: "Command+Shift+Z" },
  },
  escape: {
    stroke: { key: "Escape", modifiers: [] },
    description: "Press Escape, e.g. to dismiss a Studio dialog or cancel a tool.",
    combo: { primaryIsCtrl: "Esc", primaryIsCommand: "Esc" },
  },
  confirm: {
    stroke: { key: "Enter", modifiers: [] },
    description: "Press Enter, e.g. to accept the default button of a Studio dialog.",
    combo: { primaryIsCtrl: "Enter", primaryIsCommand: "Return" },
  },
} as const satisfies Record<string, ShortcutDefinition>;

export type ShortcutName = keyof typeof STUDIO_SHORTCUTS;

export const SHORTCUT_NAMES = Object.keys(STUDIO_SHORTCUTS) as [ShortcutName, ...ShortcutName[]];

export function getShortcut(name: ShortcutName): ShortcutDefinition {
  return STUDIO_SHORTCUTS[name];
}

/** Documentation payload for get_host_capabilities / send_studio_shortcut errors. */
export function describeShortcuts(primaryIsCommand: boolean): Array<{
  name: ShortcutName;
  keys: string;
  description: string;
}> {
  return SHORTCUT_NAMES.map((name) => {
    const definition = STUDIO_SHORTCUTS[name];
    return {
      name,
      keys: primaryIsCommand ? definition.combo.primaryIsCommand : definition.combo.primaryIsCtrl,
      description: definition.description,
    };
  });
}
