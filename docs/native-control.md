# Native host control

v3.0.0 gives the MCP server hands on the machine Roblox Studio runs on. This is what turns the
agent from "can edit an open place" into "can run a full development session by itself":

| Without native control | With native control |
| --- | --- |
| The user must open Studio and a place first | `create_place_file` + `launch_studio` / `open_place_file` |
| The user must press F5 to start a play session before runtime debugging | `start_play_solo` waits for the playtest peers itself |
| The agent is blind to what the viewport looks like | `capture_studio_screenshot` returns the window as an image |
| `save_project` could only ask the user to press Ctrl+S | `save_project` sends the real Ctrl+S |

Everything else (Explorer, scripts, terrain, scaffolds, runtime eval) works over the plugin
bridge and needs none of this. Getting the saved place onto Roblox is the next layer up:
[publishing.md](publishing.md).

## Start here: `get_host_capabilities`

Always call it before the other native tools. It answers, for the actual machine:

```json
{
  "platform": "win32",
  "supported": true,
  "backend": "Windows (PowerShell + Win32: window control, SendKeys input, GDI+ capture)",
  "gates": { "nativeControl": true, "inputSimulation": true },
  "studio": {
    "executablePath": "C:\\Users\\me\\AppData\\Local\\Roblox\\Versions\\version-abc\\RobloxStudioBeta.exe",
    "running": true,
    "processes": [{ "pid": 8123, "name": "RobloxStudioBeta", "windowTitle": "PetSim - Roblox Studio" }]
  },
  "probe": {
    "processControl": { "available": true, "via": "powershell.exe" },
    "windowControl": { "available": true, "via": "powershell.exe + user32.dll" },
    "inputSimulation": { "available": true, "via": "System.Windows.Forms.SendKeys" },
    "screenshot": { "available": true, "via": "System.Drawing (GDI+ CopyFromScreen)" },
    "notes": ["PowerShell 5.1.22621.4391 via powershell.exe."]
  },
  "shortcuts": [{ "name": "play", "keys": "F5", "description": "Play solo: ..." }],
  "screenshotDir": "C:\\Users\\me\\.roblox-studio-mcp\\screenshots",
  "notes": []
}
```

Every unavailable capability carries a `hint` with the exact fix, so the agent reports a real
instruction instead of retrying blindly.

## Per-platform implementation

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Find Studio | `%LOCALAPPDATA%\Roblox\Versions\*\RobloxStudioBeta.exe` (newest), Program Files, then the `roblox-studio:` handler in the registry | `/Applications/RobloxStudio.app`, `~/Applications` | `ROBLOX_MCP_STUDIO_PATH` only |
| Launch | `RobloxStudioBeta.exe -task EditFile -localPlaceFile <path>` / `-task EditPlace -placeId <id>` | `open -a RobloxStudio <path>` / `open "roblox-studio:…placeId:<id>"` | the configured executable |
| Processes | `Get-Process` | `pgrep -x RobloxStudio` | `pgrep -f RobloxStudio` |
| Window control | `user32.dll` (`ShowWindow`, `SetForegroundWindow`, `GetWindowRect`) with a `WScript.Shell.AppActivate` fallback | AppleScript `activate` + System Events geometry | `xdotool windowactivate`, falling back to `windowfocus`+`windowraise` for hosts without an EWMH window manager |
| Input | `System.Windows.Forms.SendKeys` | System Events `key code` / `keystroke … using {command down}` | `xdotool key --clearmodifiers` (or `key --window <id>` when the window cannot be focused) |
| Screenshot | GDI+ `CopyFromScreen` over the window rect (DPI-aware), resized with `Graphics.DrawImage` | `screencapture -x -R<x,y,w,h>`, resized with `sips -Z` | `import -window <id>` (or `magick`/`scrot`/`gnome-screenshot`/`spectacle`), resized with `convert` |
| Close | `CloseMainWindow()`, or `Stop-Process -Force` | `tell application "RobloxStudio" to quit`, or `pkill -9` | `xdotool windowclose`, or `pkill -9 -f` |

Implementation notes:

- **No shell is ever used.** Every call goes through `execFile` with an argv array, so no path or
  label can be interpreted as a command.
- **Windows scripts are not interpolated.** The PowerShell toolkit is a fixed script passed with
  `-EncodedCommand`; the destination path, max width, keystroke and force flag arrive in
  environment variables that the script reads. Nothing the agent supplies can change the code
  that runs.
- **Screenshots are downscaled server-side** (default `maxWidth` 1280) and returned as an MCP
  image block plus a JSON metadata block. Images over 8 MiB are saved to disk only.

## Prerequisites per platform

**Windows** — works out of the box. Windows PowerShell 5.1 (`powershell.exe`) is preferred
because `System.Windows.Forms` and `System.Drawing` are always present; with PowerShell 7 only,
install the .NET Windows Desktop runtime or input/screenshots report unavailable.

**macOS** — the process that runs the MCP server (your AI client, terminal, or launchd agent)
needs, in System Settings → Privacy & Security:

- **Accessibility** — for `send_studio_shortcut`, `start_play_solo`, `stop_play_solo` and native
  saving (System Events keystrokes),
- **Screen Recording** — for `capture_studio_screenshot`.

The first attempt triggers the prompt; until it is granted, the tools return a
`NativeUnavailable` error naming the exact permission. `sips` (bundled) is used for downscaling.

