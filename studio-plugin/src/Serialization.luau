--!strict
-- Serialization: mirror of shared/src/properties.ts. Encodes Roblox values to
-- JSON-safe tagged tables and decodes tagged tables back to Roblox values.
-- Keep in sync with the TypeScript side.

local Config = require(script.Parent.Config)
local PathResolver = require(script.Parent.PathResolver)

local Serialization = {}

-- ---------------------------------------------------------------- decoding --

local function decodeEnumString(text: string): EnumItem
	local enumType, itemName = string.match(text, "^Enum%.([A-Za-z0-9]+)%.([A-Za-z0-9_ ]+)$")
	if not enumType or not itemName then
		error(("Invalid enum string %q (expected \"Enum.Type.Item\")"):format(text), 0)
	end
	local ok, result = pcall(function()
		return (Enum :: any)[enumType][itemName]
	end)
	if not ok then
		error(("Unknown enum item %q"):format(text), 0)
	end
	return result
end

local decoders: { [string]: (value: any) -> any } = {
	Vector3 = function(v)
		return Vector3.new(v[1], v[2], v[3])
	end,
	Vector2 = function(v)
		return Vector2.new(v[1], v[2])
	end,
	CFrame = function(v)
		if #v == 3 then
			return CFrame.new(v[1], v[2], v[3])
		end
		return CFrame.new(table.unpack(v))
	end,
	Color3 = function(v)
		return Color3.new(v[1], v[2], v[3])
	end,
	BrickColor = function(v)
		return BrickColor.new(v)
	end,
	UDim = function(v)
		return UDim.new(v[1], v[2])
	end,
	UDim2 = function(v)
		return UDim2.new(v[1], v[2], v[3], v[4])
	end,
	EnumItem = function(v)
		return decodeEnumString(v)
	end,
	Instance = function(v)
		return PathResolver.mustResolve(v)
	end,
	NumberRange = function(v)
		return NumberRange.new(v[1], v[2])
	end,
	Rect = function(v)
		return Rect.new(v[1], v[2], v[3], v[4])
	end,
	ColorSequence = function(v)
		-- [{time, color = [r,g,b]}, ...] or single color [r,g,b]
		if type(v[1]) == "number" then
			return ColorSequence.new(Color3.new(v[1], v[2], v[3]))
		end
		local keypoints = {}
		for _, kp in v do
			table.insert(keypoints, ColorSequenceKeypoint.new(kp.time, Color3.new(kp.color[1], kp.color[2], kp.color[3])))
		end
		return ColorSequence.new(keypoints)
	end,
	NumberSequence = function(v)
		if type(v) == "number" then
			return NumberSequence.new(v)
		end
		local keypoints = {}
		for _, kp in v do
			table.insert(keypoints, NumberSequenceKeypoint.new(kp.time, kp.value, kp.envelope or 0))
		end
		return NumberSequence.new(keypoints)
	end,
	Font = function(v)
		local weight = if v.weight then (Enum.FontWeight :: any)[v.weight] else Enum.FontWeight.Regular
		local style = if v.style then (Enum.FontStyle :: any)[v.style] else Enum.FontStyle.Normal
		return Font.new(v.family, weight, style)
	end,
}

--- Decode a JSON value (possibly tagged) into a Roblox value.
function Serialization.decode(value: any): any
	if type(value) == "string" and string.match(value, "^Enum%.") then
		return decodeEnumString(value)
	end
	if type(value) == "table" and type(value["$type"]) == "string" then
		local decoder = decoders[value["$type"]]
		if not decoder then
			error(("Unsupported $type %q"):format(tostring(value["$type"])), 0)
		end
		return decoder(value.value)
	end
	return value
end

-- ---------------------------------------------------------------- encoding --

local function tagged(tag: string, value: any): { [string]: any }
	return { ["$type"] = tag, value = value }
end

