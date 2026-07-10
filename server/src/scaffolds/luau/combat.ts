import { Scaffold } from "../types.js";

const COMBAT_SERVICE = `--!strict
-- CombatService: server-authoritative melee combat with hitbox validation,
-- cooldowns, kill credit and reward hooks. Installed by Roblox Studio MCP (scaffold: combat).
--
-- Client sends only an attack *request*; the server validates range, angle,
-- cooldown and line-of-sight-free proximity before applying damage.
--
-- Client:
--   Net.fireServer("Combat:Attack")
--   Net.event("Combat:Hit").OnClientEvent -> (targetName, damage)
-- Server:
--   CombatService:OnKill(callback(killer: Player, victim: Model))
--   CombatService:DealDamage(attacker, humanoid, amount)

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Net = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("Net"))

local ATTACK_COOLDOWN = 0.5
local ATTACK_RANGE = 8
local ATTACK_DAMAGE = 15
local ATTACK_DOT_MIN = 0.25 -- target must be roughly in front of the attacker

local CombatService = {}

local lastAttackAt: { [Player]: number } = {}
local killCallbacks: { (killer: Player, victim: Model) -> () } = {}
local creditedDeaths: { [Humanoid]: boolean } = {}

Players.PlayerRemoving:Connect(function(player)
	lastAttackAt[player] = nil
end)

function CombatService:OnKill(callback: (killer: Player, victim: Model) -> ())
	table.insert(killCallbacks, callback)
end

function CombatService:DealDamage(attacker: Player, humanoid: Humanoid, amount: number)
	if humanoid.Health <= 0 then
		return
	end
	humanoid:TakeDamage(amount)
	if humanoid.Health <= 0 and not creditedDeaths[humanoid] then
		creditedDeaths[humanoid] = true
		task.delay(5, function()
			creditedDeaths[humanoid] = nil
		end)
		local victimModel = humanoid.Parent
		if victimModel and victimModel:IsA("Model") then
			for _, callback in killCallbacks do
				task.spawn(callback, attacker, victimModel)
			end
		end
	end
end

local function findTargets(attacker: Player): { Humanoid }
	local character = attacker.Character
	local root = character and character:FindFirstChild("HumanoidRootPart") :: BasePart?
	if not character or not root then
		return {}
	end
	local origin = root.Position
	local facing = root.CFrame.LookVector
	local targets: { Humanoid } = {}
	for _, model in workspace:GetDescendants() do
		if model:IsA("Humanoid") and model.Health > 0 then
			local targetModel = model.Parent
			if targetModel and targetModel ~= character and targetModel:IsA("Model") then
				local targetRoot = targetModel:FindFirstChild("HumanoidRootPart") :: BasePart?
				if targetRoot then
					local offset = targetRoot.Position - origin
					local distance = offset.Magnitude
					if distance <= ATTACK_RANGE and distance > 0 then
						local dot = facing:Dot(offset.Unit)
						if dot >= ATTACK_DOT_MIN then
							table.insert(targets, model)
						end
					end
				end
			end
		end
	end
	return targets
end

local function onAttack(player: Player)
	local now = os.clock()
	if (lastAttackAt[player] or 0) + ATTACK_COOLDOWN > now then
		return
	end
	lastAttackAt[player] = now
	for _, humanoid in findTargets(player) do
		CombatService:DealDamage(player, humanoid, ATTACK_DAMAGE)
		local targetModel = humanoid.Parent
		Net.fireClient("Combat:Hit", player, targetModel and targetModel.Name or "?", ATTACK_DAMAGE)
	end
end

function CombatService:Start()
	Net.onEvent("Combat:Attack", onAttack, { ratePerSecond = 4 })
end

return CombatService
`;

export const combatScaffold: Scaffold = {
  id: "combat",
  title: "Combat system",
  description:
    "Server-authoritative melee combat: attack requests validated for cooldown, range and facing angle on " +
    "the server, humanoid damage with double-credit protection, kill hooks (wire to currency/XP rewards), " +
    "and rate-limited remotes so exploiters cannot spam damage.",
  dependencies: ["core"],
  files: [
    {
      parentPath: "game.ServerScriptService.Server.Services",
      className: "ModuleScript",
      name: "CombatService",
      source: COMBAT_SERVICE,
    },
  ],
};
