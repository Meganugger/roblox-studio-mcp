/**
 * Smoke test against the *built* server over the real HTTP MCP transport,
 * exactly as a URL-only AI platform would connect. Run with:
 *   node scripts/smoke-test.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(join(tmpdir(), "roblox-mcp-smoke-"));
const places = join(home, "places");
const bridgePort = 39671;
const httpPort = 39672;

const env = {
  ...process.env,
  ROBLOX_MCP_HOME: home,
  ROBLOX_MCP_PORT: String(bridgePort),
  ROBLOX_MCP_HTTP_PORT: String(httpPort),
  ROBLOX_MCP_TOKEN: "smoke-plugin-token-1234567890",
  ROBLOX_MCP_HTTP_TOKEN: "smoke-http-token-1234567890",
  ROBLOX_MCP_PLACES_DIR: places,
  ROBLOX_MCP_PLACES_ROOT: home,
  ROBLOX_MCP_SCREENSHOT_DIR: join(home, "shots"),
};

// Publishing must be off unless explicitly enabled. Clear anything inherited
// from the developer's shell so this run really tests the default.
for (const name of [
  "ROBLOX_MCP_ALLOW_PUBLISH",
  "ROBLOX_MCP_OPEN_CLOUD_KEY",
  "ROBLOX_MCP_UNIVERSE_ID",
  "ROBLOX_MCP_PLACE_ID",
  "ROBLOX_MCP_ALLOWED_UNIVERSES",
]) {
  delete env[name];
}

const checks = [];
const check = (name, condition, detail = "") => {
  checks.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
};

const server = spawn("node", [join(root, "server/dist/index.js"), "--transport", "http"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
server.stdout.on("data", (chunk) => (stdout += chunk));
server.stderr.on("data", (chunk) => (stderr += chunk));

const waitFor = async (predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

try {
  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${httpPort}/healthz`);
      return res.ok;
    } catch {
      return false;
    }
  }, 20_000, "the HTTP MCP endpoint");

  // Unauthenticated requests must be rejected.
  const anonymous = await fetch(`http://127.0.0.1:${httpPort}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  check("rejects MCP requests without a bearer token", anonymous.status === 401, `status ${anonymous.status}`);

  const bridgeHealth = await (await fetch(`http://127.0.0.1:${bridgePort}/health`)).json();
  check("plugin bridge health endpoint responds", bridgeHealth.ok === true);

  const client = new Client({ name: "smoke-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpPort}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${env.ROBLOX_MCP_HTTP_TOKEN}` } },
    }),
  );

  const { tools } = await client.listTools();
  check("exposes the full tool suite", tools.length === 68, `${tools.length} tools`);
  for (const expected of [
    "get_host_capabilities",
    "launch_studio",
    "capture_studio_screenshot",
    "send_studio_shortcut",
    "start_play_solo",
    "create_place_file",
    "open_place_file",
    "get_publish_capabilities",
    "publish_place",
    "restart_universe_servers",
  ]) {
    check(`tool ${expected} is registered`, tools.some((tool) => tool.name === expected));
  }

  const json = (result) => JSON.parse(result.content.find((block) => block.type === "text").text);

  const capabilities = json(await client.callTool({ name: "get_host_capabilities", arguments: {} }));
  check("reports the real host platform", capabilities.platform === process.platform, capabilities.platform);
  check("reports the native gates", capabilities.gates.nativeControl === true);
  check(
    "explains that Studio is not installed on this host",
    capabilities.studio.executablePath === null && capabilities.notes.join(" ").includes("ROBLOX_MCP_STUDIO_PATH"),
  );

  // Real place-file creation on this machine.
  const created = json(
    await client.callTool({ name: "create_place_file", arguments: { name: "SmokeSim", template: "baseplate" } }),
  );
  check("creates a real .rbxlx place file", existsSync(created.path), created.path);
  const placeXml = readFileSync(created.path, "utf8");
  check("place file is Roblox XML with a baseplate and spawn", placeXml.includes('<Item class="SpawnLocation"') && placeXml.includes(">Baseplate<"));

  const listed = json(await client.callTool({ name: "list_place_files", arguments: {} }));
  check("lists the created place", listed.files.some((file) => file.name === "SmokeSim.rbxlx"));

  const outside = await client.callTool({ name: "create_place_file", arguments: { path: "/etc/evil.rbxlx" } });
  check("refuses paths outside the sandbox", outside.isError === true);

  const noStudio = await client.callTool({ name: "focus_studio_window", arguments: {} });
  check(
    "native window control fails with an actionable message (no Studio here)",
    noStudio.isError === true,
    noStudio.content[0].text.slice(0, 80),
  );

  const notConnected = await client.callTool({ name: "get_selection", arguments: {} });
  check("plugin tools explain that Studio is not connected", notConnected.isError === true);

  // Publishing reaches real players, so verify the shipped default really is off.
  const publishing = json(await client.callTool({ name: "get_publish_capabilities", arguments: {} }));
  check("publishing is disabled by default", publishing.gates.publishing === false);
  check("no Open Cloud key is configured or invented", publishing.apiKey.configured === false && publishing.apiKey.fingerprint === null);
  check(
    "explains how to enable publishing",
    publishing.notes.join(" ").includes("ROBLOX_MCP_ALLOW_PUBLISH=1"),
  );

  const blockedPublish = await client.callTool({
    name: "publish_place",
    arguments: { path: created.path, universeId: 1, placeId: 1 },
  });
  check(
    "publish_place refuses while the gate is off",
    blockedPublish.isError === true && blockedPublish.content[0].text.includes("ROBLOX_MCP_ALLOW_PUBLISH"),
  );

  await client.close();

  check("stdout stayed clean in HTTP mode", stdout.trim().length === 0, JSON.stringify(stdout.slice(0, 80)));
  check("startup log mentions native host control", stderr.includes("Native host control:"));
  check("startup log reports the publishing gate", stderr.includes("Roblox publishing: disabled"));
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  rmSync(home, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} smoke checks passed`);
if (failed.length > 0) {
  console.error("Failed checks:", failed.map((entry) => entry.name).join(", "));
  process.exit(1);
}
