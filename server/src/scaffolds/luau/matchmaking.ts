import { Scaffold } from "../types.js";

const ROUND_SERVICE = `--!strict
-- RoundService: in-place round/matchmaking loop with lobby, countdown, active
-- round and results phases. Installed by Roblox Studio MCP (scaffold: matchmaking).
--
-- Phases: Intermission (lobby) -> Countdown -> Active -> Results -> repeat.
-- Players who join mid-round wait in the lobby for the next round.
--
-- Map anchors (optional, created on demand if missing):
--   workspace.Lobby.LobbySpawn (BasePart)   - where players wait
--   workspace.Arena.ArenaSpawn (BasePart)   - where rounds happen
--
-- Server:
--   RoundService:OnRoundStarted(callback(participants: { Player }))
--   RoundService:OnRoundEnded(callback(results: { winners: { Player } }))
--   RoundService:SetWinCondition(fn(participants) -> winners?) -- checked every second
-- Client:
--   Net.event("Round:State").OnClientEvent -> (phase, secondsRemaining, participantCount)

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Net = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("Net"))

local INTERMISSION_SECONDS = 15
local COUNTDOWN_SECONDS = 3
local ROUND_SECONDS = 120
local RESULTS_SECONDS = 8
local MIN_PLAYERS = 1

local RoundService = {}

local phase = "Intermission"
local phaseEndsAt = 0
local participants: { [Player]: boolean } = {}

local startedCallbacks: { (players: { Player }) -> () } = {}
local endedCallbacks: { (results: { winners: { Player } }) -> () } = {}
local winCondition: ((players: { Player }) -> { Player }?)? = nil

local function anchor(folderName: string, partName: string, position: Vector3): BasePart
	local folder = workspace:FindFirstChild(folderName)
	if not folder then
		folder = Instance.new("Folder")
		folder.Name = folderName
		folder.Parent = workspace
	end
	local part = folder:FindFirstChild(partName)
	if not part then
		part = Instance.new("Part")
		part.Name = partName
		part.Anchored = true
		part.Size = Vector3.new(12, 1, 12)
		part.Position = position
		part.Parent = folder
	end
	return part :: BasePart
end

local function teleport(player: Player, destination: BasePart)
	local character = player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart") :: BasePart?
	if root then
		root.CFrame = destination.CFrame + Vector3.new(math.random(-4, 4), 4, math.random(-4, 4))
	end
end

local function participantList(): { Player }
	local list = {}
	for player in participants do
		if player.Parent then
			table.insert(list, player)
		end
	end
	return list
end

local function broadcast()
	local remaining = math.max(0, math.floor(phaseEndsAt - os.clock()))
	Net.fireAllClients("Round:State", phase, remaining, #participantList())
end

local function setPhase(newPhase: string, duration: number)
	phase = newPhase
	phaseEndsAt = os.clock() + duration
	broadcast()
end

function RoundService:OnRoundStarted(callback: (players: { Player }) -> ())
	table.insert(startedCallbacks, callback)
end

function RoundService:OnRoundEnded(callback: (results: { winners: { Player } }) -> ())
	table.insert(endedCallbacks, callback)
end

function RoundService:SetWinCondition(fn: (players: { Player }) -> { Player }?)
	winCondition = fn
end

function RoundService:GetPhase(): string
	return phase
end

local function runRound(lobbySpawn: BasePart, arenaSpawn: BasePart)
	-- Countdown
	setPhase("Countdown", COUNTDOWN_SECONDS)
	task.wait(COUNTDOWN_SECONDS)

	-- Activate: everyone currently in game participates.
	participants = {}
	for _, player in Players:GetPlayers() do
		participants[player] = true
		teleport(player, arenaSpawn)
	end
	setPhase("Active", ROUND_SECONDS)
	for _, callback in startedCallbacks do
		task.spawn(callback, participantList())
	end

	-- Round loop: end on timeout or win condition.
	local winners: { Player } = {}
	while os.clock() < phaseEndsAt do
		task.wait(1)
		broadcast()
		if winCondition then
			local ok, result = pcall(winCondition, participantList())
			if ok and result then
				winners = result
				break
			end
		end
	end

	-- Results
	setPhase("Results", RESULTS_SECONDS)
	for _, callback in endedCallbacks do
		task.spawn(callback, { winners = winners })
	end
	task.wait(RESULTS_SECONDS)

	-- Back to lobby
	for _, player in Players:GetPlayers() do
		teleport(player, lobbySpawn)
	end
	participants = {}
end

function RoundService:Start()
	local lobbySpawn = anchor("Lobby", "LobbySpawn", Vector3.new(0, 5, -60))
	local arenaSpawn = anchor("Arena", "ArenaSpawn", Vector3.new(0, 5, 60))

	Players.PlayerRemoving:Connect(function(player)
		participants[player] = nil
	end)

	task.spawn(function()
		while true do
			setPhase("Intermission", INTERMISSION_SECONDS)
			local deadline = os.clock() + INTERMISSION_SECONDS
			while os.clock() < deadline or #Players:GetPlayers() < MIN_PLAYERS do
				task.wait(1)
				broadcast()
			end
			runRound(lobbySpawn, arenaSpawn)
		end
	end)
end

return RoundService
`;

export const matchmakingScaffold: Scaffold = {
  id: "matchmaking",
  title: "Rounds & matchmaking loop",
  description:
    "In-place round system: Intermission -> Countdown -> Active -> Results loop with lobby/arena teleports, " +
    "pluggable win conditions, round start/end hooks for rewards, live phase broadcasts to clients, and " +
    "mid-round joiner handling.",
  dependencies: ["core"],
  files: [
    {
      parentPath: "game.ServerScriptService.Server.Services",
      className: "ModuleScript",
      name: "RoundService",
      source: ROUND_SERVICE,
    },
  ],
};