**Linux** — Roblox ships no Linux Studio build, so the plugin-bridge tools are the useful ones
here. The backend still exists so the server can run and be tested on Linux, and can drive a
Wine/Proton Studio via `ROBLOX_MCP_STUDIO_PATH`. Install `xdotool` plus ImageMagick
(`import`, `convert`, `identify`) for window control and screenshots; an X display is required
(Wayland needs XWayland).

## Security model

Native control is the most powerful part of this server, so it is fenced in:

1. **Two independent gates.** `ROBLOX_MCP_ALLOW_NATIVE=0` disables the whole layer;
   `ROBLOX_MCP_ALLOW_NATIVE_INPUT=0` keeps launching/screenshots but blocks every keystroke.
   Both refuse *before* anything is executed, and the error names the variable to change.
2. **A closed shortcut allowlist.** Only `play`, `run`, `stop`, `save`, `saveAs`, `undo`, `redo`,
   `escape`, `confirm` exist. There is no "type this text" or "press these keys" tool, so the
   server cannot be turned into a desktop remote control.
3. **Window verification before every keystroke.** The backend focuses Studio and checks the
   target window's title contains "Roblox Studio"; otherwise it refuses and says which window it
   saw. Keys are never sent to whatever happens to be focused.
4. **Place-path sandboxing.** `create_place_file` / `open_place_file` / `list_place_files` resolve
   paths and reject anything outside `ROBLOX_MCP_PLACES_ROOT` (default: your home directory),
   anything that is not `.rbxl`/`.rbxlx`, and any path containing a NUL byte. New places are only
   ever written as `.rbxlx`.
5. **No silent destruction.** `close_studio` asks the window to close by default (so Studio can
   prompt about unsaved changes); `force: true` is documented as discarding unsaved work.
   `create_place_file` refuses to overwrite unless `overwrite: true`.
6. **Screenshots stay local.** They are written under `ROBLOX_MCP_SCREENSHOT_DIR`
   (default `~/.roblox-studio-mcp/screenshots`) and only inlined into the MCP response, which
   goes to the AI client the user configured.

If you run this server on a shared or remote machine, consider
`ROBLOX_MCP_ALLOW_NATIVE_INPUT=0` and a narrow `ROBLOX_MCP_PLACES_ROOT`.

## The fully autonomous loop

```
get_host_capabilities                      → what can this machine do?
create_place_file  name="PetSim"           → a real .rbxlx on disk
launch_studio      placeFilePath="PetSim.rbxlx"
                                           → Studio boots, plugin peer connects
generate_terrain / create_instances_batch / install_scaffold / create_script
analyze_scripts                            → syntax clean?
start_play_solo                            → F5, waits for server + client peers
get_errors         peer="server"           → real runtime failures
eval_server_runtime code="…"               → inspect live state
patch_script_source                        → fix
stop_play_solo                             → back to edit mode
set_camera + capture_studio_screenshot     → look at the result
save_project                               → real Ctrl+S into the file
```

Because the place was created from a file, `save_project` saves silently. If you attach to a
place that has never been saved, Ctrl+S opens Studio's Save As dialog instead: `save_project`
detects that Studio stopped responding, tells you, and `send_studio_shortcut escape` cancels it.

## Manual acceptance checklist

CI runs on machines without Roblox Studio, so these steps are the human verification of the
last mile. On a Windows or macOS machine with Studio installed:

1. `get_host_capabilities` → `supported: true`, an `executablePath`, no blocking notes.
2. `create_place_file { name: "McpAcceptance", template: "baseplate" }` → the file exists.
3. `open_place_file { path: "McpAcceptance.rbxlx" }` → Studio opens the baseplate and
   `pluginConnected: true`.
4. `capture_studio_screenshot` → the returned image shows the baseplate and the Explorer.
5. `create_instance` a bright part, `set_camera` at it, screenshot again → the part is visible.
6. `start_play_solo` → Studio enters play mode and `serverPeer` + `clientPeer` are returned.
7. `eval_server_runtime { code: "return #game.Players:GetPlayers()" }` → returns 1.
8. `stop_play_solo` → Studio returns to edit mode.
9. `save_project` → `saved: true`, and the file's modification time changed.
10. `close_studio` → Studio closes.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `... is unavailable on this host: Native host control is disabled` | `ROBLOX_MCP_ALLOW_NATIVE=0`. Set it to `1` and restart the server. |
| `Input simulation is disabled` | `ROBLOX_MCP_ALLOW_NATIVE_INPUT=0`. |
| `Roblox Studio was not found on this machine` | Studio is not installed where expected. Set `ROBLOX_MCP_STUDIO_PATH`. |
| `No Roblox Studio window was found` | Studio is closed or minimized to the tray. Run `launch_studio`, or restore the window. |
| `Refusing to send input: the focused window is "…"` | Another window stole focus, or several Studio-like windows exist. Retry; the backend re-focuses each time. |
| macOS: `macOS blocked the automation request` | Grant Accessibility (input) / Screen Recording (screenshots) to the process running the server, then retry. |
| Windows: `inputSimulation.available: false` | PowerShell 7 without the .NET Windows Desktop runtime. Use `powershell.exe` (5.1) or install the runtime. |
| Linux: `xdotool is not installed` / `No screenshot tool found` | `apt install xdotool imagemagick`. |
| Studio launches but no peer connects | The plugin is not installed or has no saved token. Run `--install-plugin`, then connect once from the MCP widget in edit mode so playtest DataModels can auto-connect. |
| `start_play_solo` returns `running: false` | Studio did not enter play mode (check for a modal dialog with `capture_studio_screenshot { fullScreen: true }`), or the plugin has no saved token. |
