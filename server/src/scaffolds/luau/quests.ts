import { Scaffold } from "../types.js";

const QUEST_DEFS = `--!strict
-- QuestDefinitions: data-driven quest list. Objectives are counters advanced by
-- QuestService:AddProgress(player, statKey, amount) from your gameplay code.
-- Installed by Roblox Studio MCP (scaffold: quests).

export type QuestDef = {
	id: string,
	name: string,
	description: string,
	statKey: string, -- progress source, e.g. "CoinsCollected", "EnemiesDefeated"
	target: number,
	rewardCurrency: string,
	rewardAmount: number,
	rewardXP: number?,
}

local quests: { QuestDef } = {
	{
		id = "collect_100_coins",
		name = "Coin Collector",
		description = "Collect 100 coins.",
		statKey = "CoinsCollected",
		target = 100,
		rewardCurrency = "Coins",
		rewardAmount = 250,
		rewardXP = 50,
	},
	{
		id = "defeat_10_enemies",
		name = "Monster Hunter",
		description = "Defeat 10 enemies.",
		statKey = "EnemiesDefeated",
		target = 10,
		rewardCurrency = "Gems",
		rewardAmount = 5,
		rewardXP = 100,
	},
	{
		id = "play_10_minutes",
		name = "Getting Comfortable",
		description = "Play for 10 minutes.",
		statKey = "MinutesPlayed",
		target = 10,
		rewardCurrency = "Coins",
		rewardAmount = 100,
		rewardXP = 25,
	},
}

local byId: { [string]: QuestDef } = {}
for _, quest in quests do
	byId[quest.id] = quest
end

return {
	Quests = quests,
	ById = byId,
}
`;

const QUEST_SERVICE = `--!strict
-- QuestService: tracks quest progress in player profiles, pays rewards on claim.
-- Installed by Roblox Studio MCP (scaffold: quests).
--
-- Server:
--   QuestService:AddProgress(player, statKey, amount) -- call from gameplay code
-- Client:
--   Net.invoke("Quests:Get")          -> { { id, name, description, progress, target, completed, claimed } }
--   Net.invoke("Quests:Claim", id)    -> { ok, reason? }
--   Net.event("Quests:Updated")       -> fired when any quest progresses/completes

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Net = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("Net"))
local QuestDefinitions = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("QuestDefinitions"))

local QuestService = {}
local DataService: any = nil
local CurrencyService: any = nil
local ProgressionService: any = nil -- optional

local function questState(profile: { [string]: any }, questId: string): { [string]: any }
	if type(profile.Quests) ~= "table" then
		profile.Quests = {}
	end
	local state = profile.Quests[questId]
	if type(state) ~= "table" then
		state = { progress = 0, completed = false, claimed = false }
		profile.Quests[questId] = state
	end
	return state
end

function QuestService:AddProgress(player: Player, statKey: string, amount: number)
	if amount <= 0 then
		return
	end
	local profile = DataService:GetProfile(player)
	if not profile then
		return
	end
	local changed = false
	for _, quest in QuestDefinitions.Quests do
		if quest.statKey == statKey then
			local state = questState(profile, quest.id)
			if not state.completed then
				state.progress = math.min(state.progress + amount, quest.target)
				if state.progress >= quest.target then
					state.completed = true
				end
				changed = true
			end
		end
	end
	if changed then
		DataService:MarkDirty(player)
		Net.fireClient("Quests:Updated", player)
	end
end

function QuestService:Claim(player: Player, questId: string): (boolean, string?)
	local quest = QuestDefinitions.ById[questId]
	if not quest then
		return false, "unknown quest"
	end
	local profile = DataService:GetProfile(player)
	if not profile then
		return false, "profile not loaded"
	end
	local state = questState(profile, questId)
	if not state.completed then
		return false, "quest not completed"
	end
	if state.claimed then
		return false, "already claimed"
	end
	state.claimed = true
	CurrencyService:Add(player, quest.rewardCurrency, quest.rewardAmount)
	if quest.rewardXP and ProgressionService then
		ProgressionService:AddXP(player, quest.rewardXP)
	end
	DataService:MarkDirty(player)
	Net.fireClient("Quests:Updated", player)
	return true, nil
end

function QuestService:Init(services: { [string]: any })
	DataService = assert(services.DataService, "QuestService requires DataService (install scaffold data-profiles)")
	CurrencyService = assert(services.CurrencyService, "QuestService requires CurrencyService (install scaffold currency)")
	ProgressionService = services.ProgressionService -- optional integration
end

function QuestService:Start()
	Net.onInvoke("Quests:Get", function(player: Player)
		local profile = DataService:GetProfile(player)
		if not profile then
			return {}
		end
		local view = {}
		for _, quest in QuestDefinitions.Quests do
			local state = questState(profile, quest.id)
			table.insert(view, {
				id = quest.id,
				name = quest.name,
				description = quest.description,
				progress = state.progress,
				target = quest.target,
				completed = state.completed,
				claimed = state.claimed,
			})
		end
		return view
	end)

	Net.onInvoke("Quests:Claim", function(player: Player, questId: any)
		if type(questId) ~= "string" then
			return { ok = false, reason = "invalid request" }
		end
		local ok, reason = QuestService:Claim(player, questId)
		return { ok = ok, reason = reason }
	end, { ratePerSecond = 3 })

	-- Built-in playtime quest driver.
	task.spawn(function()
		while true do
			task.wait(60)
			for _, player in game:GetService("Players"):GetPlayers() do
				QuestService:AddProgress(player, "MinutesPlayed", 1)
			end
		end
	end)
end

return QuestService
`;

export const questsScaffold: Scaffold = {
  id: "quests",
  title: "Quest system",
  description:
    "Data-driven quests with counter objectives, profile-persisted progress, completion detection, claimable " +
    "currency/XP rewards, client sync remotes and a built-in playtime driver. Advance any quest from gameplay " +
    "code with a single AddProgress call.",
  dependencies: ["core", "data-profiles", "currency"],
  files: [
    {
      parentPath: "game.ReplicatedStorage.Shared",
      className: "ModuleScript",
      name: "QuestDefinitions",
      source: QUEST_DEFS,
    },
    {
      parentPath: "game.ServerScriptService.Server.Services",
      className: "ModuleScript",
      name: "QuestService",
      source: QUEST_SERVICE,
    },
  ],
};
