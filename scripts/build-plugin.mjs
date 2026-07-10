#!/usr/bin/env node
/**
 * build-plugin.mjs: pack studio-plugin/src into a ready-to-install Roblox
 * plugin model (studio-plugin/dist/RobloxStudioMCP.rbxmx).
 *
 * Mirrors Rojo's conventions so `rojo build studio-plugin -o out.rbxmx`
 * produces an equivalent artifact:
 *   - Name.server.luau  -> Script "Name"
 *   - Name.luau         -> ModuleScript "Name"
 *   - dir/init.luau     -> ModuleScript "dir" with the dir's files as children
 *   - dir/              -> Folder
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, "../studio-plugin/src");
const outDir = resolve(here, "../studio-plugin/dist");
const outFile = join(outDir, "RobloxStudioMCP.rbxmx");

let referentCounter = 0;
const nextReferent = () => `RBX${referentCounter++}`;

const escapeXml = (text) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n/g, "\n");

function itemXml(className, name, source, children, indent) {
  const pad = "  ".repeat(indent);
  const lines = [
    `${pad}<Item class="${className}" referent="${nextReferent()}">`,
    `${pad}  <Properties>`,
    `${pad}    <string name="Name">${escapeXml(name)}</string>`,
  ];
  if (source !== null) {
    lines.push(`${pad}    <ProtectedString name="Source">${escapeXml(source)}</ProtectedString>`);
  }
  lines.push(`${pad}  </Properties>`);
  for (const child of children) lines.push(child);
  lines.push(`${pad}</Item>`);
  return lines.join("\n");
}

function classify(fileName) {
  if (fileName.endsWith(".server.luau") || fileName.endsWith(".server.lua")) {
    return { className: "Script", name: fileName.replace(/\.server\.luau?$/, "") };
  }
  if (fileName.endsWith(".luau") || fileName.endsWith(".lua")) {
    return { className: "ModuleScript", name: fileName.replace(/\.luau?$/, "") };
  }
  return null;
}

function buildDir(dirPath, name, indent) {
  const entries = readdirSync(dirPath).sort();
  const children = [];
  let initSource = null;

  for (const entry of entries) {
    const entryPath = join(dirPath, entry);
    if (statSync(entryPath).isDirectory()) {
      children.push(buildDir(entryPath, entry, indent + 1));
      continue;
    }
    if (entry === "init.luau" || entry === "init.lua") {
      initSource = readFileSync(entryPath, "utf8");
      continue;
    }
    const info = classify(entry);
    if (!info) continue;
    const source = readFileSync(entryPath, "utf8");
    children.push(itemXml(info.className, info.name, source, [], indent + 1));
  }

  if (initSource !== null) {
    return itemXml("ModuleScript", name, initSource, children, indent);
  }
  return itemXml("Folder", name, null, children, indent);
}

const rootItem = buildDir(srcDir, "RobloxStudioMCP", 1);
const xml = `<roblox version="4">\n${rootItem}\n</roblox>\n`;

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, xml);
const stats = statSync(outFile);
console.log(`Built ${outFile} (${(stats.size / 1024).toFixed(1)} KiB)`);
