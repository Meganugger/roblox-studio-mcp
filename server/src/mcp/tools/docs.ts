import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, textResult, ToolContext } from "../tool-helpers.js";

/**
 * get_roblox_docs: fetch official Roblox engine API documentation from the
 * source of docs.roblox.com (the public Roblox/creator-docs repository) and
 * condense it for an AI agent. This lets the agent check real API semantics
 * (property types, method signatures, deprecations, event parameters) before
 * writing code instead of hallucinating them.
 */

const DOCS_BASE =
  "https://raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/engine";

const CATEGORY_PATHS = {
  class: "classes",
  datatype: "datatypes",
  enum: "enums",
  global: "globals",
  library: "libraries",
} as const;

type DocCategory = keyof typeof CATEGORY_PATHS;

const MAX_RESPONSE_CHARS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_MAX_ENTRIES = 100;

const cache = new Map<string, string>();

function cachePut(key: string, value: string): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

/** Fetch implementation, injectable for tests. */
export type DocsFetcher = (url: string) => Promise<{ status: number; text(): Promise<string> }>;

let fetcher: DocsFetcher = async (url) => {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "User-Agent": "roblox-studio-mcp" },
  });
  return res;
};

export function setDocsFetcher(custom: DocsFetcher): void {
  fetcher = custom;
}

/**
 * The engine reference files are YAML. A full YAML parser is unnecessary: we
 * condense the document by keeping structural/semantic lines (names, types,
 * summaries, parameters, returns, deprecation tags) and dropping bulky
 * metadata (memory_category, thread_safety, capabilities, code samples).
 */
export function condenseEngineYaml(yaml: string, memberFilter?: string): string {
  const dropKeys = new Set([
    "code_samples",
    "memory_category",
    "thread_safety",
    "capabilities",
    "serialization",
    "writeCapabilities",
    "tags:",
  ]);
  const lines = yaml.split("\n");
  const out: string[] = [];
  let skipBlockIndent: number | null = null;
  let insideIrrelevantMember = false;
  let memberIndent = 0;

  const indentOf = (line: string): number => line.length - line.trimStart().length;

  for (const line of lines) {
    const trimmed = line.trim();
    const indent = indentOf(line);

    // End a skipped nested block once indentation returns.
    if (skipBlockIndent !== null) {
      if (trimmed !== "" && indent <= skipBlockIndent) {
        skipBlockIndent = null;
      } else {
        continue;
      }
    }

    // Member filtering: keep only entries whose `- name:` matches.
    if (memberFilter) {
      const nameMatch = /^- name:\s*(.+)$/.exec(trimmed);
      if (nameMatch) {
        memberIndent = indent;
        const memberName = nameMatch[1].trim();
        const short = memberName.split(/[.:]/).pop() ?? memberName;
        insideIrrelevantMember = short.toLowerCase() !== memberFilter.toLowerCase();
      } else if (insideIrrelevantMember && trimmed !== "" && indent <= memberIndent && !trimmed.startsWith("-")) {
        insideIrrelevantMember = false;
      }
      if (insideIrrelevantMember) continue;
    }

    const key = trimmed.split(":")[0] + (trimmed.includes(":") ? "" : ":");
    if (dropKeys.has(key) || dropKeys.has(trimmed.split(":")[0])) {
      // Skip the key line and any nested block under it.
      if (trimmed.endsWith(":") || trimmed.endsWith("|")) {
        skipBlockIndent = indent;
      }
      continue;
    }
    if (trimmed === "" && out[out.length - 1] === "") continue;
    out.push(line);
  }

  let result = out.join("\n");
  if (result.length > MAX_RESPONSE_CHARS) {
    result =
      result.slice(0, MAX_RESPONSE_CHARS) +
      "\n... [truncated; pass `member` to fetch a specific property/method/event]";
  }
  return result;
}

export function registerDocsTools(server: McpServer, _ctx: ToolContext): void {
  server.registerTool(
    "get_roblox_docs",
    {
      title: "Get official Roblox API docs",
      description:
        "Fetch official Roblox engine API documentation (from the source of docs.roblox.com) for a class " +
        "(e.g. ProximityPrompt, Humanoid), datatype (CFrame, UDim2), enum (Material), Luau global (task) or " +
        "library (string). Returns condensed reference text: summaries, properties with types, method/event " +
        "signatures, parameters and deprecation notes. Check real API semantics here before writing code " +
        "instead of guessing. Use `member` to narrow the response to one property/method/event.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z0-9_]+$/, "API names are alphanumeric, e.g. ProximityPrompt, CFrame, Material.")
          .describe("Class/datatype/enum/global/library name, exact casing preferred (e.g. ProximityPrompt)."),
        category: z
          .enum(["auto", "class", "datatype", "enum", "global", "library"])
          .default("auto")
          .describe('Where to look. "auto" tries class, then datatype, then enum, then library, then global.'),
        member: z
          .string()
          .max(100)
          .optional()
          .describe('Narrow to one member, e.g. "Triggered" on ProximityPrompt.'),
      },
    },
    async ({ name, category, member }) => {
      const categories: DocCategory[] =
        category === "auto" ? ["class", "datatype", "enum", "library", "global"] : [category];

      for (const cat of categories) {
        const url = `${DOCS_BASE}/${CATEGORY_PATHS[cat]}/${name}.yaml`;
        const cacheKey = url;
        let raw = cache.get(cacheKey);
        if (raw === undefined) {
          try {
            const res = await fetcher(url);
            if (res.status === 404) continue;
            if (res.status !== 200) {
              return errorResult(
                `Roblox docs fetch failed with HTTP ${res.status} for ${name} (${cat}). Try again shortly.`,
              );
            }
            raw = await res.text();
            cachePut(cacheKey, raw);
          } catch (err) {
            return errorResult(
              `Could not reach the Roblox docs source (${String(err)}). The server needs outbound HTTPS ` +
                "access to raw.githubusercontent.com for this tool.",
            );
          }
        }
        const condensed = condenseEngineYaml(raw, member);
        return textResult(
          `Official Roblox engine reference for ${cat} "${name}"${member ? ` (member: ${member})` : ""}:\n\n` +
            condensed,
        );
      }

      return errorResult(
        `No official engine reference found for "${name}" (looked in: ${categories.join(", ")}). ` +
          "Check the casing (e.g. ProximityPrompt, CFrame, Material) or try a different category.",
      );
    },
  );
}
