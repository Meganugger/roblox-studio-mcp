--!strict
-- Roblox Studio MCP plugin entrypoint.
-- Wires together: output capture, connection UI, HTTP bridge and executors.

if not plugin then
	return
end

local RunService = game:GetService("RunService")

-- Only operate in edit-mode Studio sessions (the plugin also keeps working
-- during Run-mode simulations started from edit mode, which is what we want
-- for playtest control).
if not RunService:IsStudio() then
	return
end

local Logger = require(script.Parent.Logger)
local OutputCapture = require(script.Parent.OutputCapture)
local UI = require(script.Parent.UI)
local Bridge = require(script.Parent.Bridge)
local ProjectExecutor = require(script.Parent.Executors.Project) :: any

local COLORS = UI.COLORS

OutputCapture.start()

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

plugin.Unloading:Connect(function()
	Bridge.stop()
	OutputCapture.stop()
end)

Logger.info("Roblox Studio MCP plugin loaded. Open the MCP panel from the toolbar to connect.")
