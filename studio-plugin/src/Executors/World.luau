--!strict
-- World building command handlers: terrain, lighting, asset insertion, camera.

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local InsertService = game:GetService("InsertService")
local Lighting = game:GetService("Lighting")

local PathResolver = require(script.Parent.Parent.PathResolver)
local Serialization = require(script.Parent.Parent.Serialization)

local function waypoint(label: string)
	pcall(function()
		ChangeHistoryService:SetWaypoint("MCP: " .. label)
	end)
end

local function materialFromName(name: string): Enum.Material
	local ok, material = pcall(function()
		return (Enum.Material :: any)[name]
	end)
	if not ok or typeof(material) ~= "EnumItem" then
		error(("Unknown material %q (use Enum.Material names like Grass, Rock, Sand, Water)"):format(name), 0)
	end
	return material
end

local function vec3(list: { number }): Vector3
	return Vector3.new(list[1], list[2], list[3])
end

local handlers: { [string]: (payload: { [string]: any }) -> any } = {}

handlers.GenerateTerrain = function(payload)
	local terrain = workspace.Terrain
	local material = materialFromName(payload.material or "Grass")
	local center = vec3(payload.center)
	local size = vec3(payload.size)
	local shape = payload.shape

	if shape == "block" then
		terrain:FillBlock(CFrame.new(center), size, material)
	elseif shape == "ball" then
		terrain:FillBall(center, math.abs(size.X) / 2, material)
	elseif shape == "hills" then
		local seed = payload.seed or math.random(1, 10_000)
		local amplitude = payload.amplitude or 40
		local frequency = payload.frequency or 0.02

		-- Column-based heightmap. Column size adapts so large regions stay
		-- within a sane number of FillBlock calls.
		local columnsPerAxis = 96
		local stepX = math.max(8, math.ceil(size.X / columnsPerAxis))
		local stepZ = math.max(8, math.ceil(size.Z / columnsPerAxis))
		local baseY = center.Y
		local halfX = size.X / 2
		local halfZ = size.Z / 2

		local calls = 0
		local x = -halfX
		while x < halfX do
			local z = -halfZ
			while z < halfZ do
				local worldX = center.X + x + stepX / 2
				local worldZ = center.Z + z + stepZ / 2
				local noise = math.noise(seed + worldX * frequency, worldZ * frequency)
				local height = math.max(4, (noise + 0.6) * amplitude)
				terrain:FillBlock(
					CFrame.new(worldX, baseY + height / 2, worldZ),
					Vector3.new(stepX, height, stepZ),
					material
				)
				calls += 1
				if calls % 512 == 0 then
					task.wait() -- keep Studio responsive on big maps
				end
				z += stepZ
			end
			x += stepX
		end
		waypoint("Generate hills terrain")
		return { generated = true, shape = shape, columns = calls, seed = seed }
	else
		error(("Unknown terrain shape %q"):format(tostring(shape)), 0)
	end

	waypoint("Generate terrain " .. shape)
	return { generated = true, shape = shape }
end

handlers.ClearTerrain = function(_payload)
	workspace.Terrain:Clear()
	waypoint("Clear terrain")
	return { cleared = true }
end

