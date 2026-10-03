import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { lockPath, repoRoot, sourcePath } from "./runtime-paths.mjs";

const lock = JSON.parse(await readFile(lockPath, "utf8"));
const expected = lock.nethack.revision;
const externalSource = Boolean(process.env.NETHACK_SRC);
let clonedWithoutCheckout = false;

function git(args) {
  const result = spawnSync("git", args, { cwd: sourcePath, encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]} failed with exit code ${result.status}`);
}

const initialGitCheck = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: sourcePath, encoding: "utf8" });
const isSourceCheckout = initialGitCheck.status === 0
  && realpathSync(initialGitCheck.stdout.trim()) === realpathSync(sourcePath);
if (!isSourceCheckout) {
  if (externalSource) throw new Error(`NETHACK_SRC is not a Git checkout: ${sourcePath}`);
  if (existsSync(sourcePath)) throw new Error(`Refusing to clone over an existing non-Git path: ${sourcePath}`);
  await mkdir(path.dirname(sourcePath), { recursive: true });
  const cloned = spawnSync("git", ["clone", "--no-checkout", lock.nethack.repository, sourcePath], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (cloned.error) throw cloned.error;
  if (cloned.status !== 0) throw new Error(`git clone failed with exit code ${cloned.status}`);
  clonedWithoutCheckout = true;
}

const headResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: sourcePath, encoding: "utf8" });
if (headResult.status !== 0) throw new Error(`Cannot read Git HEAD in ${sourcePath}`);
const head = headResult.stdout.trim();
if (head !== expected) {
  if (externalSource) {
    throw new Error(`NETHACK_SRC is at ${head}; expected pinned revision ${expected}. No files were changed.`);
  }
  git(["fetch", "--depth", "1", "origin", expected]);
}
// --no-checkout needs materialization even when origin HEAD equals the pin.
// Existing same-revision checkouts are left untouched.
if (clonedWithoutCheckout || head !== expected) git(["checkout", "--detach", expected]);
if (!existsSync(path.join(sourcePath, "sys/unix/setup.sh"))) {
  throw new Error("Pinned NetHack checkout is missing sys/unix/setup.sh; refusing to overwrite existing local files.");
}

if (externalSource) {
  const submodules = spawnSync("git", ["submodule", "status", "--recursive"], { cwd: sourcePath, encoding: "utf8" });
  if (submodules.status !== 0 || /^[-+U]/m.test(submodules.stdout)) {
    throw new Error("NETHACK_SRC has missing or mismatched submodules. Initialize them in that checkout before building.");
  }
} else {
  git(["submodule", "update", "--init", "--recursive", "--depth", "1"]);
}
const checked = spawnSync("git", ["rev-parse", "HEAD"], { cwd: sourcePath, encoding: "utf8" });
if (checked.status !== 0 || checked.stdout.trim() !== expected) throw new Error("Pinned NetHack revision verification failed");
console.log(`NetHack source ready at ${expected}: ${sourcePath}`);
