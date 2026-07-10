--!strict
-- RunLuau: execute arbitrary Luau at plugin security level with print capture,
-- timeout enforcement and serialized return values.

local ChangeHistoryService = game:GetService("ChangeHistoryService")

local Serialization = require(script.Parent.Parent.Serialization)

local handlers: { [string]: (payload: { [string]: any }) -> any } = {}

handlers.RunLuau = function(payload)
	local code = payload.code :: string
	local timeoutSeconds = math.clamp((payload.timeoutMs or 30000) / 1000, 1, 180)

	local fn, compileError = loadstring(code, "MCP_RunLuau")
	if fn == nil then
		error("Luau compile error: " .. tostring(compileError), 0)
	end

	-- Sandbox print/warn into a capture buffer while preserving everything else.
	local output: { string } = {}
	local baseEnv = getfenv(fn :: any)
	local env = setmetatable({
		print = function(...)
			local parts = {}
			for i = 1, select("#", ...) do
				table.insert(parts, tostring(select(i, ...)))
			end
			local line = table.concat(parts, " ")
			table.insert(output, line)
			print(line)
		end,
		warn = function(...)
			local parts = {}
			for i = 1, select("#", ...) do
				table.insert(parts, tostring(select(i, ...)))
			end
			local line = table.concat(parts, " ")
			table.insert(output, "[warn] " .. line)
			warn(line)
		end,
	}, { __index = baseEnv })
	setfenv(fn :: any, env :: any)

	local done = false
	local ok = false
	local results: { any } = {}
	local errorMessage: string? = nil
	local errorStack: string? = nil

	local thread = task.spawn(function()
		local packed = table.pack(xpcall(fn :: any, function(err)
			errorStack = debug.traceback(tostring(err), 2)
			return err
		end))
		ok = packed[1] == true
		if ok then
			for i = 2, packed.n do
				table.insert(results, packed[i])
			end
		else
			errorMessage = tostring(packed[2])
		end
		done = true
	end)

	local deadline = os.clock() + timeoutSeconds
	while not done and os.clock() < deadline do
		task.wait(0.05)
	end

	if not done then
		pcall(task.cancel, thread)
		pcall(function()
			ChangeHistoryService:SetWaypoint("MCP: run_luau (timed out)")
		end)
		error(("run_luau timed out after %ds. Output so far:\n%s"):format(
			math.floor(timeoutSeconds),
			table.concat(output, "\n")
		), 0)
	end

	pcall(function()
		ChangeHistoryService:SetWaypoint("MCP: " .. (payload.description or "run_luau"))
	end)

	if not ok then
		error(("Luau runtime error: %s\n%s\nOutput:\n%s"):format(
			tostring(errorMessage),
			tostring(errorStack or ""),
			table.concat(output, "\n")
		), 0)
	end

	local encodedResults = {}
	for _, value in results do
		table.insert(encodedResults, Serialization.encode(value))
	end
	return {
		output = output,
		returns = encodedResults,
	}
end

return handlers