local LIGHTING_PRESETS: { [string]: { properties: { [string]: any }, children: { { className: string, name: string, properties: { [string]: any } } } } } = {
	day = {
		properties = { ClockTime = 12, Brightness = 3, Ambient = Color3.fromRGB(70, 70, 70), OutdoorAmbient = Color3.fromRGB(128, 128, 128), FogEnd = 100000 },
		children = {
			{ className = "Atmosphere", name = "Atmosphere", properties = { Density = 0.3, Offset = 0.25, Haze = 0.5 } },
			{ className = "BloomEffect", name = "Bloom", properties = { Intensity = 0.6, Size = 24, Threshold = 1.5 } },
		},
	},
	sunset = {
		properties = { ClockTime = 17.8, Brightness = 2, Ambient = Color3.fromRGB(80, 60, 60), OutdoorAmbient = Color3.fromRGB(150, 110, 90) },
		children = {
			{ className = "Atmosphere", name = "Atmosphere", properties = { Density = 0.42, Offset = 0.6, Haze = 1.8, Glare = 0.6 } },
			{ className = "BloomEffect", name = "Bloom", properties = { Intensity = 1, Size = 32, Threshold = 1.2 } },
			{ className = "ColorCorrectionEffect", name = "ColorCorrection", properties = { TintColor = Color3.fromRGB(255, 226, 200), Saturation = 0.1 } },
		},
	},
	night = {
		properties = { ClockTime = 0, Brightness = 1, Ambient = Color3.fromRGB(30, 30, 45), OutdoorAmbient = Color3.fromRGB(60, 60, 90) },
		children = {
			{ className = "Atmosphere", name = "Atmosphere", properties = { Density = 0.35, Offset = 0.2, Haze = 1 } },
			{ className = "BloomEffect", name = "Bloom", properties = { Intensity = 0.8, Size = 28, Threshold = 1 } },
		},
	},
	["foggy-horror"] = {
		properties = { ClockTime = 2, Brightness = 0.6, Ambient = Color3.fromRGB(20, 22, 24), OutdoorAmbient = Color3.fromRGB(40, 44, 48), FogEnd = 220, FogStart = 20, FogColor = Color3.fromRGB(18, 20, 22) },
		children = {
			{ className = "Atmosphere", name = "Atmosphere", properties = { Density = 0.55, Offset = 0, Haze = 2.5 } },
			{ className = "ColorCorrectionEffect", name = "ColorCorrection", properties = { Saturation = -0.4, Contrast = 0.1, TintColor = Color3.fromRGB(200, 210, 220) } },
		},
	},
	["neon-city"] = {
		properties = { ClockTime = 0.5, Brightness = 1.4, Ambient = Color3.fromRGB(35, 25, 55), OutdoorAmbient = Color3.fromRGB(70, 50, 110) },
		children = {
			{ className = "Atmosphere", name = "Atmosphere", properties = { Density = 0.4, Offset = 0.3, Haze = 1.6, Color = Color3.fromRGB(120, 80, 180) } },
			{ className = "BloomEffect", name = "Bloom", properties = { Intensity = 1.6, Size = 40, Threshold = 0.9 } },
			{ className = "ColorCorrectionEffect", name = "ColorCorrection", properties = { Saturation = 0.25, Contrast = 0.12, TintColor = Color3.fromRGB(235, 220, 255) } },
		},
	},
}

handlers.SetLighting = function(payload)
	if payload.preset then
		local preset = LIGHTING_PRESETS[payload.preset]
		if not preset then
			error(("Unknown lighting preset %q"):format(tostring(payload.preset)), 0)
		end
		for name, value in preset.properties do
			(Lighting :: any)[name] = value
		end
		for _, childSpec in preset.children do
			local child = Lighting:FindFirstChild(childSpec.name)
			if not child or child.ClassName ~= childSpec.className then
				if child then
					child:Destroy()
				end
				child = Instance.new(childSpec.className)
				child.Name = childSpec.name
				child.Parent = Lighting
			end
			for name, value in childSpec.properties do
				(child :: any)[name] = value
			end
		end
	end
	if payload.properties then
		Serialization.applyProperties(Lighting, payload.properties)
	end
	waypoint("Set lighting")
	return {
		applied = true,
		preset = payload.preset,
		lighting = Serialization.readProperties(Lighting),
	}
end

handlers.InsertAsset = function(payload)
	local parent = PathResolver.mustResolve(payload.parentPath or "game.Workspace")
	local ok, modelOrErr = pcall(function()
		return InsertService:LoadAsset(payload.assetId)
	end)
	if not ok then
		error(("Failed to load asset %d: %s"):format(payload.assetId, tostring(modelOrErr)), 0)
	end
	local container = modelOrErr :: Model

	local strippedScripts = 0
	if payload.allowScripts ~= true then
		for _, descendant in container:GetDescendants() do
			if descendant:IsA("LuaSourceContainer") then
				descendant:Destroy()
				strippedScripts += 1
			end
		end
	end

	-- LoadAsset wraps content in a Model; unwrap single children for cleanliness.
	local children = container:GetChildren()
	local inserted: Instance
	if #children == 1 then
		inserted = children[1]
		inserted.Parent = parent
		container:Destroy()
	else
		container.Name = "Asset_" .. tostring(payload.assetId)
		container.Parent = parent
		inserted = container
	end

	waypoint("Insert asset " .. tostring(payload.assetId))
	return {
		path = PathResolver.pathOf(inserted),
		className = inserted.ClassName,
		strippedScripts = strippedScripts,
	}
end

handlers.SetCamera = function(payload)
	local camera = workspace.CurrentCamera
	if not camera then
		error("No active camera", 0)
	end
	local position = vec3(payload.position)
	local lookAt = if payload.lookAt then vec3(payload.lookAt) else position + Vector3.new(0, -1, -1)
	camera.CameraType = Enum.CameraType.Scriptable
	camera.CFrame = CFrame.lookAt(position, lookAt)
	camera.CameraType = Enum.CameraType.Fixed
	return { position = Serialization.encode(position), lookAt = Serialization.encode(lookAt) }
end

return handlers
