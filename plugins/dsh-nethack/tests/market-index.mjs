// Run from a full source checkout, not the installed npm artifact.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildMarketIndex, publicationStatus } from "../scripts/market-index.mjs";

const require = createRequire(import.meta.url);
const bundleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(bundleDir, "../..");
const index = JSON.parse(fs.readFileSync(path.join(bundleDir, "market/index.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, "package.json"), "utf8"));
const entry = index.plugins.find((plugin) => plugin.name === manifest.name);
const version = entry?.versions.find((candidate) => candidate.version === manifest.version);
const git = (...args) => execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();

function findValidator() {
  // An explicit override must work or fail, never silently fall back.
  if (process.env.DSH_MARKET_VALIDATOR) return require(path.resolve(process.env.DSH_MARKET_VALIDATOR));
  try {
    return require("@deepseek-ai/dsh-plugin-market-index");
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    return null;
  }
}

test("the index format and current package metadata agree", () => {
  assert.equal(index.format, 1);
  assert.ok(index.title?.en);
  assert.ok(entry, `index must list ${manifest.name}`);
  assert.ok(version, `index must list ${manifest.version}`);
  assert.equal(version.engines?.dsh, manifest.engines?.dsh);
  assert.equal(entry.repository?.directory, "plugins/dsh-nethack");
  assert.equal(version.source.type, "git");
  assert.equal(version.source.path, "plugins/dsh-nethack");
  assert.equal(version.source.url, "https://github.com/yeasen-z/dsh-nethack");
});

test("every release pins a real commit, matching timestamp and manifest", () => {
  for (const release of entry.versions) {
    assert.match(release.source.commit, /^[0-9a-f]{40}$/);
    git("cat-file", "-e", `${release.source.commit}^{commit}`);
    assert.equal(release.publishTimestamp, Number(git("log", "-1", "--format=%ct", release.source.commit)));
    const pinned = JSON.parse(git("show", `${release.source.commit}:plugins/dsh-nethack/package.json`));
    assert.equal(pinned.name, manifest.name);
    assert.equal(pinned.version, release.version);
    assert.equal(pinned.engines.dsh, release.engines.dsh);
  }
});

test("current files reproduce the COMPLETE index using its pinned release", () => {
  const icon = `data:image/svg+xml;base64,${fs.readFileSync(path.join(bundleDir, "icon.svg")).toString("base64")}`;
  const generated = buildMarketIndex({
    current: index, manifest, icon,
    commit: version.source.commit, timestamp: version.publishTimestamp,
  });
  // No ignored fields, no HEAD archive: edits to the working manifest/icon and
  // generator participate, while the release SHA stays independent of HEAD.
  assert.deepEqual(generated, index);
});

test("generator preserves history and added date when publishing a new version", () => {
  const generated = buildMarketIndex({
    current: index, manifest: { ...manifest, version: "99.0.0" }, icon: entry.icon,
    commit: "a".repeat(40), timestamp: version.publishTimestamp + 100,
  });
  const plugin = generated.plugins.find((plugin) => plugin.name === manifest.name);
  assert.deepEqual(plugin.versions.slice(1), entry.versions);
  assert.equal(plugin.metadata.sortKeys.added, entry.metadata.sortKeys.added);
  assert.equal(plugin.versions[0].version, "99.0.0");
});

test("DSH parser accepts the index and derives the install target", (t) => {
  const validator = findValidator();
  if (!validator) {
    const message = "DSH parser not installed; set DSH_MARKET_VALIDATOR to its module file for release validation";
    if (process.env.DSH_REQUIRE_MARKET_VALIDATOR === "1") assert.fail(message);
    t.skip(message);
    return;
  }
  const { parseMarketIndex, marketInstallTarget } = validator;
  assert.equal(typeof parseMarketIndex, "function");
  assert.equal(typeof marketInstallTarget, "function");
  const parsed = parseMarketIndex(index, "https://raw.githubusercontent.com/yeasen-z/dsh-nethack/main/plugins/dsh-nethack/market/index.json");
  const plugin = parsed.plugins.find((plugin) => plugin.name === manifest.name);
  const release = plugin.versions.find((release) => release.version === manifest.version);
  assert.equal(marketInstallTarget(plugin.name, release).spec,
    `git+https://github.com/yeasen-z/dsh-nethack.git#${version.source.commit}&path:/plugins/dsh-nethack`);
});

test("publication check distinguishes ahead, behind, diverged and missing tracking refs", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nethack-publication-"));
  // Only remove the exact temporary directory just created by this test.
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const run = (...args) => execFileSync("git", ["-C", tmp, ...args], { encoding: "utf8", env: {
    ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
  } }).trim();
  run("init", "-q");
  run("-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "base");
  const base = run("rev-parse", "HEAD");
  assert.equal(publicationStatus(tmp, base), "unknown");
  run("update-ref", "refs/remotes/origin/main", base);
  assert.equal(publicationStatus(tmp, base), "reachable");
  run("-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "local");
  const local = run("rev-parse", "HEAD");
  assert.equal(publicationStatus(tmp, local), "unpublished"); // ahead
  run("update-ref", "refs/remotes/origin/main", local);
  assert.equal(publicationStatus(tmp, base), "reachable"); // behind but already published
  run("checkout", "-q", "--detach", base);
  run("-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "divergent");
  assert.equal(publicationStatus(tmp, run("rev-parse", "HEAD")), "unpublished");
});

test("CLI refuses uncommitted bundle code before writing an index", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nethack-dirty-release-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const fixture = path.join(tmp, "plugins/dsh-nethack");
  fs.mkdirSync(path.join(fixture, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "market"));
  for (const file of ["scripts/market-index.mjs", "package.json", "icon.svg", "market/index.json"]) {
    fs.copyFileSync(path.join(bundleDir, file), path.join(fixture, file));
  }
  const run = (...args) => execFileSync("git", ["-C", tmp, ...args], { stdio: "pipe" });
  run("init", "-q");
  run("add", ".");
  run("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  fs.appendFileSync(path.join(fixture, "package.json"), "\n");
  const before = fs.readFileSync(path.join(fixture, "market/index.json"), "utf8");
  assert.throws(() => execFileSync(process.execPath, [path.join(fixture, "scripts/market-index.mjs")], { stdio: "pipe" }),
    (error) => /Commit bundle changes before generating/.test(String(error.stderr)));
  assert.equal(fs.readFileSync(path.join(fixture, "market/index.json"), "utf8"), before);
});