--- Encode a Roblox value into a JSON-safe structure.
function Serialization.encode(value: any, depth: number?): any
	local remaining = depth or Config.MAX_TABLE_DEPTH
	local valueType = typeof(value)

	if valueType == "nil" or valueType == "boolean" or valueType == "string" then
		return value
	elseif valueType == "number" then
		-- JSON cannot express NaN/inf.
		if value ~= value then
			return "NaN"
		elseif value == math.huge then
			return "Infinity"
		elseif value == -math.huge then
			return "-Infinity"
		end
		return value
	elseif valueType == "Vector3" then
		return tagged("Vector3", { value.X, value.Y, value.Z })
	elseif valueType == "Vector2" then
		return tagged("Vector2", { value.X, value.Y })
	elseif valueType == "CFrame" then
		return tagged("CFrame", { (value :: CFrame):GetComponents() })
	elseif valueType == "Color3" then
		return tagged("Color3", { value.R, value.G, value.B })
	elseif valueType == "BrickColor" then
		return tagged("BrickColor", tostring(value))
	elseif valueType == "UDim" then
		return tagged("UDim", { value.Scale, value.Offset })
	elseif valueType == "UDim2" then
		return tagged("UDim2", { value.X.Scale, value.X.Offset, value.Y.Scale, value.Y.Offset })
	elseif valueType == "EnumItem" then
		return tostring(value)
	elseif valueType == "Instance" then
		return tagged("Instance", PathResolver.pathOf(value))
	elseif valueType == "NumberRange" then
		return tagged("NumberRange", { value.Min, value.Max })
	elseif valueType == "Rect" then
		return tagged("Rect", { value.Min.X, value.Min.Y, value.Max.X, value.Max.Y })
	elseif valueType == "ColorSequence" then
		local keypoints = {}
		for _, kp in (value :: ColorSequence).Keypoints do
			table.insert(keypoints, { time = kp.Time, color = { kp.Value.R, kp.Value.G, kp.Value.B } })
		end
		return tagged("ColorSequence", keypoints)
	elseif valueType == "NumberSequence" then
		local keypoints = {}
		for _, kp in (value :: NumberSequence).Keypoints do
			table.insert(keypoints, { time = kp.Time, value = kp.Value, envelope = kp.Envelope })
		end
		return tagged("NumberSequence", keypoints)
	elseif valueType == "Font" then
		local font = value :: Font
		return tagged("Font", { family = font.Family, weight = font.Weight.Name, style = font.Style.Name })
	elseif valueType == "table" then
		if remaining <= 0 then
			return "<table: max depth reached>"
		end
		local out: { [any]: any } = {}
		local count = 0
		for k, v in value do
			count += 1
			if count > Config.MAX_TABLE_KEYS then
				out["<truncated>"] = true
				break
			end
			local key = if type(k) == "string" then k else tostring(k)
			out[key] = Serialization.encode(v, remaining - 1)
		end
		return out
	end
	return ("<%s: %s>"):format(valueType, tostring(value))
end

-- ------------------------------------------------------ property utilities --

local ScriptEditorService = game:GetService("ScriptEditorService")

--- Set a script's source through ScriptEditorService when possible (keeps
--- open editors in sync), falling back to direct assignment.
function Serialization.setScriptSource(container: LuaSourceContainer, source: string)
	local ok = pcall(function()
		ScriptEditorService:UpdateSourceAsync(container, function()
			return source
		end)
	end)
	if not ok then
		(container :: any).Source = source
	end
end

--- Read a script's source (prefers ScriptEditorService for open documents).
function Serialization.getScriptSource(container: LuaSourceContainer): string
	local ok, source = pcall(function()
		return ScriptEditorService:GetEditorSource(container)
	end)
	if ok and type(source) == "string" then
		return source
	end
	return (container :: any).Source
end

