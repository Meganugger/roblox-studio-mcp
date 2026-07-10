import { Scaffold } from "../types.js";

const NPC_SERVICE = `--!strict
-- NPCService: spawns humanoid NPCs and drives a simple, cheap state machine
-- (Idle -> Wander -> Chase -> Attack). Installed by Roblox Studio MCP (scaffold: npc).
--
-- NPC templates: put rigged Models (Humanoid + HumanoidRootPart) in
-- ServerStorage.NPCTemplates. If the folder is empty, NPCService builds a
-- basic capsule NPC so the system works out of the box.
--
-- Server:
--   NPCService:Spawn(templateName?, position: Vector3, config?) -> Model
--   NPCService:OnNPCDied(callback(npc: Model, killer: Player?))

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local ServerStorage = game:GetService("ServerStorage")

local NPCService = {}

export type NPCConfig = {
	health: number?,
	walkSpeed: number?,
	aggroRange: number?,
	attackRange: number?,
	attackDamage: number?,
	attackCooldown: number?,
	wanderRadius: number?,
}

local DEFAULTS: NPCConfig = {
	health = 100,
	walkSpeed = 12,
	aggroRange = 40,
	attackRange = 6,
	attackDamage = 10,
	attackCooldown = 1.5,
	wanderRadius = 20,
}

type NPCState = {
	model: Model,
	humanoid: Humanoid,
	root: BasePart,
	config: NPCConfig,
	home: Vector3,
	mode: string, -- "Idle" | "Wander" | "Chase" | "Attack"
	target: Player?,
	nextDecisionAt: number,
	lastAttackAt: number,
}

local active: { [Model]: NPCState } = {}
local diedCallbacks: { (npc: Model, killer: Player?) -> () } = {}

local function buildFallbackTemplate(): Model
	local model = Instance.new("Model")
	model.Name = "BasicNPC"

	local root = Instance.new("Part")
	root.Name = "HumanoidRootPart"
	root.Size = Vector3.new(2, 2, 1)
	root.Color = Color3.fromRGB(196, 40, 28)
	root.Parent = model

	local head = Instance.new("Part")
	head.Name = "Head"
	head.Shape = Enum.PartType.Ball
	head.Size = Vector3.new(1.2, 1.2, 1.2)
	head.Color = Color3.fromRGB(245, 205, 48)
	head.Parent = model

	local weld = Instance.new("WeldConstraint")
	weld.Part0 = root
	weld.Part1 = head
	weld.Parent = root
	head.CFrame = root.CFrame + Vector3.new(0, 1.6, 0)

	local humanoid = Instance.new("Humanoid")
	humanoid.Parent = model
	model.PrimaryPart = root
	return model
end

local function templateNamed(templateName: string?): Model
	local folder = ServerStorage:FindFirstChild("NPCTemplates")
	if folder then
		local template = if templateName then folder:FindFirstChild(templateName) else folder:FindFirstChildOfClass("Model")
		if template and template:IsA("Model") then
			return template
		end
	end
	return buildFallbackTemplate()
end

function NPCService:OnNPCDied(callback: (npc: Model, killer: Player?) -> ())
	table.insert(diedCallbacks, callback)
end

function NPCService:Spawn(templateName: string?, position: Vector3, config: NPCConfig?): Model
	local merged: NPCConfig = table.clone(DEFAULTS)
	if config then
		for key, value in config :: { [string]: any } do
			(merged :: { [string]: any })[key] = value
		end
	end

	local model = templateNamed(templateName):Clone()
	model.Parent = workspace
	model:PivotTo(CFrame.new(position + Vector3.new(0, 3, 0)))

	local humanoid = model:FindFirstChildOfClass("Humanoid")
	local root = model:FindFirstChild("HumanoidRootPart")
	assert(humanoid and root and root:IsA("BasePart"), "NPC template needs Humanoid + HumanoidRootPart")

	humanoid.MaxHealth = merged.health :: number
	humanoid.Health = merged.health :: number
	humanoid.WalkSpeed = merged.walkSpeed :: number

	local state: NPCState = {
		model = model,
		humanoid = humanoid,
		root = root,
		config = merged,
		home = position,
		mode = "Idle",
		target = nil,
		nextDecisionAt = 0,
		lastAttackAt = 0,
	}
	active[model] = state

	humanoid.Died:Connect(function()
		active[model] = nil
		local killer: Player? = nil
		local tag = humanoid:FindFirstChild("creator")
		if tag and tag:IsA("ObjectValue") and tag.Value and tag.Value:IsA("Player") then
			killer = tag.Value :: Player
		end
		for _, callback in diedCallbacks do
			task.spawn(callback, model, killer)
		end
		task.delay(3, function()
			if model.Parent then
				model:Destroy()
			end
		end)
	end)

	return model
end

local function nearestPlayer(position: Vector3, maxDistance: number): (Player?, number)
	local best: Player? = nil
	local bestDistance = maxDistance
	for _, player in Players:GetPlayers() do
		local character = player.Character
		local root = character and character:FindFirstChild("HumanoidRootPart") :: BasePart?
		local humanoid = character and character:FindFirstChildOfClass("Humanoid")
		if root and humanoid and humanoid.Health > 0 then
			local distance = (root.Position - position).Magnitude
			if distance < bestDistance then
				best = player
				bestDistance = distance
			end
		end
	end
	return best, bestDistance
end

local function step(state: NPCState, now: number)
	if state.humanoid.Health <= 0 then
		return
	end
	local position = state.root.Position
	local target, distance = nearestPlayer(position, state.config.aggroRange :: number)

	if target then
		local targetRoot = (target.Character :: Model):FindFirstChild("HumanoidRootPart") :: BasePart
		if distance <= (state.config.attackRange :: number) then
			state.mode = "Attack"
			state.humanoid:MoveTo(position)
			if now - state.lastAttackAt >= (state.config.attackCooldown :: number) then
				state.lastAttackAt = now
				local targetHumanoid = (target.Character :: Model):FindFirstChildOfClass("Humanoid")
				if targetHumanoid then
					targetHumanoid:TakeDamage(state.config.attackDamage :: number)
				end
			end
		else
			state.mode = "Chase"
			state.humanoid:MoveTo(targetRoot.Position)
		end
		return
	end

	if now >= state.nextDecisionAt then
		state.nextDecisionAt = now + math.random(2, 5)
		if state.mode == "Wander" then
			state.mode = "Idle"
			state.humanoid:MoveTo(position)
		else
			state.mode = "Wander"
			local radius = state.config.wanderRadius :: number
			local offset = Vector3.new(math.random(-radius, radius), 0, math.random(-radius, radius))
			state.humanoid:MoveTo(state.home + offset)
		end
	end
end

function NPCService:Start()
	local accumulator = 0
	RunService.Heartbeat:Connect(function(dt)
		accumulator += dt
		if accumulator < 0.2 then -- 5 Hz AI tick keeps servers cheap
			return
		end
		accumulator = 0
		local now = os.clock()
		for _, state in active do
			local ok, err = pcall(step, state, now)
			if not ok then
				warn("[NPCService] AI step failed: " .. tostring(err))
			end
		end
	end)
end

return NPCService
`;

export const npcScaffold: Scaffold = {
  id: "npc",
  title: "NPC system",
  description:
    "NPC spawner + lightweight AI state machine (Idle/Wander/Chase/Attack) running on a cheap 5 Hz tick. " +
    "Uses your rigged models from ServerStorage.NPCTemplates or builds a fallback NPC so it works instantly. " +
    "Death hooks integrate with combat kill credit and reward systems.",
  dependencies: ["core"],
  files: [
    {
      parentPath: "game.ServerScriptService.Server.Services",
      className: "ModuleScript",
      name: "NPCService",
      source: NPC_SERVICE,
    },
  ],
};
