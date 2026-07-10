import { Scaffold } from "../types.js";

const DATA_SERVICE = `--!strict
-- DataService: player profiles on DataStore with retries, autosave and
-- save-on-leave + BindToClose. Installed by Roblox Studio MCP (scaffold: data-profiles).
--
-- API (server):
--   DataService:GetProfile(player)          -> profile table or nil (yields until loaded or failed)
--   DataService:OnProfileLoaded(callback)   -> connect (player, profile)
--   DataService:MarkDirty(player)           -- force save on next autosave tick
--
-- The profile template lives in ReplicatedStorage.Shared.ProfileTemplate; extend it
-- there and existing saves are reconciled (missing keys filled with defaults).

local DataStoreService = game:GetService("DataStoreService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local ProfileTemplate = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("ProfileTemplate"))

local DATASTORE_NAME = "PlayerProfiles_v1"
local AUTOSAVE_INTERVAL = 120
local MAX_LOAD_RETRIES = 3
local RETRY_DELAY = 2

local DataService = {}

type Profile = { [string]: any }

local profiles: { [Player]: Profile } = {}
local dirty: { [Player]: boolean } = {}
local loadedCallbacks: { (player: Player, profile: Profile) -> () } = {}

local function deepCopy(value: any): any
	if type(value) ~= "table" then
		return value
	end
	local copy = {}
	for k, v in value do
		copy[k] = deepCopy(v)
	end
	return copy
end

local function reconcile(target: Profile, template: Profile)
	for key, defaultValue in template do
		if target[key] == nil then
			target[key] = deepCopy(defaultValue)
		elseif type(defaultValue) == "table" and type(target[key]) == "table" then
			reconcile(target[key], defaultValue)
		end
	end
end

local function store(): DataStore?
	-- DataStores are unavailable in unpublished places or when Studio API access is off.
	local ok, result = pcall(function()
		return DataStoreService:GetDataStore(DATASTORE_NAME)
	end)
	if ok then
		return result
	end
	warn("[DataService] DataStore unavailable (unpublished place or Studio API access disabled). Using in-memory profiles.")
	return nil
end

local dataStore = store()

local function keyFor(userId: number): string
	return "player_" .. tostring(userId)
end

local function loadProfile(player: Player): Profile
	local profile: Profile? = nil
	if dataStore then
		for attempt = 1, MAX_LOAD_RETRIES do
			local ok, result = pcall(function()
				return (dataStore :: DataStore):GetAsync(keyFor(player.UserId))
			end)
			if ok then
				profile = result
				break
			end
			warn(("[DataService] Load attempt %d failed for %s: %s"):format(attempt, player.Name, tostring(result)))
			task.wait(RETRY_DELAY * attempt)
		end
	end
	if type(profile) ~= "table" then
		profile = deepCopy(ProfileTemplate)
	else
		reconcile(profile :: Profile, ProfileTemplate)
	end
	return profile :: Profile
end

local function saveProfile(player: Player): boolean
	local profile = profiles[player]
	if not profile or not dataStore then
		return dataStore == nil -- nothing to persist counts as success in memory mode
	end
	local ok, err = pcall(function()
		(dataStore :: DataStore):SetAsync(keyFor(player.UserId), profile)
	end)
	if not ok then
		warn(("[DataService] Save failed for %s: %s"):format(player.Name, tostring(err)))
	end
	return ok
end

function DataService:GetProfile(player: Player): Profile?
	local waited = 0
	while profiles[player] == nil and player.Parent ~= nil and waited < 30 do
		waited += task.wait(0.1)
	end
	return profiles[player]
end

function DataService:OnProfileLoaded(callback: (player: Player, profile: Profile) -> ())
	table.insert(loadedCallbacks, callback)
	-- Fire for players whose profiles already loaded.
	for player, profile in profiles do
		task.spawn(callback, player, profile)
	end
end

function DataService:MarkDirty(player: Player)
	dirty[player] = true
end

local function onPlayerAdded(player: Player)
	local profile = loadProfile(player)
	if player.Parent == nil then
		return
	end
	profiles[player] = profile
	for _, callback in loadedCallbacks do
		task.spawn(callback, player, profile)
	end
end

local function onPlayerRemoving(player: Player)
	saveProfile(player)
	profiles[player] = nil
	dirty[player] = nil
end

function DataService:Start()
	Players.PlayerAdded:Connect(onPlayerAdded)
	Players.PlayerRemoving:Connect(onPlayerRemoving)
	for _, player in Players:GetPlayers() do
		task.spawn(onPlayerAdded, player)
	end

	task.spawn(function()
		while true do
			task.wait(AUTOSAVE_INTERVAL)
			for player in profiles do
				if dirty[player] then
					dirty[player] = nil
					saveProfile(player)
				end
			end
		end
	end)

	if not RunService:IsStudio() then
		game:BindToClose(function()
			for player in profiles do
				saveProfile(player)
			end
		end)
	end
end

return DataService
`;

const PROFILE_TEMPLATE = `--!strict
-- ProfileTemplate: default save data for every player. Extend freely; existing
-- saves are reconciled with new keys automatically by DataService.
-- Installed by Roblox Studio MCP (scaffold: data-profiles).

return {
	Coins = 0,
	Gems = 0,
	XP = 0,
	Level = 1,
	Inventory = {}, -- { [itemId]: count }
	Equipped = {}, -- { [slot]: itemId }
	Quests = {}, -- { [questId]: { progress: number, completed: boolean, claimed: boolean } }
	Achievements = {}, -- { [achievementId]: true }
	Settings = {
		MusicVolume = 0.5,
		SfxVolume = 0.5,
	},
	Stats = {
		TotalPlayTime = 0,
		Kills = 0,
		Deaths = 0,
	},
}
`;

export const dataProfilesScaffold: Scaffold = {
  id: "data-profiles",
  title: "Player data profiles (DataStore)",
  description:
    "Robust player save system: DataStore-backed profiles with load retries, template reconciliation, " +
    "autosave, save-on-leave, BindToClose, and graceful in-memory fallback when DataStores are unavailable " +
    "in Studio. Other systems (currency, inventory, quests, progression, settings) store their data here.",
  dependencies: ["core"],
  files: [
    {
      parentPath: "game.ServerScriptService.Server.Services",
      className: "ModuleScript",
      name: "DataService",
      source: DATA_SERVICE,
    },
    {
      parentPath: "game.ReplicatedStorage.Shared",
      className: "ModuleScript",
      name: "ProfileTemplate",
      source: PROFILE_TEMPLATE,
    },
  ],
};
