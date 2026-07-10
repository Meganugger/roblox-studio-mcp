--!strict
-- Instance/Explorer command handlers.

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Selection = game:GetService("Selection")

local PathResolver = require(script.Parent.Parent.PathResolver)
local Serialization = require(script.Parent.Parent.Serialization)

local PROTECTED = {
	[game :: Instance] = true,
	[game:GetService("Workspace") :: Instance] = true,
	[game:GetService("Players") :: Instance] = true,
	[game:GetService("Lighting") :: Instance] = true,
	[game:GetService("ReplicatedStorage") :: Instance] = true,
	[game:GetService("ServerScriptService") :: Instance] = true,
	[game:GetService("ServerStorage") :: Instance] = true,
	[game:GetService("StarterGui") :: Instance] = true,
	[game:GetService("StarterPlayer") :: Instance] = true,
	[game:GetService("SoundService") :: Instance] = true,
	[game:GetService("Teams") :: Instance] = true,
}

local function waypoint(label: string)
	pcall(function()
		ChangeHistoryService:SetWaypoint("MCP: " .. label)
	end)
end

local function assertMutable(instance: Instance)
	if PROTECTED[instance] then
		error(("Refusing to modify protected container %s"):format(instance:GetFullName()), 0)
	end
end

local function summarize(instance: Instance): { [string]: any }
	return {
		name = instance.Name,
		className = instance.ClassName,
		path = PathResolver.pathOf(instance),
	}
end

local function buildTree(
	instance: Instance,
	depth: number,
	classFilter: string?,
	budget: { remaining: number }
): { [string]: any }?
	if budget.remaining <= 0 then
		return nil
	end
	budget.remaining -= 1

	local children = {}
	if depth > 1 then
		for _, child in instance:GetChildren() do
			local node = buildTree(child, depth - 1, classFilter, budget)
			if node then
				table.insert(children, node)
			end
		end
	end

	local matches = classFilter == nil
	if classFilter ~= nil then
		pcall(function()
			matches = instance:IsA(classFilter)
		end)
	end
	if not matches and #children == 0 then
		return nil
	end

	return {
		name = instance.Name,
		className = instance.ClassName,
		path = PathResolver.pathOf(instance),
		children = children,
	}
end

local function createOne(item: { [string]: any }): Instance
	local parent = PathResolver.mustResolve(item.parentPath)
	local name = item.name or item.className

	local existing: Instance? = nil
	if item.skipIfExists or item.upsert then
		for _, child in parent:GetChildren() do
			if child.Name == name and child.ClassName == item.className then
				existing = child
				break
			end
		end
	end
	if existing and item.skipIfExists and not item.upsert then
		return existing
	end

	local instance: Instance
	if existing and item.upsert then
		instance = existing
	else
		local ok, created = pcall(Instance.new, item.className)
		if not ok then
			error(("Cannot create instance of class %q"):format(tostring(item.className)), 0)
		end
		instance = created
		instance.Name = name
	end

	if item.properties then
		Serialization.applyProperties(instance, item.properties)
	end
	if instance.Parent == nil then
		instance.Parent = parent
	end
	return instance
end

local handlers: { [string]: (payload: { [string]: any }) -> any } = {}

handlers.GetInstanceTree = function(payload)
	local root = PathResolver.mustResolve(payload.path)
	local budget = { remaining = payload.maxNodes or 3000 }
	local tree = buildTree(root, payload.maxDepth or 4, payload.classFilter, budget)
	return {
		tree = tree,
		truncated = budget.remaining <= 0,
	}
end

handlers.GetInstance = function(payload)
	local instance = PathResolver.mustResolve(payload.path)
	local childNames = {}
	for _, child in instance:GetChildren() do
		table.insert(childNames, ("%s (%s)"):format(child.Name, child.ClassName))
	end
	return {
		name = instance.Name,
		className = instance.ClassName,
		path = PathResolver.pathOf(instance),
		properties = Serialization.readProperties(instance, payload.properties),
		attributes = Serialization.encode(instance:GetAttributes(), 3),
		children = childNames,
	}
