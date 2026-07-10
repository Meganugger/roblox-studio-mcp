import { Scaffold } from "../types.js";

const UI_KIT = `--!strict
-- UIKit: themed, responsive UI factory for menus, HUDs and notifications.
-- Installed by Roblox Studio MCP (scaffold: ui-kit).
--
-- local UIKit = require(ReplicatedStorage.Shared.UIKit)
-- local screen = UIKit.screen("MyScreen")
-- local panel = UIKit.panel(screen, UDim2.fromScale(0.3, 0.4))
-- UIKit.button(panel, "Play", function() ... end)
-- UIKit.notify("Quest complete!")

local TweenService = game:GetService("TweenService")
local Players = game:GetService("Players")

local UIKit = {}

UIKit.Theme = {
	Background = Color3.fromRGB(24, 26, 34),
	Surface = Color3.fromRGB(36, 39, 50),
	Primary = Color3.fromRGB(88, 133, 255),
	PrimaryHover = Color3.fromRGB(114, 152, 255),
	Success = Color3.fromRGB(70, 200, 120),
	Danger = Color3.fromRGB(235, 87, 87),
	Text = Color3.fromRGB(236, 239, 244),
	TextMuted = Color3.fromRGB(148, 155, 170),
	CornerRadius = UDim.new(0, 10),
	Font = Enum.Font.GothamBold,
	BodyFont = Enum.Font.Gotham,
}

local function playerGui(): PlayerGui
	local player = Players.LocalPlayer
	return player:WaitForChild("PlayerGui") :: PlayerGui
end

local function corner(parent: Instance, radius: UDim?)
	local uiCorner = Instance.new("UICorner")
	uiCorner.CornerRadius = radius or UIKit.Theme.CornerRadius
	uiCorner.Parent = parent
end

local function pad(parent: Instance, pixels: number)
	local padding = Instance.new("UIPadding")
	local udim = UDim.new(0, pixels)
	padding.PaddingTop = udim
	padding.PaddingBottom = udim
	padding.PaddingLeft = udim
	padding.PaddingRight = udim
	padding.Parent = parent
end

function UIKit.screen(name: string): ScreenGui
	local gui = playerGui()
	local existing = gui:FindFirstChild(name)
	if existing and existing:IsA("ScreenGui") then
		return existing
	end
	local screen = Instance.new("ScreenGui")
	screen.Name = name
	screen.ResetOnSpawn = false
	screen.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
	screen.IgnoreGuiInset = false
	screen.Parent = gui
	return screen
end

function UIKit.panel(parent: Instance, size: UDim2, position: UDim2?): Frame
	local frame = Instance.new("Frame")
	frame.Size = size
	frame.Position = position or UDim2.fromScale(0.5, 0.5)
	frame.AnchorPoint = Vector2.new(0.5, 0.5)
	frame.BackgroundColor3 = UIKit.Theme.Surface
	frame.BorderSizePixel = 0
	corner(frame)
	pad(frame, 12)
	frame.Parent = parent
	return frame
end

function UIKit.label(parent: Instance, text: string, options: { size: UDim2?, muted: boolean?, textSize: number? }?): TextLabel
	local opts = options or {}
	local label = Instance.new("TextLabel")
	label.Size = opts.size or UDim2.new(1, 0, 0, 28)
	label.BackgroundTransparency = 1
	label.Font = UIKit.Theme.BodyFont
	label.Text = text
	label.TextSize = opts.textSize or 18
	label.TextColor3 = if opts.muted then UIKit.Theme.TextMuted else UIKit.Theme.Text
	label.TextXAlignment = Enum.TextXAlignment.Left
	label.TextWrapped = true
	label.Parent = parent
	return label
end

function UIKit.button(parent: Instance, text: string, onClick: () -> (), options: { size: UDim2?, color: Color3? }?): TextButton
	local opts = options or {}
	local button = Instance.new("TextButton")
	button.Size = opts.size or UDim2.new(1, 0, 0, 44)
	button.BackgroundColor3 = opts.color or UIKit.Theme.Primary
	button.BorderSizePixel = 0
	button.Font = UIKit.Theme.Font
	button.Text = text
	button.TextSize = 20
	button.TextColor3 = UIKit.Theme.Text
	button.AutoButtonColor = false
	corner(button)
	button.Parent = parent

	local baseColor = button.BackgroundColor3
	local hoverColor = baseColor:Lerp(Color3.new(1, 1, 1), 0.15)
	local pressColor = baseColor:Lerp(Color3.new(0, 0, 0), 0.15)

	local function tweenTo(color: Color3, scale: number)
		TweenService:Create(button, TweenInfo.new(0.12, Enum.EasingStyle.Quad), {
			BackgroundColor3 = color,
		}):Play()
		TweenService:Create(button, TweenInfo.new(0.12, Enum.EasingStyle.Back), {
			Size = UDim2.new(
				(opts.size or UDim2.new(1, 0, 0, 44)).X.Scale * scale,
				(opts.size or UDim2.new(1, 0, 0, 44)).X.Offset,
				(opts.size or UDim2.new(1, 0, 0, 44)).Y.Scale,
				math.floor((opts.size or UDim2.new(1, 0, 0, 44)).Y.Offset * scale)
			),
		}):Play()
	end

	button.MouseEnter:Connect(function()
		tweenTo(hoverColor, 1)
	end)
	button.MouseLeave:Connect(function()
		tweenTo(baseColor, 1)
	end)
	button.MouseButton1Down:Connect(function()
		tweenTo(pressColor, 0.97)
	end)
	button.MouseButton1Up:Connect(function()
		tweenTo(hoverColor, 1)
	end)
	button.Activated:Connect(function()
		local ok, err = pcall(onClick)
		if not ok then
			warn("[UIKit] Button handler failed: " .. tostring(err))
		end
	end)
	return button
end

function UIKit.verticalList(parent: Instance, gapPixels: number?)
	local layout = Instance.new("UIListLayout")
	layout.FillDirection = Enum.FillDirection.Vertical
	layout.Padding = UDim.new(0, gapPixels or 8)
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.HorizontalAlignment = Enum.HorizontalAlignment.Center
	layout.Parent = parent
	return layout
end

function UIKit.progressBar(parent: Instance, size: UDim2?): (Frame, (fraction: number) -> ())
	local track = Instance.new("Frame")
	track.Size = size or UDim2.new(1, 0, 0, 14)
	track.BackgroundColor3 = UIKit.Theme.Background
	track.BorderSizePixel = 0
	corner(track, UDim.new(1, 0))
	track.Parent = parent

	local fill = Instance.new("Frame")
	fill.Name = "Fill"
	fill.Size = UDim2.fromScale(0, 1)
	fill.BackgroundColor3 = UIKit.Theme.Success
	fill.BorderSizePixel = 0
	corner(fill, UDim.new(1, 0))
	fill.Parent = track

	local function setFraction(fraction: number)
		local clamped = math.clamp(fraction, 0, 1)
		TweenService:Create(fill, TweenInfo.new(0.25, Enum.EasingStyle.Quad), {
			Size = UDim2.fromScale(clamped, 1),
		}):Play()
	end
	return track, setFraction
end

-- Toast notifications, stacked bottom-center, auto-dismissing.
local toastScreen: ScreenGui? = nil
local toastContainer: Frame? = nil

local function ensureToasts(): Frame
	if toastContainer and toastContainer.Parent then
		return toastContainer :: Frame
	end
	toastScreen = UIKit.screen("UIKitToasts")
	local container = Instance.new("Frame")
	container.Name = "Container"
	container.AnchorPoint = Vector2.new(0.5, 1)
	container.Position = UDim2.new(0.5, 0, 1, -24)
	container.Size = UDim2.new(0, 420, 0, 300)
	container.BackgroundTransparency = 1
	container.Parent = toastScreen
	local layout = Instance.new("UIListLayout")
	layout.FillDirection = Enum.FillDirection.Vertical
	layout.VerticalAlignment = Enum.VerticalAlignment.Bottom
	layout.HorizontalAlignment = Enum.HorizontalAlignment.Center
	layout.Padding = UDim.new(0, 8)
	layout.Parent = container
	toastContainer = container
	return container
end

function UIKit.notify(message: string, options: { duration: number?, color: Color3? }?)
	local opts = options or {}
	local container = ensureToasts()
	local toast = Instance.new("TextLabel")
	toast.Size = UDim2.new(1, 0, 0, 40)
	toast.BackgroundColor3 = opts.color or UIKit.Theme.Surface
	toast.BackgroundTransparency = 0.1
	toast.Font = UIKit.Theme.BodyFont
	toast.Text = message
	toast.TextSize = 17
	toast.TextColor3 = UIKit.Theme.Text
	toast.TextWrapped = true
	toast.BorderSizePixel = 0
	corner(toast)
	toast.Parent = container

	toast.TextTransparency = 1
	TweenService:Create(toast, TweenInfo.new(0.2), { TextTransparency = 0 }):Play()
	task.delay(opts.duration or 3, function()
		local fade = TweenService:Create(toast, TweenInfo.new(0.3), {
			TextTransparency = 1,
			BackgroundTransparency = 1,
		})
		fade.Completed:Connect(function()
			toast:Destroy()
		end)
		fade:Play()
	end)
end

return UIKit
`;

