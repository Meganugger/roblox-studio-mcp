import { Scaffold } from "../types.js";

const BOOTSTRAP = `--!strict
-- Bootstrap: loads and starts every service module in Server/Services.
-- Lifecycle: all Init(services) first (wire cross-references), then all Start().
-- Installed by Roblox Studio MCP (scaffold: core).

local servicesFolder = script.Parent:WaitForChild("Services")

local services: { [string]: any } = {}
local ordered: { { name: string, service: any } } = {}

for _, child in servicesFolder:GetChildren() do
	if child:IsA("ModuleScript") then
		local ok, moduleOrErr = pcall(require, child)
		if ok then
			services[child.Name] = moduleOrErr
			table.insert(ordered, { name = child.Name, service = moduleOrErr })
		else
			warn(("[Bootstrap] Failed to require %s: %s"):format(child.Name, tostring(moduleOrErr)))
		end
	end
end

table.sort(ordered, function(a, b)
	return a.name < b.name
end)

for _, entry in ordered do
	if type(entry.service) == "table" and type(entry.service.Init) == "function" then
		local ok, err = pcall(entry.service.Init, entry.service, services)
		if not ok then
			warn(("[Bootstrap] %s:Init failed: %s"):format(entry.name, tostring(err)))
		end
	end
end

for _, entry in ordered do
	if type(entry.service) == "table" and type(entry.service.Start) == "function" then
		task.spawn(function()
			local ok, err = pcall(entry.service.Start, entry.service)
			if not ok then
				warn(("[Bootstrap] %s:Start failed: %s"):format(entry.name, tostring(err)))
			end
		end)
	end
end

print(("[Bootstrap] Started %d services"):format(#ordered))
`;

const NET = `--!strict
-- Net: namespaced remote creation + validated, rate-limited server handlers.
-- Shared by client and server. Installed by Roblox Studio MCP (scaffold: core).
--
-- Server:
--   Net.onEvent("Shop:Buy", function(player, itemId) ... end, { ratePerSecond = 5 })
--   Net.onInvoke("Shop:GetCatalog", function(player) return catalog end)
--   Net.fireClient("Currency:Changed", player, amount)
--   Net.fireAllClients("Round:State", state)
-- Client:
--   Net.event("Currency:Changed").OnClientEvent:Connect(...)
--   Net.invoke("Shop:GetCatalog")
--   Net.fireServer("Shop:Buy", itemId)

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local Net = {}

local REMOTES_FOLDER_NAME = "Remotes"

local function remotesFolder(): Folder
	local folder = ReplicatedStorage:FindFirstChild(REMOTES_FOLDER_NAME)
	if not folder then
		if RunService:IsServer() then
			folder = Instance.new("Folder")
			folder.Name = REMOTES_FOLDER_NAME
			folder.Parent = ReplicatedStorage
		else
			folder = ReplicatedStorage:WaitForChild(REMOTES_FOLDER_NAME)
		end
	end
	return folder :: Folder
end

local function getOrCreate(name: string, className: string): Instance
	local folder = remotesFolder()
	local existing = folder:FindFirstChild(name)
	if existing then
		return existing
	end
	if RunService:IsServer() then
		local remote = Instance.new(className)
		remote.Name = name
		remote.Parent = folder
		return remote
	end
	return folder:WaitForChild(name)
end

function Net.event(name: string): RemoteEvent
	return getOrCreate(name, "RemoteEvent") :: RemoteEvent
end

function Net.func(name: string): RemoteFunction
	return getOrCreate(name, "RemoteFunction") :: RemoteFunction
end

-- Per-player, per-remote token buckets to protect the server from spam.
local buckets: { [Player]: { [string]: { tokens: number, last: number } } } = {}

game:GetService("Players").PlayerRemoving:Connect(function(player)
	buckets[player] = nil
end)

local function allow(player: Player, name: string, ratePerSecond: number): boolean
	local perPlayer = buckets[player]
	if not perPlayer then
		perPlayer = {}
		buckets[player] = perPlayer
	end
	local bucket = perPlayer[name]
	local now = os.clock()
	if not bucket then
		bucket = { tokens = ratePerSecond, last = now }
		perPlayer[name] = bucket
	end
	bucket.tokens = math.min(ratePerSecond, bucket.tokens + (now - bucket.last) * ratePerSecond)
	bucket.last = now
	if bucket.tokens >= 1 then
		bucket.tokens -= 1
		return true
	end
	return false
end

export type HandlerOptions = { ratePerSecond: number? }

function Net.onEvent(name: string, handler: (player: Player, ...any) -> (), options: HandlerOptions?)
	assert(RunService:IsServer(), "Net.onEvent is server-only")
	local rate = (options and options.ratePerSecond) or 10
	Net.event(name).OnServerEvent:Connect(function(player, ...)
		if not allow(player, name, rate) then
			return
		end
		local ok, err = pcall(handler, player, ...)
		if not ok then
			warn(("[Net] Handler for %s failed: %s"):format(name, tostring(err)))
		end
	end)
end

function Net.onInvoke(name: string, handler: (player: Player, ...any) -> any, options: HandlerOptions?)
	assert(RunService:IsServer(), "Net.onInvoke is server-only")
	local rate = (options and options.ratePerSecond) or 10
	Net.func(name).OnServerInvoke = function(player, ...)
		if not allow(player, name, rate) then
			return nil
		end
		local ok, resultOrErr = pcall(handler, player, ...)
		if ok then
			return resultOrErr
		end
		warn(("[Net] Invoke handler for %s failed: %s"):format(name, tostring(resultOrErr)))
		return nil
	end
end

function Net.fireClient(name: string, player: Player, ...: any)
	Net.event(name):FireClient(player, ...)
end

function Net.fireAllClients(name: string, ...: any)
	Net.event(name):FireAllClients(...)
end

function Net.fireServer(name: string, ...: any)
	Net.event(name):FireServer(...)
end

function Net.invoke(name: string, ...: any): any
	return Net.func(name):InvokeServer(...)
end

return Net
`;

export const coreScaffold: Scaffold = {
  id: "core",
  title: "Core framework (Bootstrap + Net)",
  description:
    "Foundation every other scaffold builds on: a service Bootstrap runner (Init/Start lifecycle for " +
    "ModuleScript services in ServerScriptService.Server.Services) and a shared Net module providing " +
    "namespaced remotes with rate-limited, pcall-guarded server handlers.",
  dependencies: [],
  files: [
    { parentPath: "game.ServerScriptService", className: "Folder", name: "Server" },
    { parentPath: "game.ServerScriptService.Server", className: "Folder", name: "Services" },
    { parentPath: "game.ServerScriptService.Server", className: "Script", name: "Bootstrap", source: BOOTSTRAP },
    { parentPath: "game.ReplicatedStorage", className: "Folder", name: "Shared" },
    { parentPath: "game.ReplicatedStorage.Shared", className: "ModuleScript", name: "Net", source: NET },
  ],
};
