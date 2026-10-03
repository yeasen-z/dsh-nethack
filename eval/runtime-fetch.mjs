import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, cp, readFile, rm } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { repoRoot } from "../scripts/runtime-paths.mjs";

const temp = await mkdtemp(path.join(os.tmpdir(), "nhchat-fetch-"));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
try {
  const upstream = path.join(temp, "upstream"), project = path.join(temp, "project");
  await mkdir(path.join(upstream, "sys/unix"), { recursive: true });
  await writeFile(path.join(upstream, "sys/unix/setup.sh"), "#!/bin/sh\nexit 0\n");
  git(upstream, "init"); git(upstream, "add", ".");
  git(upstream, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture");
  const pin = git(upstream, "rev-parse", "HEAD");
  await mkdir(path.join(project, "scripts"), { recursive: true });
  await mkdir(path.join(project, "vendor"));
  for (const file of ["fetch-runtime.mjs", "runtime-paths.mjs"]) await cp(path.join(repoRoot, "scripts", file), path.join(project, "scripts", file));
  await writeFile(path.join(project, "vendor/upstream-lock.json"), JSON.stringify({ nethack: { repository: upstream, revision: pin } }));
  const fetch = () => {
    const fixtureEnv = { ...process.env };
    delete fixtureEnv.NETHACK_SRC;
    const result = spawnSync(process.execPath, ["scripts/fetch-runtime.mjs"], { cwd: project, encoding: "utf8", env: fixtureEnv });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  fetch();
  const source = path.join(project, ".cache/upstream/nethack");
  assert.equal(git(source, "rev-parse", "HEAD"), pin);
  assert.equal(await readFile(path.join(source, "sys/unix/setup.sh"), "utf8"), "#!/bin/sh\nexit 0\n");
  console.log("PASS  RuntimeFetch/new-clone-at-remote-head-materializes-source");
  await writeFile(path.join(source, "sys/unix/setup.sh"), "local edit\n");
  fetch();
  assert.equal(await readFile(path.join(source, "sys/unix/setup.sh"), "utf8"), "local edit\n");
  console.log("PASS  RuntimeFetch/repeated-fetch-preserves-existing-files");
  // A directory inside another checkout must not cause Git operations to act
  // on its parent repository.
  const nested = path.join(upstream, "not-a-checkout");
  await mkdir(nested);
  const rejected = spawnSync(process.execPath, ["scripts/fetch-runtime.mjs"], { cwd: project, encoding: "utf8", env: { ...process.env, NETHACK_SRC: nested } });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /not a Git checkout/);
  assert.equal(git(upstream, "rev-parse", "HEAD"), pin);
  console.log("PASS  RuntimeFetch/nested-noncheckout-does-not-modify-parent");
} finally { await rm(temp, { recursive: true, force: true }); }
