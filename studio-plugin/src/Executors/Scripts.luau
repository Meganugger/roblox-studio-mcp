--!strict
-- Script management command handlers.

local ChangeHistoryService = game:GetService("ChangeHistoryService")

local PathResolver = require(script.Parent.Parent.PathResolver)
local Serialization = require(script.Parent.Parent.Serialization)

local SCRIPT_CLASSES = { Script = true, LocalScript = true, ModuleScript = true }

local function waypoint(label: string)
	pcall(function()
		ChangeHistoryService:SetWaypoint("MCP: " .. label)
	end)
end

local function mustResolveScript(path: string): LuaSourceContainer
	local instance = PathResolver.mustResolve(path)
	if not instance:IsA("LuaSourceContainer") then
		error(("%s is a %s, not a script"):format(path, instance.ClassName), 0)
	end
	return instance :: LuaSourceContainer
end

local function countLines(text: string): number
	local _, newlines = string.gsub(text, "\n", "\n")
	return newlines + 1
end

local function scriptInfo(container: LuaSourceContainer): { [string]: any }
	local source = Serialization.getScriptSource(container)
	local enabled: boolean? = nil
	pcall(function()
		enabled = (container :: any).Enabled
	end)
	return {
		path = PathResolver.pathOf(container),
		className = container.ClassName,
		lines = countLines(source),
		bytes = #source,
		enabled = enabled,
	}
end

local handlers: { [string]: (payload: { [string]: any }) -> any } = {}

handlers.CreateScript = function(payload)
	if not SCRIPT_CLASSES[payload.scriptClass] then
		error("scriptClass must be Script, LocalScript or ModuleScript", 0)
	end
	local parent = PathResolver.mustResolve(payload.parentPath)

	local existing: Instance? = nil
	for _, child in parent:GetChildren() do
		if child.Name == payload.name and child.ClassName == payload.scriptClass then
			existing = child
			break
		end
	end

	local container: LuaSourceContainer
	if existing then
		if not payload.overwrite then
			error(("A %s named %q already exists at %s (pass overwrite=true to replace its source)"):format(
				payload.scriptClass,
				payload.name,
				payload.parentPath
			), 0)
		end
		container = existing :: LuaSourceContainer
	else
		container = Instance.new(payload.scriptClass) :: LuaSourceContainer
		container.Name = payload.name
	end

	Serialization.setScriptSource(container, payload.source)
	if payload.runContext and container:IsA("Script") then
		local ok, err = pcall(function()
			(container :: Script).RunContext = (Enum.RunContext :: any)[payload.runContext]
		end)
		if not ok then
			error("Invalid runContext: " .. tostring(err), 0)
		end
	end
	if container.Parent == nil then
		container.Parent = parent
	end
	waypoint("Create script " .. payload.name)
	return scriptInfo(container)
end