const HUD_CLIENT = `--!strict
-- HUD: currency counters, XP bar and live notifications, built with UIKit and
-- wired to the currency/progression remotes. Installed by Roblox Studio MCP (scaffold: ui-kit).

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local UIKit = require(Shared:WaitForChild("UIKit"))
local Net = require(Shared:WaitForChild("Net"))

local screen = UIKit.screen("HUD")

-- Top-left currency panel -----------------------------------------------------
local currencyPanel = Instance.new("Frame")
currencyPanel.AnchorPoint = Vector2.new(0, 0)
currencyPanel.Position = UDim2.new(0, 16, 0, 16)
currencyPanel.Size = UDim2.new(0, 200, 0, 76)
currencyPanel.BackgroundColor3 = UIKit.Theme.Surface
currencyPanel.BackgroundTransparency = 0.15
currencyPanel.BorderSizePixel = 0
currencyPanel.Parent = screen
do
	local uiCorner = Instance.new("UICorner")
	uiCorner.CornerRadius = UIKit.Theme.CornerRadius
	uiCorner.Parent = currencyPanel
	local padding = Instance.new("UIPadding")
	padding.PaddingTop = UDim.new(0, 8)
	padding.PaddingLeft = UDim.new(0, 12)
	padding.PaddingRight = UDim.new(0, 12)
	padding.Parent = currencyPanel
end
UIKit.verticalList(currencyPanel, 4)

local currencyLabels: { [string]: TextLabel } = {}
local function currencyLabel(currency: string, emoji: string): TextLabel
	local label = UIKit.label(currencyPanel, emoji .. " 0", { textSize = 20 })
	label.Name = currency
	currencyLabels[currency] = label
	label:SetAttribute("Emoji", emoji)
	return label
end
currencyLabel("Coins", "\u{1FA99}")
currencyLabel("Gems", "\u{1F48E}")

local function setCurrency(currency: string, amount: number)
	local label = currencyLabels[currency]
	if label then
		label.Text = (label:GetAttribute("Emoji") :: string? or "") .. " " .. tostring(amount)
	end
end

Net.event("Currency:Changed").OnClientEvent:Connect(setCurrency)

task.spawn(function()
	local balances = Net.invoke("Currency:GetBalances")
	if type(balances) == "table" then
		for currency, amount in balances do
			setCurrency(currency, amount)
		end
	end
end)

-- Bottom-center XP bar ---------------------------------------------------------
local xpPanel = Instance.new("Frame")
xpPanel.AnchorPoint = Vector2.new(0.5, 1)
xpPanel.Position = UDim2.new(0.5, 0, 1, -12)
xpPanel.Size = UDim2.new(0, 360, 0, 46)
xpPanel.BackgroundTransparency = 1
xpPanel.Parent = screen

local levelLabel = UIKit.label(xpPanel, "Level 1", { size = UDim2.new(1, 0, 0, 20), textSize = 16 })
levelLabel.TextXAlignment = Enum.TextXAlignment.Center

local _track, setXP = UIKit.progressBar(xpPanel, UDim2.new(1, 0, 0, 12))
_track.Position = UDim2.new(0, 0, 0, 26)

Net.event("Progression:Changed").OnClientEvent:Connect(function(xp: number, level: number, xpForNext: number)
	levelLabel.Text = ("Level %d  \u{00B7}  %d / %d XP"):format(level, xp, xpForNext)
	setXP(if xpForNext > 0 then xp / xpForNext else 0)
end)

Net.event("Progression:LevelUp").OnClientEvent:Connect(function(newLevel: number)
	UIKit.notify(("Level up! You reached level %d \u{1F389}"):format(newLevel), { color = UIKit.Theme.Success })
end)

Net.event("Progression:Achievement").OnClientEvent:Connect(function(_id: string, name: string)
	UIKit.notify("Achievement unlocked: " .. name .. " \u{1F3C6}", { color = UIKit.Theme.Primary })
end)

task.spawn(function()
	local data = Net.invoke("Progression:Get")
	if type(data) == "table" then
		levelLabel.Text = ("Level %d  \u{00B7}  %d / %d XP"):format(data.level, data.xp, data.xpForNextLevel)
		setXP(if data.xpForNextLevel > 0 then data.xp / data.xpForNextLevel else 0)
	end
end)
`;

