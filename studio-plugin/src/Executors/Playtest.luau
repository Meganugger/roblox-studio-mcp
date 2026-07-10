--!strict
-- Playtest control and log retrieval command handlers.
--
-- Uses RunService:Run()/Stop(), which simulates the game (server scripts +
-- physics) inside the current DataModel. The plugin keeps running during the
-- simulation, so command handling and log capture stay live.

local RunService = game:GetService("RunService")

local OutputCapture = require(script.Parent.Parent.OutputCapture)

local handlers: { [string]: (payload: { [string]: any }) -> any } = {}

handlers.StartPlaytest = function(_payload)
	if RunService:IsRunning() then
		return { started = false, alreadyRunning = true, logSeq = OutputCapture.latestSeq() }
	end
	local seqBefore = OutputCapture.latestSeq()
	RunService:Run()
	return {
		started = true,
		mode = "Run",
		logSeq = seqBefore,
		note = "Simulation started (Run mode: server scripts + physics, no player character). " ..
			"Pass logSeq as sinceSeq to get_output_logs/get_errors to read only new output.",
	}
end

handlers.StopPlaytest = function(_payload)
	if not RunService:IsRunning() then
		return { stopped = false, wasRunning = false }
	end
	RunService:Stop()
	return {
		stopped = true,
		note = "Simulation stopped. Note: changes made by scripts during Run mode persist in the edit session.",
	}
end

handlers.GetPlaytestState = function(_payload)
	return {
		running = RunService:IsRunning(),
		isEdit = RunService:IsEdit(),
		latestLogSeq = OutputCapture.latestSeq(),
	}
end

handlers.GetLogs = function(payload)
	local entries = OutputCapture.get(
		payload.sinceSeq or 0,
		payload.level,
		payload.maxEntries or 300,
		payload.includeStacks
	)
	return {
		entries = entries,
		latestSeq = OutputCapture.latestSeq(),
		count = #entries,
	}
end

handlers.ClearLogs = function(_payload)
	OutputCapture.clear()
	return { cleared = true }
end

return handlers
