// Run: node --test plugins/dsh-nethack/tests/market-index.mjs
//
// A market index is only useful if DSH's own reader accepts it, so this test
// validates `market/index.json` with `@deepseek-ai/dsh-plugin-market-index`
// when that package is reachable (it ships inside the DSH app), and otherwise
// falls back to the rules this repository can check on its own. The fallback is
// not a substitute: it is what keeps the test meaningful on a machine without
// DSH installed, and it says so.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const bundleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexText = fs.readFileSync(path.join(bundleDir, "market/index.json"), "utf8");
const index = JSON.parse(indexText);
const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, "package.json"), "utf8"));

/** The market validator, wherever DSH happens to be installed on this machine. */
function findValidator() {
  try {
    return require("@deepseek-ai/dsh-plugin-market-index");
  } catch {
    /* not resolvable from here; try the app bundle below */
  }
  const candidates = [
    "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js",
  ];
  for (const candidate of candidates) {
    try {
      return createRequire(candidate)(candidate.replace(/\/lib\/index\.js$/, ""));
    } catch {
      /* keep looking */
    }
  }
  return null;
}

test("the index has the format the reader requires", () => {
  assert.equal(index.format, 1);
  assert.ok(index.title?.en, "a localized title with en is required");
  assert.ok(Array.isArray(index.plugins) && index.plugins.length > 0);
});

test("our plugin's entry matches this package", () => {
  const entry = index.plugins.find((plugin) => plugin.name === manifest.name);
  assert.ok(entry, `index must list ${manifest.name}`);
  const version = entry.versions.find((candidate) => candidate.version === manifest.version);
  assert.ok(version, `index must list version ${manifest.version} from package.json`);
  assert.equal(version.engines?.dsh, manifest.engines?.dsh, "the market range must equal the manifest's engines.dsh");
  assert.equal(entry.repository?.directory, "plugins/dsh-nethack");
  assert.match(version.source?.commit ?? "", /^[0-9a-f]{40}$/, "a git version pins a full commit, never a branch");
});

test("a git version installs the bundle subdirectory, not the repository root", () => {
  const entry = index.plugins.find((plugin) => plugin.name === manifest.name);
  for (const version of entry.versions) {
    if (version.source?.type !== "git") continue;
    assert.equal(version.source.path, "plugins/dsh-nethack");
    assert.ok(version.source.url.endsWith("/dsh-nethack-chatplay"), "url is the repository, canonical and without .git");
    assert.ok(!version.source.url.endsWith(".git"), "the validator requires the canonical repository URL");
  }
});

test("the pinned commit exists in this repository", () => {
  const entry = index.plugins.find((plugin) => plugin.name === manifest.name);
  const repoRoot = path.resolve(bundleDir, "../..");
  for (const version of entry.versions) {
    if (version.source?.type !== "git") continue;
    // Throws when the SHA is unknown here; a published index must point at a
    // commit that exists, or installation fails at fetch time.
    execFileSync("git", ["-C", repoRoot, "cat-file", "-e", `${version.source.commit}^{commit}`], { stdio: "ignore" });
  }
});

test("DSH's own parser accepts the index and derives the documented install target", (t) => {
  const validator = findValidator();
  if (!validator) {
    t.diagnostic("DSH market validator not found; structural checks above still ran");
    return;
  }
  const { parseMarketIndex, marketInstallTarget } = validator;
  const parsed = parseMarketIndex(index, "https://raw.githubusercontent.com/yeasen-z/dsh-nethack-chatplay/main/plugins/dsh-nethack/market/index.json");
  const plugin = parsed.plugins.find((candidate) => candidate.name === manifest.name);
  const version = plugin.versions.find((candidate) => candidate.version === manifest.version);
  const { spec } = marketInstallTarget(plugin.name, version);
  assert.equal(
    spec,
    `git+https://github.com/yeasen-z/dsh-nethack-chatplay.git#${version.source.commit}&path:/plugins/dsh-nethack`,
  );
});

test("the committed index matches what the generator produces from its own commit", (t) => {
  // A market entry pins the commit that contains it, which no file can do: the
  // entry is written after that commit exists and shipped by the next one. So
  // this compares the file against the generator run INSIDE HEAD's tree, not
  // against the working tree: on a clean checkout every release-pin commit then
  // agrees with itself, and the earlier check that always ran red is gone.
  const repoRoot = path.resolve(bundleDir, "../..");
  const git = (...args) => execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 1 << 24 });
  const committedIndex = git("show", "HEAD:plugins/dsh-nethack/market/index.json");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-nethack-index-"));
  try {
    // HEAD's bundle, extracted so the generator reads HEAD's package.json and icon.
    git("archive", "--format=tar", "HEAD", "plugins/dsh-nethack", "-o", path.join(tmp, "head.tar"));
    execFileSync("tar", ["-xf", path.join(tmp, "head.tar"), "-C", tmp]);
    // The extraction is not a git checkout, so git has to look at THIS
    // repository for HEAD, its timestamp and the branch state.
    const gitEnv = {
      ...process.env,
      GIT_DIR: path.resolve(repoRoot, git("rev-parse", "--absolute-git-dir").split("\n")[0].trim()),
      GIT_WORK_TREE: tmp,
    };
    const generated = execFileSync(process.execPath, [path.join(tmp, "plugins/dsh-nethack/scripts/market-index.mjs")], { encoding: "utf8", env: gitEnv });
    const produced = fs.readFileSync(path.join(tmp, "plugins/dsh-nethack/market/index.json"), "utf8");
    if (produced !== committedIndex) {
      t.diagnostic(generated);
    }
    assert.equal(produced, committedIndex, "regenerate the index inside the release commit");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
