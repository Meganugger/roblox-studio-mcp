--!strict
-- OutputCapture: ring buffer of Studio output (prints, warnings, errors with
-- stack traces). Feeds the get_output_logs / get_errors MCP tools.

local LogService = game:GetService("LogService")
local ScriptContext = game:GetService("ScriptContext")

local Config = require(script.Parent.Config)

export type LogEntry = {
	seq: number,
	timestamp: number,
	level: string, -- "Output" | "Info" | "Warning" | "Error"
	message: string,
	stack: string?,
	script: string?,
}

local OutputCapture = {}

local buffer: { LogEntry } = {}
local nextSeq = 1
local connections: { RBXScriptConnection } = {}

local LEVEL_BY_MESSAGE_TYPE: { [Enum.MessageType]: string } = {
	[Enum.MessageType.MessageOutput] = "Output",
	[Enum.MessageType.MessageInfo] = "Info",
	[Enum.MessageType.MessageWarning] = "Warning",
	[Enum.MessageType.MessageError] = "Error",
}

local function push(entry: LogEntry)
	table.insert(buffer, entry)
	if #buffer > Config.LOG_BUFFER_SIZE then
		table.remove(buffer, 1)
	end
end

function OutputCapture.start()
	OutputCapture.stop()

	table.insert(connections, LogService.MessageOut:Connect(function(message: string, messageType: Enum.MessageType)
		-- ScriptContext.Error provides richer error entries; skip plain error
		-- messages here to avoid near-duplicates with no stack.
		if messageType == Enum.MessageType.MessageError then
			return
		end
		push({
			seq = nextSeq,
			timestamp = os.clock(),
			level = LEVEL_BY_MESSAGE_TYPE[messageType] or "Output",
			message = message,
		})
		nextSeq += 1
	end))

	table.insert(connections, ScriptContext.Error:Connect(function(message: string, stack: string, scriptInstance: Instance?)
		push({
			seq = nextSeq,
			timestamp = os.clock(),
			level = "Error",
			message = message,
			stack = stack,
			script = if scriptInstance then scriptInstance:GetFullName() else nil,
		})
		nextSeq += 1
	end))
end

function OutputCapture.stop()
	for _, connection in connections do
		connection:Disconnect()
	end
	table.clear(connections)
end

function OutputCapture.get(sinceSeq: number, level: string?, maxEntries: number, includeStacks: boolean?): { LogEntry }
	local out: { LogEntry } = {}
	for _, entry in buffer do
		if entry.seq > sinceSeq and (level == nil or level == "All" or entry.level == level) then
			local view: LogEntry = {
				seq = entry.seq,
				timestamp = entry.timestamp,
				level = entry.level,
				message = entry.message,
				stack = if includeStacks ~= false then entry.stack else nil,
				script = entry.script,
			}
			table.insert(out, view)
			if #out >= maxEntries then
				break
			end
		end
	end
	return out
end

function OutputCapture.clear()
	table.clear(buffer)
end

function OutputCapture.latestSeq(): number
	return nextSeq - 1
end

return OutputCapture
