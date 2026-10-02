import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { lockPath, repoRoot, runtimePath, sourcePath } from "./runtime-paths.mjs";

const lock = JSON.parse(await readFile(lockPath, "utf8"));
const buildMode = process.env.NETHACK_BUILD_MODE ?? (process.env.EMSDK ? "local" : "docker");
if (!new Set(["local", "docker"]).has(buildMode)) throw new Error("NETHACK_BUILD_MODE must be local or docker");
const hint = process.platform === "darwin" ? "macOS.501" : "linux.501";
const expected = lock.nethack.revision;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? repoRoot, stdio: "inherit", env: options.env ?? process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`);
}

const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: sourcePath, encoding: "utf8" });
if (head.status !== 0 || head.stdout.trim() !== expected) {
  throw new Error(`NetHack source must be checked out at ${expected}. Run npm run runtime:fetch first.`);
}

if (buildMode === "local") {
  const emsdk = process.env.EMSDK;
  if (!emsdk) throw new Error("Local build requires EMSDK to point to an activated emsdk checkout.");
  const script = 'source "$NHC_EMSDK/emsdk_env.sh" >/dev/null && sys/unix/setup.sh "sys/unix/hints/$NHC_HINT" && mkdir -p targets/wasm/wasm-data && make CROSS_TO_WASM=1 all';
  run("bash", ["-lc", script], {
    cwd: sourcePath,
    env: { ...process.env, NHC_EMSDK: emsdk, NHC_HINT: hint },
  });
} else {
  const image = `${lock.emsdk.dockerImage}@${lock.emsdk.dockerDigest}`;
  const inner = 'sys/unix/setup.sh sys/unix/hints/linux.501 && mkdir -p targets/wasm/wasm-data && make CROSS_TO_WASM=1 all';
  run("docker", ["run", "--rm", "-v", `${sourcePath}:/src`, "-w", "/src", image, "bash", "-lc", inner]);
}

const outputDir = path.join(sourcePath, "targets/wasm");
const artifactNames = ["nethack.js", "nethack.wasm"];
await mkdir(runtimePath, { recursive: true });
const artifacts = {};
for (const name of artifactNames) {
  const source = path.join(outputDir, name);
  const bytes = await readFile(source);
  await copyFile(source, path.join(runtimePath, name));
  artifacts[name] = {
    sizeBytes: (await stat(source)).size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

const wasm = await readFile(path.join(runtimePath, "nethack.wasm"));
if (!wasm.subarray(0, 4).equals(Buffer.from([0, 0x61, 0x73, 0x6d]))) throw new Error("Output is not a WebAssembly module");
const manifest = {
  schemaVersion: 1,
  engine: { repository: lock.nethack.repository, revision: expected },
  toolchain: { version: lock.emsdk.version, mode: buildMode, dockerDigest: buildMode === "docker" ? lock.emsdk.dockerDigest : null },
  artifacts,
};
await writeFile(path.join(runtimePath, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built ${artifactNames.join(" and ")} into ${path.relative(repoRoot, runtimePath)}`);
