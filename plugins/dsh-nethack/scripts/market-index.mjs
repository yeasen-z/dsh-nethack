#!/usr/bin/env node
// Commit the release code first, then generate and commit its index separately.
// An index pins release code; it does not need to contain its own commit hash.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryUrl = "https://github.com/yeasen-z/dsh-nethack";
const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

// This is a local tracking-ref check, NOT proof of live remote accessibility.
export function publicationStatus(repo, commit) {
  const result = spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", commit, "origin/main"], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status === 0) return "reachable";
  if (result.status === 1) return "unpublished";
  return "unknown";
}

export function buildMarketIndex({ current, manifest, icon, commit, timestamp }) {
  if (!manifest.engines?.dsh) throw new Error("package.json must declare engines.dsh");
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("release commit must be a full SHA");
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error("invalid release timestamp");
  const previous = current.plugins?.find((entry) => entry.name === manifest.name);
  const version = {
    version: manifest.version,
    publishTimestamp: timestamp,
    source: { type: "git", url: repositoryUrl, commit, path: "plugins/dsh-nethack" },
    engines: { dsh: manifest.engines.dsh },
  };
  const plugin = {
    ...previous,
    name: manifest.name,
    title: previous?.title ?? { en: "NetHack", zh: "NetHack 地牢" },
    description: previous?.description ?? {
      en: "Play NetHack inside DSH with manual controls and an isolated game conversation.",
      zh: "在 DSH 里通过手动操作或独立游戏对话玩 NetHack。",
    },
    icon,
    author: previous?.author ?? "yeasen-z",
    homepage: repositoryUrl,
    repository: { url: repositoryUrl, directory: "plugins/dsh-nethack" },
    metadata: {
      ...(previous?.metadata ?? { category: "games", keywords: ["nethack", "roguelike", "game", "wasm", "agent"], labels: ["nethack", "agent-play"] }),
      sortKeys: { ...previous?.metadata?.sortKeys, added: previous?.metadata?.sortKeys?.added ?? timestamp },
    },
    versions: [version, ...(previous?.versions ?? []).filter((entry) => entry.version !== version.version)],
  };
  return { ...current, plugins: [plugin, ...(current.plugins ?? []).filter((entry) => entry.name !== manifest.name)] };
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--print-install")) throw new Error("usage: node scripts/market-index.mjs [--print-install]");
  const bundleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const repo = path.resolve(bundleDir, "../..");
  const indexPath = path.join(bundleDir, "market/index.json");
  // Ignore the index itself: it is the output, committed AFTER the release code.
  const dirty = git(repo, "status", "--porcelain", "--", "plugins/dsh-nethack", ":(exclude)plugins/dsh-nethack/market/index.json");
  if (dirty) throw new Error("Commit bundle changes before generating a release index; HEAD must contain the published code.");
  const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, "package.json"), "utf8"));
  const commit = git(repo, "rev-parse", "HEAD");
  const timestamp = Number(git(repo, "log", "-1", "--format=%ct", commit));
  const current = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const icon = `data:image/svg+xml;base64,${fs.readFileSync(path.join(bundleDir, "icon.svg")).toString("base64")}`;
  const next = buildMarketIndex({ current, manifest, icon, commit, timestamp });
  fs.writeFileSync(indexPath, `${JSON.stringify(next, null, 2)}\n`);
  const spec = `git+${repositoryUrl}.git#${commit}&path:/plugins/dsh-nethack`;
  console.log(`index.json: ${manifest.name}@${manifest.version}\n  commit: ${commit}\n  install: ${spec}`);
  const status = publicationStatus(repo, commit);
  if (status === "unpublished") console.warn("WARNING: release commit is not reachable from local origin/main; push release code before publishing the index.");
  if (status === "unknown") console.warn("WARNING: cannot check origin/main (missing ref or incomplete history); publication status is unknown.");
  if (status === "reachable") console.log("  release is reachable from local origin/main (tracking snapshot only; not a network check).");
  if (args.includes("--print-install")) console.log(spec);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
