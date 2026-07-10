--!strict
-- UI: toolbar button + dock widget with connection status, token/port settings
-- and a message area for save requests and errors.

local Config = require(script.Parent.Config)

export type UIController = {
	setStatus: (statusText: string, color: Color3) -> (),
	notify: (message: string) -> (),
	getToken: () -> string,
	getPort: () -> number,
	onConnectToggle: (callback: (wantsConnect: boolean) -> ()) -> (),
	setConnectButton: (connected: boolean) -> (),
}

local UI = {}

local COLORS = {
	bg = Color3.fromRGB(37, 37, 40),
	surface = Color3.fromRGB(50, 50, 55),
	text = Color3.fromRGB(230, 230, 235),
	muted = Color3.fromRGB(160, 160, 170),
	green = Color3.fromRGB(90, 200, 120),
	red = Color3.fromRGB(235, 100, 100),
	yellow = Color3.fromRGB(235, 200, 90),
	blue = Color3.fromRGB(100, 150, 250),
}

function UI.create(plugin: Plugin): UIController
	local toolbar = plugin:CreateToolbar("Roblox Studio MCP")
	local toggleButton = toolbar:CreateButton(
		"MCP",
		"Open the Roblox Studio MCP connection panel",
		"rbxasset://textures/StudioSharedUI/robux_small.png"
	)
	toggleButton.ClickableWhenViewportHidden = true

	local widgetInfo = DockWidgetPluginGuiInfo.new(
		Enum.InitialDockState.Float,
		false,
		false,
		320,
		300,
		280,
		240
	)
	local widget = plugin:CreateDockWidgetPluginGui("RobloxStudioMCP", widgetInfo)
	widget.Title = "Roblox Studio MCP"

	toggleButton.Click:Connect(function()
		widget.Enabled = not widget.Enabled
	end)

	local root = Instance.new("Frame")
	root.Size = UDim2.fromScale(1, 1)
	root.BackgroundColor3 = COLORS.bg
	root.BorderSizePixel = 0
	root.Parent = widget

	local padding = Instance.new("UIPadding")
	padding.PaddingTop = UDim.new(0, 12)
	padding.PaddingBottom = UDim.new(0, 12)
	padding.PaddingLeft = UDim.new(0, 12)
	padding.PaddingRight = UDim.new(0, 12)
	padding.Parent = root

	local layout = Instance.new("UIListLayout")
	layout.FillDirection = Enum.FillDirection.Vertical
	layout.Padding = UDim.new(0, 8)
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Parent = root

	local function makeLabel(text: string, order: number, color: Color3?): TextLabel
		local label = Instance.new("TextLabel")
		label.Size = UDim2.new(1, 0, 0, 18)
		label.BackgroundTransparency = 1
		label.Font = Enum.Font.Gotham
		label.TextSize = 14
		label.TextXAlignment = Enum.TextXAlignment.Left
		label.TextColor3 = color or COLORS.muted
		label.Text = text
		label.LayoutOrder = order
		label.TextWrapped = true
		label.Parent = root
		return label
	end

	local statusLabel = makeLabel("Status: Disconnected", 1, COLORS.red)
	statusLabel.Font = Enum.Font.GothamBold
	statusLabel.TextSize = 16
	statusLabel.Size = UDim2.new(1, 0, 0, 22)

	makeLabel("Auth token (from MCP server logs):", 2)

	local tokenBox = Instance.new("TextBox")
	tokenBox.Size = UDim2.new(1, 0, 0, 30)
	tokenBox.BackgroundColor3 = COLORS.surface
	tokenBox.BorderSizePixel = 0
	tokenBox.Font = Enum.Font.Code
	tokenBox.TextSize = 13
	tokenBox.TextColor3 = COLORS.text
	tokenBox.PlaceholderText = "paste token here"
	tokenBox.ClearTextOnFocus = false
	tokenBox.Text = (plugin:GetSetting("mcpToken") :: string?) or ""
	tokenBox.LayoutOrder = 3
	tokenBox.Parent = root
	local tokenCorner = Instance.new("UICorner")
	tokenCorner.CornerRadius = UDim.new(0, 6)
	tokenCorner.Parent = tokenBox

	makeLabel(("Server port (default %d):"):format(Config.DEFAULT_PORT), 4)

	local portBox = Instance.new("TextBox")
	portBox.Size = UDim2.new(1, 0, 0, 30)
	portBox.BackgroundColor3 = COLORS.surface
	portBox.BorderSizePixel = 0
	portBox.Font = Enum.Font.Code
	portBox.TextSize = 13
	portBox.TextColor3 = COLORS.text
	portBox.ClearTextOnFocus = false
	portBox.Text = tostring((plugin:GetSetting("mcpPort") :: number?) or Config.DEFAULT_PORT)
	portBox.LayoutOrder = 5
	portBox.Parent = root
	local portCorner = Instance.new("UICorner")
	portCorner.CornerRadius = UDim.new(0, 6)
	portCorner.Parent = portBox

	local connectButton = Instance.new("TextButton")
	connectButton.Size = UDim2.new(1, 0, 0, 36)
	connectButton.BackgroundColor3 = COLORS.blue
	connectButton.BorderSizePixel = 0
	connectButton.Font = Enum.Font.GothamBold
	connectButton.TextSize = 16
	connectButton.TextColor3 = COLORS.text
	connectButton.Text = "Connect"
	connectButton.LayoutOrder = 6
	connectButton.Parent = root
	local buttonCorner = Instance.new("UICorner")
	buttonCorner.CornerRadius = UDim.new(0, 6)
	buttonCorner.Parent = connectButton

	local messageLabel = makeLabel("", 7, COLORS.yellow)
	messageLabel.Size = UDim2.new(1, 0, 0, 60)
	messageLabel.TextYAlignment = Enum.TextYAlignment.Top

	local wantsConnect = false
	local toggleCallback: ((wantsConnect: boolean) -> ())? = nil

	tokenBox.FocusLost:Connect(function()
		plugin:SetSetting("mcpToken", tokenBox.Text)
	end)
	portBox.FocusLost:Connect(function()
		local port = tonumber(portBox.Text)
		if port and port >= 1 and port <= 65535 then
			plugin:SetSetting("mcpPort", port)
		else
			portBox.Text = tostring(Config.DEFAULT_PORT)
		end
	end)

	connectButton.Activated:Connect(function()
		wantsConnect = not wantsConnect
		plugin:SetSetting("mcpToken", tokenBox.Text)
		local port = tonumber(portBox.Text) or Config.DEFAULT_PORT
		plugin:SetSetting("mcpPort", port)
		if toggleCallback then
			toggleCallback(wantsConnect)
		end
	end)

	local controller: UIController = {
		setStatus = function(statusText: string, color: Color3)
			statusLabel.Text = "Status: " .. statusText
			statusLabel.TextColor3 = color
		end,
		notify = function(message: string)
			messageLabel.Text = message
			widget.Enabled = true
		end,
		getToken = function()
			return tokenBox.Text
		end,
		getPort = function()
			return tonumber(portBox.Text) or Config.DEFAULT_PORT
		end,
		onConnectToggle = function(callback)
			toggleCallback = callback
		end,
		setConnectButton = function(connected: boolean)
			wantsConnect = connected
			connectButton.Text = if connected then "Disconnect" else "Connect"
			connectButton.BackgroundColor3 = if connected then COLORS.red else COLORS.blue
		end,
	}

	return controller
end

UI.COLORS = COLORS

return UI