--- Apply a property map ({ name = jsonValue }) to an instance.
--- Keys prefixed with "@" set attributes instead of properties.
function Serialization.applyProperties(instance: Instance, properties: { [string]: any })
	for name, jsonValue in properties do
		if string.sub(name, 1, 1) == "@" then
			local attributeName = string.sub(name, 2)
			instance:SetAttribute(attributeName, Serialization.decode(jsonValue))
		elseif name == "Source" then
			local container = instance
			if not container:IsA("LuaSourceContainer") then
				error(("Cannot set Source on %s (%s)"):format(instance:GetFullName(), instance.ClassName), 0)
			end
			local decoded = Serialization.decode(jsonValue)
			if type(decoded) ~= "string" then
				error("Source must be a string", 0)
			end
			Serialization.setScriptSource(container :: LuaSourceContainer, decoded)
		else
			local decoded = Serialization.decode(jsonValue)
			local ok, err = pcall(function()
				(instance :: any)[name] = decoded
			end)
			if not ok then
				error(("Failed to set %s.%s: %s"):format(instance:GetFullName(), name, tostring(err)), 0)
			end
		end
	end
end

--- Common readable properties per class family, used when the caller does not
--- pass an explicit property list.
local COMMON_PROPERTIES: { { classCheck: string, properties: { string } } } = {
	{ classCheck = "BasePart", properties = { "Position", "Size", "Color", "Material", "Anchored", "CanCollide", "Transparency", "Shape", "CFrame" } },
	{ classCheck = "Model", properties = { "PrimaryPart" } },
	{ classCheck = "Humanoid", properties = { "Health", "MaxHealth", "WalkSpeed", "JumpPower", "DisplayName" } },
	{ classCheck = "GuiObject", properties = { "Position", "Size", "AnchorPoint", "BackgroundColor3", "BackgroundTransparency", "Visible", "ZIndex" } },
	{ classCheck = "TextLabel", properties = { "Text", "TextColor3", "TextSize", "Font", "TextXAlignment" } },
	{ classCheck = "TextButton", properties = { "Text", "TextColor3", "TextSize", "Font" } },
	{ classCheck = "TextBox", properties = { "Text", "PlaceholderText", "TextSize" } },
	{ classCheck = "ScreenGui", properties = { "Enabled", "DisplayOrder", "IgnoreGuiInset" } },
	{ classCheck = "LuaSourceContainer", properties = { "Enabled" } },
	{ classCheck = "Light", properties = { "Brightness", "Color", "Enabled" } },
	{ classCheck = "Sound", properties = { "SoundId", "Volume", "Playing", "Looped" } },
	{ classCheck = "Camera", properties = { "CFrame", "FieldOfView", "CameraType" } },
	{ classCheck = "Lighting", properties = { "Brightness", "ClockTime", "Ambient", "OutdoorAmbient", "FogEnd", "FogStart", "Technology" } },
	{ classCheck = "Attachment", properties = { "Position", "WorldPosition" } },
	{ classCheck = "SpawnLocation", properties = { "Neutral", "TeamColor" } },
	{ classCheck = "ProximityPrompt", properties = { "ActionText", "ObjectText", "HoldDuration", "MaxActivationDistance" } },
}

--- Read an instance's properties, either an explicit list or class defaults.
function Serialization.readProperties(instance: Instance, propertyList: { string }?): { [string]: any }
	local out: { [string]: any } = {}
	local names: { string } = { "Name", "ClassName" }
	if propertyList then
		names = propertyList
	else
		for _, group in COMMON_PROPERTIES do
			local isMatch = false
			pcall(function()
				isMatch = instance:IsA(group.classCheck)
			end)
			if isMatch then
				for _, propertyName in group.properties do
					table.insert(names, propertyName)
				end
			end
		end
	end
	for _, name in names do
		local ok, value = pcall(function()
			return (instance :: any)[name]
		end)
		if ok and typeof(value) ~= "function" and typeof(value) ~= "RBXScriptSignal" then
			out[name] = Serialization.encode(value, 3)
		end
	end
	return out
end

return Serialization
