import { Scaffold } from "../types.js";

const LEADERBOARD_SERVICE = `--!strict
-- LeaderboardService: global top-N leaderboards on OrderedDataStore with
-- periodic publish and cached reads. Installed by Roblox Studio MCP (scaffold: leaderboard).
--
-- Server:
--   LeaderboardService:Publish(player, "Coins", value)  -- usually automatic
--   LeaderboardService:GetTop("Coins", 25)              -> { { userId, name, value } }
-- Client:
--   Net.invoke("Leaderboard:GetTop", "Coins")           -> cached top list

local DataStoreService = game:GetService("DataStoreService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Net = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("Net"))

local BOARDS = { "Coins", "Level" } -- profile keys to publish
local PUBLISH_INTERVAL = 60
local REFRESH_INTERVAL = 120
local TOP_N = 25

local LeaderboardService = {}
local DataService: any = nil

local stores: { [string]: OrderedDataStore } = {}
local cache: { [string]: { { userId: number, name: string, value: number } } } = {}

local function storeFor(board: string): OrderedDataStore?
	if stores[board] then
		return stores[board]
	end
	local ok, result = pcall(function()
		return DataStoreService:GetOrderedDataStore("Leaderboard_" .. board .. "_v1")
	end)
	if ok then
		stores[board] = result
		return result
	end
	return nil
end

function LeaderboardService:Publish(player: Player, board: string, value: number)
	local store = storeFor(board)
	if not store then
		return
	end
	pcall(function()
		store:SetAsync(tostring(player.UserId), math.max(0, math.floor(value)))
	end)
end

local function refresh(board: string)
	local store = storeFor(board)
	if not store then
		cache[board] = cache[board] or {}
		return
	end
	local ok, pages = pcall(function()
		return store:GetSortedAsync(false, TOP_N)
	end)
	if not ok then
		return
	end
	local top = {}
	for _, entry in pages:GetCurrentPage() do
		local userId = tonumber(entry.key) or 0
		local name = "Unknown"
		local nameOk, nameResult = pcall(function()
			return Players:GetNameFromUserIdAsync(userId)
		end)
		if nameOk then
			name = nameResult
		end
		table.insert(top, { userId = userId, name = name, value = entry.value })
	end
	cache[board] = top
end

function LeaderboardService:GetTop(board: string): { { userId: number, name: string, value: number } }
	return cache[board] or {}
end

function LeaderboardService:Init(services: { [string]: any })
	DataService = assert(services.DataService, "LeaderboardService requires DataService (install scaffold data-profiles)")
end

function LeaderboardService:Start()
	Net.onInvoke("Leaderboard:GetTop", function(_player: Player, board: any)
		if type(board) ~= "string" or table.find(BOARDS, board) == nil then
			return {}
		end
		return LeaderboardService:GetTop(board)
	end, { ratePerSecond = 1 })

	-- Publish loop: push each online player's tracked stats.
	task.spawn(function()
		while true do
			task.wait(PUBLISH_INTERVAL)
			for _, player in Players:GetPlayers() do
				local profile = DataService:GetProfile(player)
				if profile then
					for _, board in BOARDS do
						local value = profile[board]
						if type(value) == "number" then
							LeaderboardService:Publish(player, board, value)
						end
					end
				end
			end
		end
	end)

	-- Refresh loop: keep cached top lists warm.
	task.spawn(function()
		while true do
			for _, board in BOARDS do
				refresh(board)
			end
			task.wait(REFRESH_INTERVAL)
		end
	end)
end

return LeaderboardService
`;

export const leaderboardScaffold: Scaffold = {
  id: "leaderboard",
  title: "Global leaderboards",
  description:
    "Global top-N leaderboards on OrderedDataStore: periodic publishing of profile stats (Coins, Level by " +
    "default), cached top lists, username resolution, and a rate-limited client remote. Degrades gracefully " +
    "when DataStores are unavailable in Studio.",
  dependencies: ["core", "data-profiles"],
  files: [
    {
      parentPath: "game.ServerScriptService.Server.Services",
      className: "ModuleScript",
      name: "LeaderboardService",
      source: LEADERBOARD_SERVICE,
    },
  ],
};