handlers.GetScriptSource = function(payload)
	local container = mustResolveScript(payload.path)
	local source = Serialization.getScriptSource(container)
	local info = scriptInfo(container)
	if payload.startLine or payload.endLine then
		local lines = string.split(source, "\n")
		local startLine = math.max(1, payload.startLine or 1)
		local endLine = math.min(#lines, payload.endLine or #lines)
		local slice = {}
		for i = startLine, endLine do
			table.insert(slice, lines[i])
		end
		info.source = table.concat(slice, "\n")
		info.slicedFrom = startLine
		info.slicedTo = endLine
	else
		info.source = source
	end
	return info
end

handlers.SetScriptSource = function(payload)
	local container = mustResolveScript(payload.path)
	Serialization.setScriptSource(container, payload.source)
	waypoint("Edit script " .. container.Name)
	return scriptInfo(container)
end

handlers.PatchScriptSource = function(payload)
	local container = mustResolveScript(payload.path)
	local source = Serialization.getScriptSource(container)

	-- Validate all edits against the evolving source before committing.
	for index, edit in payload.edits :: { { [string]: any } } do
		local find = edit.find :: string
		local occurrences = 0
		local searchFrom = 1
		while true do
			local foundAt = string.find(source, find, searchFrom, true)
			if not foundAt then
				break
			end
			occurrences += 1
			searchFrom = foundAt + math.max(#find, 1)
			if occurrences > 1 and not edit.replaceAll then
				break
			end
		end
		if occurrences == 0 then
			error(("Edit %d: `find` text not found in %s. Read the script first with get_script_source; " ..
				"the text must match exactly (including whitespace)."):format(index, payload.path), 0)
		end
		if occurrences > 1 and not edit.replaceAll then
			error(("Edit %d: `find` text appears multiple times in %s. Add more context to make it unique, " ..
				"or set replaceAll=true."):format(index, payload.path), 0)
		end

		local escapedFind = string.gsub(find, "(%W)", "%%%1")
		local escapedReplace = string.gsub(edit.replace :: string, "%%", "%%%%")
		local replacementCount = if edit.replaceAll then nil else 1
		source = string.gsub(source, escapedFind, escapedReplace, replacementCount)
	end

	Serialization.setScriptSource(container, source)
	waypoint("Patch script " .. container.Name)
	local info = scriptInfo(container)
	info.editsApplied = #(payload.edits :: { any })
	return info
end

handlers.SearchScriptSource = function(payload)
	local root = PathResolver.mustResolve(payload.root or "game")
	local query = payload.query :: string
	local isPattern = payload.isPattern == true
	local caseSensitive = payload.caseSensitive == true
	local maxResults = payload.maxResults or 200

	local needle = if caseSensitive then query else string.lower(query)
	local matches = {}

	local containers: { Instance } = if root:IsA("LuaSourceContainer") then { root } else root:GetDescendants()
	for _, descendant in containers do
		if #matches >= maxResults then
			break
		end
		if descendant:IsA("LuaSourceContainer") then
			local source = Serialization.getScriptSource(descendant)
			local lines = string.split(source, "\n")
			for lineNumber, line in lines do
				local haystack = if caseSensitive then line else string.lower(line)
				local found: number? = nil
				if isPattern then
					local ok, result = pcall(string.find, haystack, needle)
					if ok then
						found = result
					end
				else
					found = string.find(haystack, needle, 1, true)
				end
				if found then
					table.insert(matches, {
						path = PathResolver.pathOf(descendant),
						line = lineNumber,
						text = string.sub(line, 1, 300),
					})
					if #matches >= maxResults then
						break
					end
				end
			end
		end
	end
	return { matches = matches, truncated = #matches >= maxResults }
end

handlers.FindAndReplaceInScripts = function(payload)
	local root = PathResolver.mustResolve(payload.root or "game")
	local find = payload.find :: string
	local replace = payload.replace :: string
	local caseSensitive = payload.caseSensitive ~= false
	local maxScripts = payload.maxScripts or 500
	local dryRun = payload.dryRun == true

	local needle = if caseSensitive then find else string.lower(find)
	local changes = {}
	local totalReplacements = 0
	local scriptsChanged = 0

	local containers: { Instance } = if root:IsA("LuaSourceContainer") then { root } else root:GetDescendants()
	for _, descendant in containers do
		if scriptsChanged >= maxScripts then
			break
		end
		if not descendant:IsA("LuaSourceContainer") then
			continue
		end
		if payload.classFilter and descendant.ClassName ~= payload.classFilter then
			continue
		end

		local source = Serialization.getScriptSource(descendant)

		-- Count literal occurrences (case-aware).
		local haystack = if caseSensitive then source else string.lower(source)
		local occurrences = 0
		local searchFrom = 1
		local positions: { number } = {}
		while true do
			local foundAt = string.find(haystack, needle, searchFrom, true)
			if not foundAt then
				break
			end
			occurrences += 1
			table.insert(positions, foundAt)
			searchFrom = foundAt + math.max(#needle, 1)
		end
		if occurrences == 0 then
			continue
		end

		if not dryRun then
			-- Rebuild the source from literal positions (safe for any characters,
			-- correct for case-insensitive matches).
			local pieces = {}
			local cursor = 1
			for _, position in positions do
				table.insert(pieces, string.sub(source, cursor, position - 1))
				table.insert(pieces, replace)
				cursor = position + #find
			end
			table.insert(pieces, string.sub(source, cursor))
			Serialization.setScriptSource(descendant, table.concat(pieces))
		end

		scriptsChanged += 1
		totalReplacements += occurrences
		table.insert(changes, {
			path = PathResolver.pathOf(descendant),
			replacements = occurrences,
		})
	end

	if not dryRun and scriptsChanged > 0 then
		waypoint(("Find/replace in %d scripts"):format(scriptsChanged))
	end
	return {
		dryRun = dryRun,
		scriptsChanged = scriptsChanged,
		totalReplacements = totalReplacements,
		changes = changes,
		truncated = scriptsChanged >= maxScripts,
	}
end

handlers.ListScripts = function(payload)
	local root = PathResolver.mustResolve(payload.root or "game")
	local scripts = {}
	local containers: { Instance } = if root:IsA("LuaSourceContainer") then { root } else root:GetDescendants()
	for _, descendant in containers do
		if descendant:IsA("LuaSourceContainer") then
			if payload.classFilter == nil or descendant.ClassName == payload.classFilter then
				table.insert(scripts, scriptInfo(descendant))
			end
		end
	end
	return { scripts = scripts, count = #scripts }
end

handlers.AnalyzeScripts = function(payload)
	local targets: { LuaSourceContainer } = {}
	if payload.path then
		table.insert(targets, mustResolveScript(payload.path))
	else
		local root = PathResolver.mustResolve(payload.root or "game")
		local containers: { Instance } = if root:IsA("LuaSourceContainer") then { root } else root:GetDescendants()
		for _, descendant in containers do
			if descendant:IsA("LuaSourceContainer") then
				table.insert(targets, descendant :: LuaSourceContainer)
			end
		end
	end

	local problems = {}
	for _, container in targets do
		local source = Serialization.getScriptSource(container)
		local fn, compileError = loadstring(source, container.Name)
		if fn == nil then
			local line = string.match(tostring(compileError), ":(%d+):")
			table.insert(problems, {
				path = PathResolver.pathOf(container),
				error = tostring(compileError),
				line = if line then tonumber(line) else nil,
			})
		end
	end
	return {
		analyzed = #targets,
		problems = problems,
		clean = #problems == 0,
	}
end

return handlers
