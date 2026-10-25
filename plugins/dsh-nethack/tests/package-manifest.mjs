// Run: node --test plugins/dsh-nethack/tests/package-manifest.mjs
// Whether OTHER people can install this bundle is decided by its manifest, not
// by the code: DSH checks `engines.dsh` before installing, a registry refuses a
// private package, and `files` decides what actually ships. Those are easy to
// drop in an unrelated edit, so they are pinned here.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const manifest = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test("the bundle is publishable and installable", () => {
  assert.equal(manifest.name, "dsh-nethack");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  // "private": true makes npm refuse the publish outright.
  assert.notEqual(manifest.private, true);
  assert.ok(manifest.license, "a registry package needs a license");
  assert.ok(manifest.repository?.url, "provenance matters for a bundle that runs Host code");
  assert.ok(manifest.description);
});

test("the DSH compatibility range is declared and parses", () => {
  const range = manifest.engines?.dsh;
  assert.ok(range, "engines.dsh is how DSH refuses an incompatible Host");
  assert.doesNotMatch(range, /workspace:/);
  assert.match(range, /^[>=<~^*0-9]/);
});

test("the bundle fields DSH reads are present", () => {
  assert.equal(manifest.type, "module");
  assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
  assert.ok(manifest.dsh?.client, "the panel is a client entry");
  for (const entry of [".", "./client"]) assert.ok(manifest.exports?.[entry], `exports ${entry}`);
});

test("files ships the code, the patch and the docs, and nothing else", () => {
  const files = manifest.files ?? [];
  for (const needed of ["cordis.patch.yml", "lib/client.js", "README.md", "icon.svg"]) {
    assert.ok(files.includes(needed), `files must ship ${needed}`);
  }
  // The engine is a dependency, not a vendored bundle: shipping it again would
  // double the tarball and split the license story.
  assert.ok(!files.some((f) => f.startsWith("engine")), "the WASM engine is not vendored");
  assert.ok(manifest.dependencies?.["@neth4ck/wasm-367"], "the engine is a pinned dependency");
});
