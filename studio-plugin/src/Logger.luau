--!strict
-- Prefixed logger for the MCP plugin. Keeps plugin noise identifiable and
-- easy to filter in the Output window.

local PREFIX = "[RobloxStudioMCP] "

local Logger = {}

function Logger.info(message: string)
	print(PREFIX .. message)
end

function Logger.warn(message: string)
	warn(PREFIX .. message)
end

function Logger.debugf(format: string, ...: any)
	print(PREFIX .. string.format(format, ...))
end

return Logger
