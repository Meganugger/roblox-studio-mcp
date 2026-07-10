import { Scaffold } from "../types.js";

const PROGRESSION_SERVICE = `--!strict
-- ProgressionService: XP, levels and achievements persisted in profiles.
-- Installed by Roblox Studio MCP (scaffold: progression).
--
-- Server:
--   ProgressionService:AddXP(player, amount)
--   ProgressionService:GetLevel(player) -> number
--   ProgressionService:UnlockAchievement(player, id) -> firstTime: boolean
--   ProgressionService:OnLevelUp(callback(player, newLevel))
-- Client:
--   Net.event("Progression:Changed")   -> (xp, level, xpForNextLevel)
--   Net.event("Progression:LevelUp")   -> (newLevel)
--   Net.event("Progression:Achievement") -> (achievementId, name)

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Net = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("Net"))

local ProgressionService = {}
local DataService: any = nil
local CurrencyService: any = nil

local LEVEL_UP_COIN_REWARD = 100

local ACHIEVEMENTS: { [string]: { name: string, description: string } } = {
	first_level = { name = "Leveling Up!", description = "Reach level 2." },
	level_10 = { name = "Double Digits", description = "Reach level 10." },
	rich = { name = "Money Bags", description = "Hold 10,000 coins." },
}

local levelUpCallbacks: { (player: Player, newLevel: number) -> () } = {}

-- Linear-growth curve: XP needed to go from 'level' to 'level + 1'.
function ProgressionService.XPForLevel(level: number): number
	return 100 + (level - 1) * 50
end

local function mirrorLevel(player: Player, level: number)
	local stats = player:FindFirstChild("leaderstats")
	if not stats then
		stats = Instance.new("Folder")
		stats.Name = "leaderstats"
		stats.Parent = player
	end
	local value = stats:FindFirstChild("Level")
	if not value then
		value = Instance.new("IntValue")
		value.Name = "Level"
		value.Parent = stats
	end
	(value :: IntValue).Value = level
end

local function sync(player: Player, profile: { [string]: any })
	Net.fireClient("Progression:Changed", player, profile.XP or 0, profile.Level or 1,
		ProgressionService.XPForLevel(profile.Level or 1))
	mirrorLevel(player, profile.Level or 1)
end

function ProgressionService:GetLevel(player: Player): number
	local profile = DataService:GetProfile(player)
	return profile and (profile.Level or 1) or 1
end

function ProgressionService:OnLevelUp(callback: (player: Player, newLevel: number) -> ())
	table.insert(levelUpCallbacks, callback)
end

function ProgressionService:AddXP(player: Player, amount: number)
	assert(amount >= 0 and amount == amount and amount ~= math.huge, "XP amount must be finite and >= 0")
	local profile = DataService:GetProfile(player)
	if not profile then
		return
	end
	profile.XP = (profile.XP or 0) + math.floor(amount)
	local leveledUp = false
	while profile.XP >= ProgressionService.XPForLevel(profile.Level or 1) do
		profile.XP -= ProgressionService.XPForLevel(profile.Level or 1)
		profile.Level = (profile.Level or 1) + 1
		leveledUp = true
		if CurrencyService then
			CurrencyService:Add(player, "Coins", LEVEL_UP_COIN_REWARD)
		end
		Net.fireClient("Progression:LevelUp", player, profile.Level)
		for _, callback in levelUpCallbacks do
			task.spawn(callback, player, profile.Level)
		end
	end
	if leveledUp then
		if profile.Level >= 2 then
			ProgressionService:UnlockAchievement(player, "first_level")
		end
		if profile.Level >= 10 then
			ProgressionService:UnlockAchievement(player, "level_10")
		end
	end
	DataService:MarkDirty(player)
	sync(player, profile)
end

function ProgressionService:UnlockAchievement(player: Player, achievementId: string): boolean
	local def = ACHIEVEMENTS[achievementId]
	if not def then
		warn("[ProgressionService] Unknown achievement: " .. tostring(achievementId))
		return false
	end
	local profile = DataService:GetProfile(player)
	if not profile then
		return false
	end
	if type(profile.Achievements) ~= "table" then
		profile.Achievements = {}
	end
	if profile.Achievements[achievementId] then
		return false
	end
	profile.Achievements[achievementId] = true
	DataService:MarkDirty(player)
	Net.fireClient("Progression:Achievement", player, achievementId, def.name)
	return true
end

function ProgressionService:Init(services: { [string]: any })
	DataService = assert(services.DataService, "ProgressionService requires DataService (install scaffold data-profiles)")
	CurrencyService = services.CurrencyService -- optional integration
end

function ProgressionService:Start()
	DataService:OnProfileLoaded(function(player: Player, profile: { [string]: any })
		sync(player, profile)
	end)

	Net.onInvoke("Progression:Get", function(player: Player)
		local profile = DataService:GetProfile(player)
		if not profile then
			return nil
		end
		local achievements = {}
		for id in (profile.Achievements or {}) do
			local def = ACHIEVEMENTS[id]
			table.insert(achievements, { id = id, name = def and def.name or id })
		end
		return {
			xp = profile.XP or 0,
			level = profile.Level or 1,
			xpForNextLevel = ProgressionService.XPForLevel(profile.Level or 1),
			achievements = achievements,
		}
	end)
end

return ProgressionService
`;

export const progressionScaffold: Scaffold = {
  id: "progression",
  title: "Progression, rewards & achievements",
  description:
    "XP + level curve with automatic level-up currency rewards, level leaderstat, achievements with " +
    "first-unlock detection, level-up hooks for custom rewards, and client sync events.",
  dependencies: ["core", "data-profiles"],
  files: [
    {
      parentPath: "game.ServerScriptService.Server.Services",
      className: "ModuleScript",
      name: "ProgressionService",
      source: PROGRESSION_SERVICE,
    },
  ],
};
