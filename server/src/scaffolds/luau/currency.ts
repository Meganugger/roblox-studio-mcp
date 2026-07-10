import { Scaffold } from "../types.js";

const CURRENCY_SERVICE = `--!strict
-- CurrencyService: server-authoritative currencies with leaderstats mirroring
-- and client change notifications. Installed by Roblox Studio MCP (scaffold: currency).
--
-- API (server):
--   CurrencyService:Get(player, "Coins")            -> number
--   CurrencyService:Add(player, "Coins", 50)        -> newBalance
--   CurrencyService:Spend(player, "Coins", 25)      -> success, newBalanceOrReason
-- Client:
--   Net.event("Currency:Changed").OnClientEvent:Connect(function(currency, amount) ... end)

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Net = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("Net"))

local CURRENCIES = { "Coins", "Gems" }

local CurrencyService = {}
local DataService: any = nil

local function ensureLeaderstats(player: Player): Folder
	local stats = player:FindFirstChild("leaderstats")
	if not stats then
		stats = Instance.new("Folder")
		stats.Name = "leaderstats"
		stats.Parent = player
	end
	return stats :: Folder
end

local function mirror(player: Player, currency: string, amount: number)
	local stats = ensureLeaderstats(player)
	local value = stats:FindFirstChild(currency)
	if not value then
		value = Instance.new("IntValue")
		value.Name = currency
		value.Parent = stats
	end
	(value :: IntValue).Value = amount
	Net.fireClient("Currency:Changed", player, currency, amount)
end

local function isValidCurrency(currency: string): boolean
	return table.find(CURRENCIES, currency) ~= nil
end

function CurrencyService:Get(player: Player, currency: string): number
	assert(isValidCurrency(currency), "Unknown currency: " .. tostring(currency))
	local profile = DataService:GetProfile(player)
	if not profile then
		return 0
	end
	return profile[currency] or 0
end

function CurrencyService:Add(player: Player, currency: string, amount: number): number
	assert(isValidCurrency(currency), "Unknown currency: " .. tostring(currency))
	assert(amount >= 0 and amount == amount and amount ~= math.huge, "Amount must be a finite number >= 0")
	local profile = DataService:GetProfile(player)
	if not profile then
		return 0
	end
	profile[currency] = math.floor((profile[currency] or 0) + amount)
	DataService:MarkDirty(player)
	mirror(player, currency, profile[currency])
	return profile[currency]
end

function CurrencyService:Spend(player: Player, currency: string, amount: number): (boolean, any)
	assert(isValidCurrency(currency), "Unknown currency: " .. tostring(currency))
	if amount < 0 or amount ~= amount or amount == math.huge then
		return false, "invalid amount"
	end
	local profile = DataService:GetProfile(player)
	if not profile then
		return false, "profile not loaded"
	end
	local balance = profile[currency] or 0
	if balance < amount then
		return false, "insufficient funds"
	end
	profile[currency] = math.floor(balance - amount)
	DataService:MarkDirty(player)
	mirror(player, currency, profile[currency])
	return true, profile[currency]
end

function CurrencyService:Init(services: { [string]: any })
	DataService = assert(services.DataService, "CurrencyService requires DataService (install scaffold data-profiles)")
end

function CurrencyService:Start()
	DataService:OnProfileLoaded(function(player: Player, profile: { [string]: any })
		for _, currency in CURRENCIES do
			mirror(player, currency, profile[currency] or 0)
		end
	end)

	Net.onInvoke("Currency:GetBalances", function(player: Player)
		local balances = {}
		for _, currency in CURRENCIES do
			balances[currency] = CurrencyService:Get(player, currency)
		end
		return balances
	end)

	-- Keep leaderstats live for players already in game (Studio restarts, etc.)
	for _, player in Players:GetPlayers() do
		local profile = DataService:GetProfile(player)
		if profile then
			for _, currency in CURRENCIES do
				mirror(player, currency, profile[currency] or 0)
			end
		end
	end
end

return CurrencyService
`;

export const currencyScaffold: Scaffold = {
  id: "currency",
  title: "Currency system",
  description:
    "Server-authoritative multi-currency system (Coins, Gems by default) persisted in player profiles, " +
    "mirrored to leaderstats, with client change events and strict validation (no negative/NaN/inf exploits).",
  dependencies: ["core", "data-profiles"],
  files: [
    {
      parentPath: "game.ServerScriptService.Server.Services",
      className: "ModuleScript",
      name: "CurrencyService",
      source: CURRENCY_SERVICE,
    },
  ],
};
