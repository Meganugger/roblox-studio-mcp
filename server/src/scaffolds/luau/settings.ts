import { Scaffold } from "../types.js";

const SETTINGS_SERVICE = `--!strict
-- SettingsService: schema-validated, profile-persisted player settings.
-- Installed by Roblox Studio MCP (scaffold: settings).
--
-- Client:
--   Net.invoke("Settings:Get")               -> { MusicVolume = 0.5, ... }
--   Net.invoke("Settings:Set", key, value)   -> { ok, reason? }
--   Net.event("Settings:Changed")            -> (key, value)

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Net = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("Net"))

-- Whitelisted settings with validators; anything else is rejected server-side.
local SCHEMA: { [string]: (value: any) -> boolean } = {
	MusicVolume = function(v)
		return type(v) == "number" and v >= 0 and v <= 1
	end,
	SfxVolume = function(v)
		return type(v) == "number" and v >= 0 and v <= 1
	end,
	ReducedMotion = function(v)
		return type(v) == "boolean"
	end,
	ShowDamageNumbers = function(v)
		return type(v) == "boolean"
	end,
}

local SettingsService = {}
local DataService: any = nil

local function settingsOf(player: Player): { [string]: any }?
	local profile = DataService:GetProfile(player)
	if not profile then
		return nil
	end
	if type(profile.Settings) ~= "table" then
		profile.Settings = {}
	end
	return profile.Settings
end

function SettingsService:Get(player: Player, key: string): any
	local settings = settingsOf(player)
	return settings and settings[key] or nil
end

function SettingsService:Set(player: Player, key: string, value: any): (boolean, string?)
	local validator = SCHEMA[key]
	if not validator then
		return false, "unknown setting"
	end
	if not validator(value) then
		return false, "invalid value"
	end
	local settings = settingsOf(player)
	if not settings then
		return false, "profile not loaded"
	end
	settings[key] = value
	DataService:MarkDirty(player)
	Net.fireClient("Settings:Changed", player, key, value)
	return true, nil
end

function SettingsService:Init(services: { [string]: any })
	DataService = assert(services.DataService, "SettingsService requires DataService (install scaffold data-profiles)")
end

function SettingsService:Start()
	Net.onInvoke("Settings:Get", function(player: Player)
		return settingsOf(player) or {}
	end)

	Net.onInvoke("Settings:Set", function(player: Player, key: any, value: any)
		if type(key) ~= "string" then
			return { ok = false, reason = "invalid request" }
		end
		local ok, reason = SettingsService:Set(player, key, value)
		return { ok = ok, reason = reason }
	end, { ratePerSecond = 5 })
end

return SettingsService
`;

export const settingsScaffold: Scaffold = {
  id: "settings",
  title: "Player settings",
  description:
    "Profile-persisted player settings (music/SFX volume, reduced motion, damage numbers) behind a strict " +
    "server-side validation schema. Unknown keys and out-of-range values are rejected.",
  dependencies: ["core", "data-profiles"],
  files: [
    {
      parentPath: "game.ServerScriptService.Server.Services",
      className: "ModuleScript",
      name: "SettingsService",
      source: SETTINGS_SERVICE,
    },
  ],
};
