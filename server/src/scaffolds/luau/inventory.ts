import { Scaffold } from "../types.js";

const INVENTORY_SERVICE = `--!strict
-- InventoryService: profile-backed item inventory with equip slots.
-- Installed by Roblox Studio MCP (scaffold: inventory).
--
-- API (server):
--   InventoryService:GetCount(player, itemId)      -> number
--   InventoryService:AddItem(player, itemId, n)    -> newCount
--   InventoryService:RemoveItem(player, itemId, n) -> success, newCountOrReason
--   InventoryService:Equip(player, slot, itemId)   -> success, reason?
--   InventoryService:GetEquipped(player, slot)     -> itemId?
-- Client:
--   Net.invoke("Inventory:Get")                    -> { items = {...}, equipped = {...} }
--   Net.event("Inventory:Changed")                 -> fired after any change

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Net = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("Net"))

local InventoryService = {}
local DataService: any = nil

local MAX_STACK = 999_999

local function inventoryOf(player: Player): { [string]: number }?
	local profile = DataService:GetProfile(player)
	if not profile then
		return nil
	end
	if type(profile.Inventory) ~= "table" then
		profile.Inventory = {}
	end
	return profile.Inventory
end

local function equippedOf(player: Player): { [string]: string }?
	local profile = DataService:GetProfile(player)
	if not profile then
		return nil
	end
	if type(profile.Equipped) ~= "table" then
		profile.Equipped = {}
	end
	return profile.Equipped
end

local function notify(player: Player)
	Net.fireClient("Inventory:Changed", player)
end

function InventoryService:GetCount(player: Player, itemId: string): number
	local inventory = inventoryOf(player)
	if not inventory then
		return 0
	end
	return inventory[itemId] or 0
end

function InventoryService:AddItem(player: Player, itemId: string, count: number?): number
	local n = count or 1
	assert(type(itemId) == "string" and #itemId > 0, "itemId must be a non-empty string")
	assert(n > 0 and n == math.floor(n) and n < MAX_STACK, "count must be a positive integer")
	local inventory = inventoryOf(player)
	if not inventory then
		return 0
	end
	inventory[itemId] = math.min((inventory[itemId] or 0) + n, MAX_STACK)
	DataService:MarkDirty(player)
	notify(player)
	return inventory[itemId]
end

function InventoryService:RemoveItem(player: Player, itemId: string, count: number?): (boolean, any)
	local n = count or 1
	if n <= 0 or n ~= math.floor(n) then
		return false, "invalid count"
	end
	local inventory = inventoryOf(player)
	if not inventory then
		return false, "profile not loaded"
	end
	local have = inventory[itemId] or 0
	if have < n then
		return false, "not enough items"
	end
	local remaining = have - n
	inventory[itemId] = if remaining > 0 then remaining else nil
	-- Unequip if the last one was removed.
	if remaining == 0 then
		local equipped = equippedOf(player)
		if equipped then
			for slot, equippedId in equipped do
				if equippedId == itemId then
					equipped[slot] = nil
				end
			end
		end
	end
	DataService:MarkDirty(player)
	notify(player)
	return true, remaining
end

function InventoryService:Equip(player: Player, slot: string, itemId: string?): (boolean, string?)
	if type(slot) ~= "string" or #slot == 0 or #slot > 40 then
		return false, "invalid slot"
	end
	local equipped = equippedOf(player)
	if not equipped then
		return false, "profile not loaded"
	end
	if itemId == nil then
		equipped[slot] = nil
	else
		if InventoryService:GetCount(player, itemId) <= 0 then
			return false, "item not owned"
		end
		equipped[slot] = itemId
	end
	DataService:MarkDirty(player)
	notify(player)
	return true, nil
end

function InventoryService:GetEquipped(player: Player, slot: string): string?
	local equipped = equippedOf(player)
	return equipped and equipped[slot] or nil
end

function InventoryService:Init(services: { [string]: any })
	DataService = assert(services.DataService, "InventoryService requires DataService (install scaffold data-profiles)")
end

function InventoryService:Start()
	Net.onInvoke("Inventory:Get", function(player: Player)
		local inventory = inventoryOf(player)
		local equipped = equippedOf(player)
		return { items = inventory or {}, equipped = equipped or {} }
	end)

	Net.onEvent("Inventory:Equip", function(player: Player, slot: any, itemId: any)
		if type(slot) ~= "string" then
			return
		end
		if itemId ~= nil and type(itemId) ~= "string" then
			return
		end
		InventoryService:Equip(player, slot, itemId)
	end, { ratePerSecond = 5 })
end

return InventoryService
`;

export const inventoryScaffold: Scaffold = {
  id: "inventory",
  title: "Inventory system",
  description:
    "Profile-backed item inventory with stack counts, equip slots, server-side ownership validation, " +
    "and client sync remotes. Pairs with the shop scaffold for purchases.",
  dependencies: ["core", "data-profiles"],
  files: [
    {
      parentPath: "game.ServerScriptService.Server.Services",
      className: "ModuleScript",
      name: "InventoryService",
      source: INVENTORY_SERVICE,
    },
  ],
};