end

handlers.GetInstanceChildren = function(payload)
	local instance = PathResolver.mustResolve(payload.path)
	local children = {}
	for _, child in instance:GetChildren() do
		table.insert(children, summarize(child))
	end
	return { children = children }
end

handlers.SearchInstances = function(payload)
	local root = PathResolver.mustResolve(payload.root or "game")
	local needle = if payload.nameContains then string.lower(payload.nameContains) else nil
	local className = payload.className
	local maxResults = payload.maxResults or 200
	local results = {}
	for _, descendant in root:GetDescendants() do
		local nameMatches = needle == nil or string.find(string.lower(descendant.Name), needle, 1, true) ~= nil
		local classMatches = true
		if className ~= nil then
			classMatches = false
			pcall(function()
				classMatches = descendant:IsA(className)
			end)
		end
		if nameMatches and classMatches then
			table.insert(results, summarize(descendant))
			if #results >= maxResults then
				break
			end
		end
	end
	return { results = results, truncated = #results >= maxResults }
end

handlers.CreateInstance = function(payload)
	local instance = createOne(payload)
	waypoint("Create " .. instance.Name)
	return summarize(instance)
end

handlers.CreateInstancesBatch = function(payload)
	local created = {}
	for index, item in payload.items :: { { [string]: any } } do
		local ok, resultOrErr = pcall(createOne, item)
		if not ok then
			waypoint("Batch create (partial)")
			error(("Item %d (%s %q) failed: %s"):format(
				index,
				tostring(item.className),
				tostring(item.name or item.className),
				tostring(resultOrErr)
			), 0)
		end
		table.insert(created, summarize(resultOrErr))
	end
	waypoint(("Batch create %d instances"):format(#created))
	return { created = created, count = #created }
end

handlers.SetProperties = function(payload)
	local instance = PathResolver.mustResolve(payload.path)
	assertMutable(instance)
	Serialization.applyProperties(instance, payload.properties)
	waypoint("Set properties on " .. instance.Name)
	return { path = PathResolver.pathOf(instance), applied = true }
end

handlers.RenameInstance = function(payload)
	local instance = PathResolver.mustResolve(payload.path)
	assertMutable(instance)
	instance.Name = payload.newName
	waypoint("Rename to " .. payload.newName)
	return summarize(instance)
end

handlers.MoveInstance = function(payload)
	local instance = PathResolver.mustResolve(payload.path)
	assertMutable(instance)
	local newParent = PathResolver.mustResolve(payload.newParentPath)
	if newParent == instance or newParent:IsDescendantOf(instance) then
		error("Cannot parent an instance to itself or its own descendant", 0)
	end
	instance.Parent = newParent
	waypoint("Move " .. instance.Name)
	return summarize(instance)
end

handlers.CloneInstance = function(payload)
	local instance = PathResolver.mustResolve(payload.path)
	local clone = instance:Clone()
	if clone == nil then
		error("Instance is not clonable (Archivable=false): " .. payload.path, 0)
	end
	if payload.newName then
		clone.Name = payload.newName
	end
	local parent = if payload.newParentPath then PathResolver.mustResolve(payload.newParentPath) else instance.Parent
	clone.Parent = parent
	waypoint("Clone " .. instance.Name)
	return summarize(clone)
end

handlers.DeleteInstance = function(payload)
	local instance = PathResolver.mustResolve(payload.path)
	assertMutable(instance)
	local name = instance.Name
	instance:Destroy()
	waypoint("Delete " .. name)
	return { deleted = true, path = payload.path }
end

handlers.GetSelection = function(_payload)
	local paths = {}
	for _, instance in Selection:Get() do
		table.insert(paths, PathResolver.pathOf(instance))
	end
	return { paths = paths }
end

handlers.SetSelection = function(payload)
	local instances = {}
	for _, path in payload.paths :: { string } do
		table.insert(instances, PathResolver.mustResolve(path))
	end
	Selection:Set(instances)
	return { selected = #instances }
end

return handlers