const MAIN_MENU_CLIENT = `--!strict
-- MainMenu: title screen with animated entrance and Play button.
-- Installed by Roblox Studio MCP (scaffold: ui-kit).

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local UIKit = require(Shared:WaitForChild("UIKit"))

local screen = UIKit.screen("MainMenu")
screen.DisplayOrder = 100

local backdrop = Instance.new("Frame")
backdrop.Size = UDim2.fromScale(1, 1)
backdrop.BackgroundColor3 = UIKit.Theme.Background
backdrop.BackgroundTransparency = 0.25
backdrop.BorderSizePixel = 0
backdrop.Parent = screen

local panel = UIKit.panel(backdrop, UDim2.new(0, 340, 0, 240))
UIKit.verticalList(panel, 12)

local title = UIKit.label(panel, game.Name ~= "Place" and game.Name or "My Game", {
	size = UDim2.new(1, 0, 0, 48),
	textSize = 34,
})
title.Font = UIKit.Theme.Font
title.TextXAlignment = Enum.TextXAlignment.Center

local subtitle = UIKit.label(panel, "Built with Roblox Studio MCP", {
	size = UDim2.new(1, 0, 0, 22),
	muted = true,
})
subtitle.TextXAlignment = Enum.TextXAlignment.Center

local function close()
	local tween = TweenService:Create(backdrop, TweenInfo.new(0.35, Enum.EasingStyle.Quad), {
		BackgroundTransparency = 1,
	})
	tween.Completed:Connect(function()
		screen.Enabled = false
	end)
	tween:Play()
	for _, descendant in panel:GetDescendants() do
		if descendant:IsA("TextLabel") or descendant:IsA("TextButton") then
			TweenService:Create(descendant, TweenInfo.new(0.25), { TextTransparency = 1 }):Play()
		end
	end
	TweenService:Create(panel, TweenInfo.new(0.3), { BackgroundTransparency = 1 }):Play()
end

UIKit.button(panel, "Play", close, { size = UDim2.new(0.8, 0, 0, 48) })

-- Animated entrance
panel.Position = UDim2.fromScale(0.5, 0.62)
TweenService:Create(panel, TweenInfo.new(0.45, Enum.EasingStyle.Back, Enum.EasingDirection.Out), {
	Position = UDim2.fromScale(0.5, 0.5),
}):Play()
`;

export const uiKitScaffold: Scaffold = {
  id: "ui-kit",
  title: "UI kit (theme, HUD, menu, notifications)",
  description:
    "Client UI foundation: a themed UIKit factory (panels, animated buttons, labels, progress bars, toast " +
    "notifications, responsive scaling), a HUD that auto-binds to currency/progression remotes, and an " +
    "animated main menu. Everything is built at runtime from code, so it is fully inspectable and editable.",
  dependencies: ["core"],
  files: [
    {
      parentPath: "game.ReplicatedStorage.Shared",
      className: "ModuleScript",
      name: "UIKit",
      source: UI_KIT,
    },
    {
      parentPath: "game.StarterPlayer.StarterPlayerScripts",
      className: "Folder",
      name: "Client",
    },
    {
      parentPath: "game.StarterPlayer.StarterPlayerScripts.Client",
      className: "LocalScript",
      name: "HUD",
      source: HUD_CLIENT,
    },
    {
      parentPath: "game.StarterPlayer.StarterPlayerScripts.Client",
      className: "LocalScript",
      name: "MainMenu",
      source: MAIN_MENU_CLIENT,
    },
  ],
};
