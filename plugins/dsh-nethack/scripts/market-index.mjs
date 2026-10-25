#!/usr/bin/env node
// Regenerate `market/index.json` from git, so the published index cannot drift
// from the code it points at.
//
// A market entry is a claim about ONE commit: the installer pins that SHA and
// never follows the branch. Hand-editing the file is therefore how a stale SHA,
// a stale version or a stale compatibility range gets published. Run this after
// merging what you intend to publish, then commit the regenerated file.
//
// The version listed is this bundle's own `package.json` version and the commit
// is HEAD, so the workflow is: bump the version, commit, run this, commit the
// index. `--print-install` prints the install target a market user would get,
// which is the quickest way to check that the pinned commit is the intended one.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const bundleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// `GIT_WORK_TREE` lets the tests run this generator over an extracted commit.
const repoRoot = process.env.GIT_WORK_TREE ? path.resolve(process.env.GIT_WORK_TREE) : path.resolve(bundleDir, "../..");
const indexPath = path.join(bundleDir, "market/index.json");
const packagePath = path.join(bundleDir, "package.json");

const git = (...args) => execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();

// With `GIT_WORK_TREE` set (tests regenerate HEAD's own copy) HEAD names the
// commit whose bundle is extracted, which is the commit the user is publishing.
// Without it, HEAD is simply the current commit.

const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const commit = git("rev-parse", "HEAD");
const committedAt = Number(git("log", "-1", "--format=%ct", "HEAD"));
const branchBehind = (() => {
  try {
    return git("rev-list", "--count", `HEAD..origin/main`);
  } catch {
    return "unknown";
  }
})();

const repositoryUrl = "https://github.com/yeasen-z/dsh-nethack-chatplay";
const engines = manifest.engines?.dsh;
if (!engines) throw new Error("package.json must declare engines.dsh: the market cannot state compatibility without it");

const current = JSON.parse(fs.readFileSync(indexPath, "utf8"));
const previous = current.plugins?.find((entry) => entry.name === manifest.name);
const iconPath = path.join(bundleDir, "icon.svg");
const icon = `data:image/svg+xml;base64,${fs.readFileSync(iconPath).toString("base64")}`;

const version = {
  version: manifest.version,
  publishTimestamp: committedAt,
  source: { type: "git", url: repositoryUrl, commit, path: "plugins/dsh-nethack" },
  engines: { dsh: engines },
};

// One entry per version, newest kept first by the reader itself. Keeping the old
// ones lets someone install a version they already run instead of being forced
// onto HEAD.
const keptVersions = (previous?.versions ?? []).filter((entry) => entry.version !== version.version);
const plugin = {
  ...previous,
  name: manifest.name,
  title: previous?.title ?? { en: "NetHack", zh: "NetHack 地牢" },
  description: previous?.description ?? {
    en: "Play NetHack inside DSH: the real NetHack 3.6.7 WASM engine in a panel, driven by you with the arrow pad or by the model through three isolated game tools.",
    zh: "在 DSH 里玩真正的 NetHack：面板里是 NetHack 3.6.7 WASM 引擎，你可以用方向键盘玩，也可以让模型通过三个隔离的游戏工具替你玩。",
  },
  icon,
  author: previous?.author ?? "yeasen-z",
  homepage: repositoryUrl,
  repository: { url: repositoryUrl, directory: "plugins/dsh-nethack" },
  metadata: {
    ...(previous?.metadata ?? { category: "games", keywords: ["nethack", "roguelike", "game", "wasm", "agent"], labels: ["nethack", "agent-play"] }),
    sortKeys: { added: committedAt },
  },
  versions: [version, ...keptVersions],
};

const next = { ...current, plugins: [plugin, ...(current.plugins ?? []).filter((entry) => entry.name !== manifest.name)] };
fs.writeFileSync(indexPath, `${JSON.stringify(next, null, 2)}\n`);

const spec = `git+${repositoryUrl}.git#${commit}&path:/plugins/dsh-nethack`;
console.log(`index.json: ${manifest.name}@${manifest.version}`);
console.log(`  commit:  ${commit} (${new Date(committedAt * 1000).toISOString()})`);
console.log(`  engines: ${engines}`);
console.log(`  install: ${spec}`);
if (branchBehind !== "unknown" && Number(branchBehind) > 0) {
  console.log(`  WARNING: main is ${branchBehind} commit(s) ahead of origin/main — the pinned commit is not published yet.`);
}
if (process.argv.includes("--print-install")) console.log(spec);
