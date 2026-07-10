--!strict
-- Roblox Studio MCP plugin entrypoint.
-- Wires together: output capture, connection UI, HTTP bridge and executors.
--
-- Contexts (protocol v2):
--  - Edit-mode Studio: full UI widget; user manages the connection. This peer
--    also hosts Run-mode simulations started by start_playtest.
--  - Playtest DataModels (play solo / multiplayer test): Studio runs the
--    plugin again inside the play server and each play client. There we skip
--    the UI and auto-connect with the saved token, registering as "server" /
--    "client" peers so the MCP server can route runtime commands and read
--    per-peer logs (eval_server_runtime, eval_client_runtime, get_output_logs).

if not plugin then
	return
end

local RunService = game:GetService("RunService")

if not RunService:IsStudio() then
	return
end

local Logger = require(script.Parent.Logger)
local OutputCapture = require(script.Parent.OutputCapture)
local Bridge = require(script.Parent.Bridge)

-- Capture output in every context so boot-time prints are never lost.
OutputCapture.start()

plugin.Unloading:Connect(function()
	Bridge.stop()
	OutputCapture.stop()
end)

local context = Bridge.getContext()

if context ~= "edit" then
	-- Playtest peer: headless auto-connect using the settings saved in edit mode.
	local savedToken = plugin:GetSetting("mcpToken") :: string?
	local savedPort = tonumber(plugin:GetSetting("mcpPort")) :: number?
	if savedToken and #savedToken >= 16 then
		Bridge.start(savedToken, savedPort or require(script.Parent.Config).DEFAULT_PORT)
		Logger.info(("MCP %s peer connecting (playtest runtime debugging enabled)."):format(context))
	else
		Logger.info("MCP playtest peer idle: no saved token (connect once from the edit-mode widget first).")
	end
	return
end

-- Edit mode: full connection UI.
local UI = require(script.Parent.UI)
local ProjectExecutor = require(script.Parent.Executors.Project) :: any

local COLORS = UI.COLORS

local controller = UI.create(plugin)

ProjectExecutor.setNotifier(function(message: string)
	controller.notify("\u{1F4BE} " .. message)
end)

Bridge.onStatusChanged(function(status, detail)
	if status == "Connected" then
		controller.setStatus("Connected \u{2713}", COLORS.green)
		controller.setConnectButton(true)
	elseif status == "Connecting" then
		controller.setStatus("Connecting...", COLORS.yellow)
	elseif status == "AuthFailed" then
		controller.setStatus("Auth failed", COLORS.red)
		controller.notify(detail or "The server rejected the token. Copy the token from the MCP server logs.")
	elseif status == "HttpDisabled" then
		controller.setStatus("HTTP disabled", COLORS.red)
		controller.notify(detail or "Enable 'Allow HTTP Requests' in Game Settings > Security, then reconnect.")
	else
		controller.setStatus(if Bridge.isRunning() then "Reconnecting..." else "Disconnected", COLORS.red)
	end
end)

controller.onConnectToggle(function(wantsConnect)
	if wantsConnect then
		local token = controller.getToken()
		if #token < 16 then
			controller.setConnectButton(false)
			controller.notify("Paste the auth token first. The MCP server prints it on startup " ..
				"(and stores it in ~/.roblox-studio-mcp/token).")
			return
		end
		controller.setConnectButton(true)
		Bridge.start(token, controller.getPort())
	else
		controller.setConnectButton(false)
		Bridge.stop()
	end
end)

-- Auto-connect on startup when a token was previously saved.
do
	local savedToken = plugin:GetSetting("mcpToken") :: string?
	if savedToken and #savedToken >= 16 then
		controller.setConnectButton(true)
		Bridge.start(savedToken, controller.getPort())
	end
end

Logger.info("Roblox Studio MCP plugin loaded. Open the MCP panel from the toolbar to connect.")
