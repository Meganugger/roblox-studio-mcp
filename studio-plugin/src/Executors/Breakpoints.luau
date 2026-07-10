--!strict
-- Log breakpoints: non-pausing instrumentation inserted into script source.
--
-- Each breakpoint is a single inserted line ending in a unique marker comment:
--   print("[MCP:BP:<id>] <label>", <expressions>) --MCP_LOG_BREAKPOINT:<id>
-- The marker makes breakpoints reliably listable and removable even after the
-- surrounding code changes. Because the instrumentation lives in the source,
-- it fires in every execution context (Run mode, play solo, multiplayer test)
-- and its output lands in each peer's log buffer (get_output_logs).

local HttpService = game:GetService("HttpService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")

local PathResolver = require(script.Parent.Parent.PathResolver)
local Serialization = require(script.Parent.Parent.Serialization)

local MARKER = "--MCP_LOG_BREAKPOINT:"

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

local function breakpointsIn(container: LuaSourceContainer): { { [string]: any } }
	local found = {}
	local source = Serialization.getScriptSource(container)
	local lines = string.split(source, "\n")
	for lineNumber, line in lines do
		local id = string.match(line, MARKER .. "([%w%-]+)%s*$")
		if id then
			table.insert(found, {
				id = id,
				path = PathResolver.pathOf(container),
				line = lineNumber,
				text = string.sub(line, 1, 300),
			})
		end
	end
	return found
end

local function allScripts(root: Instance): { LuaSourceContainer }
	local scripts: { LuaSourceContainer } = {}
	if root:IsA("LuaSourceContainer") then
		table.insert(scripts, root)
		return scripts
	end
	for _, descendant in root:GetDescendants() do
		if descendant:IsA("LuaSourceContainer") then
			table.insert(scripts, descendant)
		end
	end
	return scripts
end

local handlers: { [string]: (payload: { [string]: any }) -> any } = {}

handlers.SetLogBreakpoint = function(payload)
	local container = mustResolveScript(payload.path)
	local line = payload.line :: number
	local source = Serialization.getScriptSource(container)
	local lines = string.split(source, "\n")
	if line < 1 or line > #lines + 1 then
		error(("Line %d is out of range (script has %d lines)"):format(line, #lines), 0)
	end

	local id = string.lower(string.gsub(HttpService:GenerateGUID(false), "%-", ""):sub(1, 8))
	local label = tostring(payload.message or "hit")
	-- Escape quotes/backslashes so the label is a valid Luau string literal.
	local safeLabel = string.gsub(string.gsub(label, "\\", "\\\\"), '"', '\\"')

	local args = { ('"[MCP:BP:%s] %s"'):format(id, safeLabel) }
	if payload.expressions then
		for _, expression in payload.expressions :: { string } do
			if string.find(expression, "\n", 1, true) then
				error("Breakpoint expressions must be single-line", 0)
			end
			table.insert(args, ('"%s ="'):format(string.gsub(string.gsub(expression, "\\", "\\\\"), '"', '\\"')))
			table.insert(args, ("(%s)"):format(expression))
		end
	end

	-- Match the indentation of the target line so the insert reads naturally.
	local indent = if lines[line] then string.match(lines[line], "^%s*") else ""
	local instrumented = ("%sprint(%s) %s%s"):format(indent or "", table.concat(args, ", "), MARKER, id)

	table.insert(lines, line, instrumented)
	Serialization.setScriptSource(container, table.concat(lines, "\n"))
	waypoint("Set log breakpoint in " .. container.Name)

	return {
		id = id,
		path = PathResolver.pathOf(container),
		line = line,
		inserted = instrumented,
		note = "Output lines are prefixed [MCP:BP:" .. id .. "]; read them with get_output_logs. " ..
			"Clear with clear_log_breakpoints when done.",
	}
end

handlers.ListLogBreakpoints = function(payload)
	local root: Instance = if payload.path then mustResolveScript(payload.path) else game
	local breakpoints = {}
	for _, container in allScripts(root) do
		for _, breakpoint in breakpointsIn(container) do
			table.insert(breakpoints, breakpoint)
		end
	end
	return { breakpoints = breakpoints, count = #breakpoints }
end

handlers.ClearLogBreakpoints = function(payload)
	local root: Instance = if payload.path then mustResolveScript(payload.path) else game
	local targetId = payload.id :: string?
	local removed = 0
	local scriptsChanged = 0

	for _, container in allScripts(root) do
		local source = Serialization.getScriptSource(container)
		if not string.find(source, MARKER, 1, true) then
			continue
		end
		local lines = string.split(source, "\n")
		local kept = {}
		local removedHere = 0
		for _, line in lines do
			local id = string.match(line, MARKER .. "([%w%-]+)%s*$")
			if id and (targetId == nil or id == targetId) then
				removedHere += 1
			else
				table.insert(kept, line)
			end
		end
		if removedHere > 0 then
			Serialization.setScriptSource(container, table.concat(kept, "\n"))
			removed += removedHere
			scriptsChanged += 1
		end
	end

	if removed > 0 then
		waypoint(("Clear %d log breakpoints"):format(removed))
	end
	return { removed = removed, scriptsChanged = scriptsChanged }
end

return handlers
