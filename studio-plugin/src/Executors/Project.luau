--!strict
-- Project inspection and export command handlers.

local RunService = game:GetService("RunService")
local Selection = game:GetService("Selection")

local PathResolver = require(script.Parent.Parent.PathResolver)
local Serialization = require(script.Parent.Parent.Serialization)

local INSPECTED_SERVICES = {
	"Workspace",
	"ReplicatedStorage",
	"ReplicatedFirst",
	"ServerScriptService",
	"ServerStorage",
	"StarterGui",
	"StarterPack",
	"StarterPlayer",
	"Lighting",
	"SoundService",
	"Teams",
}

-- Set by Main so RequestSave can surface UI feedback.
local notifyFn: ((message: string) -> ())? = nil

local handlers: { [string]: (payload: { [string]: any }) -> any } = {}

local Project = {}

function Project.setNotifier(fn: (message: string) -> ())
	notifyFn = fn
end

handlers.GetStudioStatus = function(_payload)
	local camera = workspace.CurrentCamera
	return {
		placeName = game.Name,
		placeId = game.PlaceId,
		gameId = game.GameId,
		isRunning = RunService:IsRunning(),
		isEdit = RunService:IsEdit(),
		selectionCount = #Selection:Get(),
		cameraPosition = if camera then Serialization.encode(camera.CFrame.Position) else nil,
	}
end

handlers.GetProjectInfo = function(_payload)
	local services = {}
	for _, serviceName in INSPECTED_SERVICES do
		local ok, service = pcall(function()
			return game:GetService(serviceName :: any)
		end)
		if ok and typeof(service) == "Instance" then
			local descendants = service:GetDescendants()
			local scriptCount = 0
			for _, descendant in descendants do
				if descendant:IsA("LuaSourceContainer") then
					scriptCount += 1
				end
			end
			services[serviceName] = {
				children = #service:GetChildren(),
				descendants = #descendants,
				scripts = scriptCount,
			}
		end
	end

	local terrain = workspace.Terrain
	return {
		placeName = game.Name,
		placeId = game.PlaceId,
		gameId = game.GameId,
		services = services,
		hasTerrain = terrain ~= nil,
		lighting = Serialization.readProperties(game:GetService("Lighting")),
		spawnLocations = #workspace:GetDescendants() > 0 and (function()
			local spawns = {}
			for _, descendant in workspace:GetDescendants() do
				if descendant:IsA("SpawnLocation") then
					table.insert(spawns, PathResolver.pathOf(descendant))
				end
			end
			return spawns
		end)() or {},
	}
end

handlers.RequestSave = function(payload)
	local message = payload.message or "The AI assistant finished a batch of changes. Please save (Ctrl+S) or publish the place."
	warn("[RobloxStudioMCP] SAVE REQUESTED: " .. message)
	if notifyFn then
		notifyFn(message)
	end
	return {
		notified = true,
		note = "Roblox Studio does not allow plugins to save silently; the user was asked to save.",
	}
end

local function snapshotNode(
	instance: Instance,
	includeSources: boolean,
	budget: { remaining: number }
): { [string]: any }?
	if budget.remaining <= 0 then
		return nil
	end
	budget.remaining -= 1

	local node: { [string]: any } = {
		name = instance.Name,
		className = instance.ClassName,
	}
	if includeSources and instance:IsA("LuaSourceContainer") then
		node.source = Serialization.getScriptSource(instance)
	end
	local children = {}
	for _, child in instance:GetChildren() do
		local childNode = snapshotNode(child, includeSources, budget)
		if childNode then
			table.insert(children, childNode)
		end
	end
	if #children > 0 then
		node.children = children
	end
	return node
end

handlers.ExportProjectSnapshot = function(payload)
	local root = PathResolver.mustResolve(payload.root or "game")
	local budget = { remaining = payload.maxNodes or 10000 }
	local include = payload.includeScriptSources == true

	local tree: any
	if root == game then
		tree = { name = "game", className = "DataModel", children = {} }
		budget.remaining -= 1
		for _, serviceName in INSPECTED_SERVICES do
			local ok, service = pcall(function()
				return game:GetService(serviceName :: any)
			end)
			if ok and typeof(service) == "Instance" then
				local node = snapshotNode(service, include, budget)
				if node then
					table.insert(tree.children, node)
				end
			end
		end
	else
		tree = snapshotNode(root, include, budget)
	end

	return {
		placeName = game.Name,
		placeId = game.PlaceId,
		exportedAt = os.time(),
		truncated = budget.remaining <= 0,
		tree = tree,
	}
end

-- Export both the handlers and the Project helper (Main wires the notifier).
return setmetatable(handlers, { __index = Project }) :: any
