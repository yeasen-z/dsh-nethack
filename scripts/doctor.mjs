import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { repoRoot, runtimePath, sourcePath } from "./runtime-paths.mjs";

const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const manifestPath = path.join(runtimePath, "runtime-manifest.json");
const checks = [];
const add = (label, ok, detail) => checks.push({ label, ok, detail });

const expectedNode = packageJson.engines?.node ?? "unspecified";
add("Node.js", /^v20\./.test(process.version), `${process.version} (required: ${expectedNode}; diagnostic only, no version switch performed)`);
const expectedNpm = packageJson.packageManager?.split("@")[1] ?? "unspecified";
const actualNpm = exec("npm", ["--version"]);
add("npm", actualNpm.ok && actualNpm.value === expectedNpm, `${actualNpm.value ?? "not found"} (pinned: ${expectedNpm})`);
add("Runtime artifacts", existsSync(manifestPath), existsSync(manifestPath) ? manifestPath : "missing; run npm run bootstrap to fetch/build the pinned engine");
add("Upstream source", existsSync(path.join(sourcePath, ".git")), existsSync(path.join(sourcePath, ".git")) ? sourcePath : "not fetched at default NETHACK_SRC/.cache path");

let playwrightAvailable = false;
try {
  await import("playwright");
  playwrightAvailable = true;
} catch { /* This check must stay read-only; it never auto-installs packages. */ }
add("Playwright package", playwrightAvailable, playwrightAvailable ? "available" : "missing; install project dependencies before eval:real");

const browserPath = process.env.CHROMIUM_EXECUTABLE_PATH || findBrowser();
add("Chromium browser", Boolean(browserPath), browserPath ?? "not found in common locations; set CHROMIUM_EXECUTABLE_PATH");
const docker = exec("docker", ["--version"]);
const emsdk = Boolean(process.env.EMSDK);
add("WASM build tool", emsdk || docker.ok, emsdk ? `EMSDK=${process.env.EMSDK}` : docker.ok ? docker.value : "Docker not found and EMSDK is unset");

for (const check of checks) {
  console.log(`${check.ok ? "OK" : "WARN"} ${check.label}: ${check.detail}`);
}
console.log("\nDoctor is read-only: it does not install packages, switch runtimes, or modify configuration.");

function exec(command, args) {
  try {
    return { ok: true, value: execFileSync(command, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() };
  } catch {
    return { ok: false };
  }
}

function findBrowser() {
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    : process.platform === "win32"
      ? [path.join(process.env.PROGRAMFILES ?? "C:/Program Files", "Google/Chrome/Application/chrome.exe"), path.join(process.env["PROGRAMFILES(X86)"] ?? "C:/Program Files (x86)", "Google/Chrome/Application/chrome.exe")]
      : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
  return candidates.find(existsSync);
}
