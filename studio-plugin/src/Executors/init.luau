--!strict
-- Executors: dispatch table mapping command names (shared/src/commands.ts) to
-- handlers. Every handler takes the JSON payload and returns a JSON-safe
-- result table. Errors are raised and converted to error envelopes by Bridge.

local Instances = require(script.Instances)
local Scripts = require(script.Scripts)
local RunCode = require(script.RunCode)
local Project = require(script.Project)
local Playtest = require(script.Playtest)
local World = require(script.World)

export type Handler = (payload: { [string]: any }) -> any

local Executors = {}

local handlers: { [string]: Handler } = {}

local function merge(moduleHandlers: { [string]: Handler })
	for name, handler in moduleHandlers do
		if handlers[name] then
			error("Duplicate command handler: " .. name)
		end
		handlers[name] = handler
	end
end

merge(Instances)
merge(Scripts)
merge(RunCode)
merge(Project)
merge(Playtest)
merge(World)

handlers.Ping = function(payload)
	return { pong = true, sentAt = payload.sentAt }
end

function Executors.dispatch(name: string, payload: { [string]: any }): any
	local handler = handlers[name]
	if not handler then
		error(("Unknown command %q (plugin may be older than the server; update the plugin)"):format(name), 0)
	end
	return handler(payload)
end

function Executors.commandNames(): { string }
	local names = {}
	for name in handlers do
		table.insert(names, name)
	end
	table.sort(names)
	return names
end

return Executors
