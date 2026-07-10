--!strict
-- PathResolver: translate between DataModel instances and string paths like
-- "game.Workspace.Map.Spawn". Duplicate sibling names are addressed with a
-- 1-based index suffix: "game.Workspace.Part[2]".

local PathResolver = {}

local function splitPath(path: string): { string }
	local segments = {}
	for segment in string.gmatch(path, "[^./]+") do
		table.insert(segments, segment)
	end
	return segments
end

local function parseSegment(segment: string): (string, number?)
	local name, indexText = string.match(segment, "^(.-)%[(%d+)%]$")
	if name and indexText then
		return name, tonumber(indexText)
	end
	return segment, nil
end

local function childByNameAndIndex(parent: Instance, name: string, index: number?): Instance?
	if index == nil then
		local child = parent:FindFirstChild(name)
		if child then
			return child
		end
		if parent == game then
			-- Services are addressable by class name even before first access.
			local ok, service = pcall(function()
				return game:GetService(name :: any)
			end)
			if ok and typeof(service) == "Instance" then
				return service
			end
		end
		return nil
	end
	local seen = 0
	for _, child in parent:GetChildren() do
		if child.Name == name then
			seen += 1
			if seen == index then
				return child
			end
		end
	end
	return nil
end

--- Resolve a path to an instance, or nil + error message.
function PathResolver.resolve(path: string): (Instance?, string?)
	if type(path) ~= "string" or #path == 0 then
		return nil, "Path must be a non-empty string"
	end
	local segments = splitPath(path)
	if segments[1] ~= "game" then
		return nil, 'Path must start with "game": ' .. path
	end
	local current: Instance = game
	for i = 2, #segments do
		local name, index = parseSegment(segments[i])
		local nextInstance = childByNameAndIndex(current, name, index)
		if not nextInstance then
			return nil,
				("Not found: %s (failed at segment %q; parent %s has children: %s)"):format(
					path,
					segments[i],
					current:GetFullName(),
					PathResolver.childNamesSummary(current)
				)
		end
		current = nextInstance
	end
	return current, nil
end

--- Resolve a path and assert the result exists.
function PathResolver.mustResolve(path: string): Instance
	local instance, err = PathResolver.resolve(path)
	if not instance then
		error(err, 0)
	end
	return instance :: Instance
end

--- Build the canonical path for an instance (with [n] disambiguation).
function PathResolver.pathOf(instance: Instance): string
	if instance == game then
		return "game"
	end
	local segments = {}
	local current: Instance? = instance
	while current and current ~= game do
		local parent = current.Parent
		local segment = current.Name
		if parent then
			local sameName = 0
			local myIndex = 0
			for _, sibling in parent:GetChildren() do
				if sibling.Name == current.Name then
					sameName += 1
					if sibling == current then
						myIndex = sameName
					end
				end
			end
			if sameName > 1 then
				segment = ("%s[%d]"):format(current.Name, myIndex)
			end
		end
		table.insert(segments, 1, segment)
		current = parent
	end
	if current ~= game then
		-- Instance is not under the DataModel (e.g. destroyed or in nil).
		return instance:GetFullName()
	end
	return "game." .. table.concat(segments, ".")
end

function PathResolver.childNamesSummary(parent: Instance): string
	local names = {}
	for i, child in parent:GetChildren() do
		if i > 12 then
			table.insert(names, "...")
			break
		end
		table.insert(names, child.Name)
	end
	return table.concat(names, ", ")
end

return PathResolver
