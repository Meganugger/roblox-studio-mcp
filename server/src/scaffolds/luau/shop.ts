import { Scaffold } from "../types.js";

const SHOP_CATALOG = `--!strict
-- ShopCatalog: single source of truth for purchasable items. Server validates
-- every purchase against this module, so clients can never invent prices.
-- Installed by Roblox Studio MCP (scaffold: shop).

export type CatalogItem = {
	id: string,
	name: string,
	description: string,
	currency: string, -- "Coins" | "Gems"
	price: number,
	category: string,
	maxOwned: number?, -- nil = unlimited
}

local catalog: { CatalogItem } = {
	{
		id = "wooden_sword",
		name = "Wooden Sword",
		description = "A trusty starter blade.",
		currency = "Coins",
		price = 100,
		category = "Weapons",
		maxOwned = 1,
	},
	{
		id = "iron_sword",
		name = "Iron Sword",
		description = "Sharper, heavier, better.",
		currency = "Coins",
		price = 750,
		category = "Weapons",
		maxOwned = 1,
	},
	{
		id = "health_potion",
		name = "Health Potion",
		description = "Restores 50 health.",
		currency = "Coins",
		price = 25,
		category = "Consumables",
	},
	{
		id = "vip_trail",
		name = "VIP Trail",
		description = "A shiny trail that follows you around.",
		currency = "Gems",
		price = 50,
		category = "Cosmetics",
		maxOwned = 1,
	},
}

local byId: { [string]: CatalogItem } = {}
for _, item in catalog do
	byId[item.id] = item
end

return {
	Items = catalog,
	ById = byId,
}
`;

const SHOP_SERVICE = `--!strict
-- ShopService: fully server-validated purchases against ShopCatalog.
-- Installed by Roblox Studio MCP (scaffold: shop).
--
-- Client:
--   Net.invoke("Shop:GetCatalog")       -> { CatalogItem }
--   Net.invoke("Shop:Buy", itemId)      -> { ok: boolean, reason: string?, balance: number? }
-- Server:
--   ShopService.ItemPurchased:Connect? -- use OnPurchase to hook custom grant logic

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Net = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("Net"))
local ShopCatalog = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("ShopCatalog"))

local ShopService = {}
local CurrencyService: any = nil
local InventoryService: any = nil

local purchaseHooks: { (player: Player, itemId: string) -> () } = {}

function ShopService:OnPurchase(callback: (player: Player, itemId: string) -> ())
	table.insert(purchaseHooks, callback)
end

function ShopService:Buy(player: Player, itemId: string): (boolean, string?, number?)
	local item = ShopCatalog.ById[itemId]
	if not item then
		return false, "unknown item", nil
	end
	if item.maxOwned and InventoryService:GetCount(player, item.id) >= item.maxOwned then
		return false, "already owned", nil
	end
	local ok, result = CurrencyService:Spend(player, item.currency, item.price)
	if not ok then
		return false, tostring(result), nil
	end
	InventoryService:AddItem(player, item.id, 1)
	for _, hook in purchaseHooks do
		task.spawn(hook, player, item.id)
	end
	return true, nil, result
end

function ShopService:Init(services: { [string]: any })
	CurrencyService = assert(services.CurrencyService, "ShopService requires CurrencyService (install scaffold currency)")
	InventoryService = assert(services.InventoryService, "ShopService requires InventoryService (install scaffold inventory)")
end

function ShopService:Start()
	Net.onInvoke("Shop:GetCatalog", function(_player: Player)
		return ShopCatalog.Items
	end, { ratePerSecond = 2 })

	Net.onInvoke("Shop:Buy", function(player: Player, itemId: any)
		if type(itemId) ~= "string" then
			return { ok = false, reason = "invalid request" }
		end
		local ok, reason, balance = ShopService:Buy(player, itemId)
		return { ok = ok, reason = reason, balance = balance }
	end, { ratePerSecond = 3 })
end

return ShopService
`;

export const shopScaffold: Scaffold = {
  id: "shop",
  title: "Shop system",
  description:
    "Server-validated shop: a shared ShopCatalog module (prices/currencies/purchase limits defined server-visible " +
    "only as data), purchase flow that debits currency and grants inventory atomically, purchase hooks for custom " +
    "grant logic, and rate-limited remotes. Clients can never spoof prices.",
  dependencies: ["core", "data-profiles", "currency", "inventory"],
  files: [
    {
      parentPath: "game.ReplicatedStorage.Shared",
      className: "ModuleScript",
      name: "ShopCatalog",
      source: SHOP_CATALOG,
    },
    {
      parentPath: "game.ServerScriptService.Server.Services",
      className: "ModuleScript",
      name: "ShopService",
      source: SHOP_SERVICE,
    },
  ],
};
