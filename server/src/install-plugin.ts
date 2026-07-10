import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_FILE = "RobloxStudioMCP.rbxmx";

/**
 * Locate the Roblox Studio local plugins folder for this OS.
 * Override with MCP_PLUGINS_DIR (useful for custom Studio setups and Linux/Wine).
 */
export function studioPluginsDir(): string {
  const override = process.env.MCP_PLUGINS_DIR;
  if (override) return override;

  switch (platform()) {
    case "win32": {
      const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
      return join(localAppData, "Roblox", "Plugins");
    }
    case "darwin":
      return join(homedir(), "Documents", "Roblox", "Plugins");
    default:
      throw new Error(
        "Could not determine the Roblox Studio plugins folder on this OS. " +
          "Set MCP_PLUGINS_DIR to your Studio local plugins directory and retry.",
      );
  }
}

/** Path of the packed plugin artifact inside this repository/package. */
export function builtPluginPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // server/dist/install-plugin.js -> repo root is ../../..
  const candidates = [
    resolve(here, "../../studio-plugin/dist", PLUGIN_FILE),
    resolve(here, "../../../studio-plugin/dist", PLUGIN_FILE),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Built plugin not found (looked at: ${candidates.join(", ")}). ` +
      "Run `npm run build` at the repository root first (it packs the plugin via scripts/build-plugin.mjs).",
  );
}

/**
 * Copy the packed .rbxmx into the Studio plugins folder.
 * Returns the destination path. Fully restart Studio afterwards.
 */
export function installPlugin(): string {
  const source = builtPluginPath();
  const dir = studioPluginsDir();
  mkdirSync(dir, { recursive: true });
  const destination = join(dir, PLUGIN_FILE);
  copyFileSync(source, destination);
  return destination;
}
