import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { lockPath, runtimePath } from "./runtime-paths.mjs";

const lock = JSON.parse(await readFile(lockPath, "utf8"));
const manifest = JSON.parse(await readFile(path.join(runtimePath, "runtime-manifest.json"), "utf8"));
if (manifest.schemaVersion !== 1) throw new Error("Unsupported runtime manifest schema");
if (manifest.engine?.revision !== lock.nethack.revision) throw new Error("Runtime engine revision does not match vendor/upstream-lock.json");
for (const name of ["nethack.js", "nethack.wasm"]) {
  const filename = path.join(runtimePath, name);
  const bytes = await readFile(filename);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (manifest.artifacts?.[name]?.sha256 !== hash) throw new Error(`${name} SHA-256 does not match runtime-manifest.json`);
  if (manifest.artifacts[name].sizeBytes !== (await stat(filename)).size) throw new Error(`${name} size does not match runtime-manifest.json`);
  if (bytes.length === 0) throw new Error(`${name} is empty`);
}
const wasm = await readFile(path.join(runtimePath, "nethack.wasm"));
if (!wasm.subarray(0, 4).equals(Buffer.from([0, 0x61, 0x73, 0x6d]))) throw new Error("nethack.wasm has invalid WebAssembly magic bytes");
const loader = await readFile(path.join(runtimePath, "nethack.js"), "utf8");
if (!loader.includes("shim_graphics_set_callback") || !loader.includes("nethack.wasm")) {
  throw new Error("Emscripten loader is missing expected NetHack exports or WASM reference");
}
const { default: createModule } = await import(pathToFileURL(path.join(runtimePath, "nethack.js")));
const module = await createModule({ noInitialRun: true, print: () => {}, printErr: () => {} });
if (typeof module._main !== "function" || typeof module._shim_graphics_set_callback !== "function") {
  throw new Error("NetHack WASM module did not expose the expected game and shim entry points");
}
for (const dataFile of ["/nhdat", "/license"]) {
  if (!module.FS.analyzePath(dataFile).exists) throw new Error(`Embedded upstream game data is missing: ${dataFile}`);
}
console.log(`Runtime artifacts verified and initialized (${manifest.engine.revision}, ${manifest.toolchain.version}).`);
