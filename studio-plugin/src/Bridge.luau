--!strict
-- Bridge: connection loop between the plugin and the local MCP server.
--
-- Flow: hello handshake -> long-poll /plugin/poll -> execute command ->
-- POST /plugin/result -> poll again. Failures trigger exponential backoff and
-- automatic reconnection. All requests carry the bearer token.

local HttpService = game:GetService("HttpService")

local Config = require(script.Parent.Config)
local Logger = require(script.Parent.Logger)
local Executors = require(script.Parent.Executors)

export type BridgeStatus = "Disconnected" | "Connecting" | "Connected" | "AuthFailed" | "HttpDisabled"

local Bridge = {}

local running = false
local generation = 0
local status: BridgeStatus = "Disconnected"
local statusListeners: { (status: BridgeStatus, detail: string?) -> () } = {}

local currentToken = ""
local currentPort = Config.DEFAULT_PORT

local function setStatus(newStatus: BridgeStatus, detail: string?)
	if status ~= newStatus then
		status = newStatus
		for _, listener in statusListeners do
			task.spawn(listener, newStatus, detail)
		end
	end
end

function Bridge.onStatusChanged(listener: (status: BridgeStatus, detail: string?) -> ())
	table.insert(statusListeners, listener)
end

function Bridge.getStatus(): BridgeStatus
	return status
end

local function baseUrl(): string
	return ("http://%s:%d"):format(Config.HOST, currentPort)
end

local function request(method: string, path: string, body: any?): (boolean, any, number?)
	local options: { [string]: any } = {
		Url = baseUrl() .. path,
		Method = method,
		Headers = {
			["Authorization"] = "Bearer " .. currentToken,
			["Content-Type"] = "application/json",
		},
	}
	if body ~= nil then
		options.Body = HttpService:JSONEncode(body)
	end
	local ok, response = pcall(function()
		return HttpService:RequestAsync(options)
	end)
	if not ok then
		local message = tostring(response)
		if string.find(message, "not enabled", 1, true) or string.find(message, "HttpEnabled", 1, true) then
			return false, "HttpDisabled", nil
		end
		return false, message, nil
	end
	local decoded: any = nil
	if response.Body and #response.Body > 0 then
		local decodeOk, decodedBody = pcall(function()
			return HttpService:JSONDecode(response.Body)
		end)
		if decodeOk then
			decoded = decodedBody
		end
	end
	return true, decoded, response.StatusCode
end

local function tryEnableHttp(): boolean
	local ok = pcall(function()
		(HttpService :: any).HttpEnabled = true
	end)
	return ok
end

local function hello(): boolean
	local ok, body, statusCode = request("POST", "/plugin/hello", {
		pluginVersion = Config.PLUGIN_VERSION,
		protocolVersion = Config.PROTOCOL_VERSION,
		placeName = game.Name,
		placeId = game.PlaceId,
		gameId = game.GameId,
	})
	if not ok then
		if body == "HttpDisabled" then
			if tryEnableHttp() then
				Logger.info("Enabled HttpService for this place (required for the MCP bridge).")
				return hello()
			end
			setStatus("HttpDisabled", "Enable 'Allow HTTP Requests' in Game Settings > Security.")
			return false
		end
		setStatus("Disconnected", tostring(body))
		return false
	end
	if statusCode == 401 then
		setStatus("AuthFailed", "Token rejected by server. Paste the token shown in the MCP server logs.")
		return false
	end
	if statusCode ~= 200 then
		local message = if type(body) == "table" and body.message then tostring(body.message) else ("HTTP " .. tostring(statusCode))
		setStatus("Disconnected", message)
		return false
	end
	setStatus("Connected", nil)
	Logger.info(("Connected to MCP server v%s at %s"):format(
		if type(body) == "table" then tostring(body.serverVersion) else "?",
		baseUrl()
	))
	return true
end

local function executeCommand(command: { [string]: any })
	local resultEnvelope: { [string]: any }
	local startedAt = os.clock()

	local traceback: string? = nil
	local ok, resultOrErr = xpcall(function()
		return Executors.dispatch(command.name, command.payload or {})
	end, function(err)
		traceback = debug.traceback(tostring(err), 2)
		return err
	end)

	if ok then
		resultEnvelope = { id = command.id, ok = true, result = resultOrErr }
	else
		resultEnvelope = {
			id = command.id,
			ok = false,
			error = {
				message = tostring(resultOrErr),
				stack = traceback,
			},
		}
		Logger.warn(("Command %s failed: %s"):format(tostring(command.name), tostring(resultOrErr)))
	end

	Logger.debugf("%s finished in %.0f ms", tostring(command.name), (os.clock() - startedAt) * 1000)

	-- Deliver the result; retry a few times so results are not lost to blips.
	for attempt = 1, 3 do
		local sendOk, _, sendStatus = request("POST", "/plugin/result", resultEnvelope)
		if sendOk and sendStatus == 200 then
			return
		end
		if sendStatus == 410 then
			Logger.warn("Server no longer waiting for result (command timed out server-side).")
			return
		end
		task.wait(attempt)
	end
	Logger.warn("Failed to deliver command result after retries.")
end

local function pollLoop(myGeneration: number)
	local backoff = Config.BACKOFF_INITIAL
	while running and myGeneration == generation do
		if status ~= "Connected" then
			if not hello() then
				task.wait(backoff)
				backoff = math.min(backoff * 2, Config.BACKOFF_MAX)
				continue
			end
			backoff = Config.BACKOFF_INITIAL
		end

		local ok, body, statusCode = request("GET", "/plugin/poll", nil)
		if not running or myGeneration ~= generation then
			break
		end
		if not ok then
			if body == "HttpDisabled" then
				setStatus("HttpDisabled", "Enable 'Allow HTTP Requests' in Game Settings > Security.")
			else
				setStatus("Disconnected", tostring(body))
			end
			task.wait(backoff)
			backoff = math.min(backoff * 2, Config.BACKOFF_MAX)
		elseif statusCode == 401 then
			setStatus("AuthFailed", "Token rejected by server.")
			task.wait(Config.BACKOFF_MAX)
		elseif statusCode == 200 and type(body) == "table" and body.id then
			backoff = Config.BACKOFF_INITIAL
			executeCommand(body)
		else
			-- 204: no work; poll again immediately.
			backoff = Config.BACKOFF_INITIAL
		end
	end
	setStatus("Disconnected", nil)
end

function Bridge.start(token: string, port: number)
	currentToken = token
	currentPort = port
	running = true
	generation += 1
	setStatus("Connecting", nil)
	task.spawn(pollLoop, generation)
end

function Bridge.stop()
	running = false
	generation += 1
	setStatus("Disconnected", nil)
	Logger.info("Bridge stopped.")
end

function Bridge.isRunning(): boolean
	return running
end

return Bridge
