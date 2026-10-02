import { fileURLToPath } from "node:url";
import path from "node:path";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const lockPath = path.join(repoRoot, "vendor/upstream-lock.json");
export const sourcePath = path.resolve(process.env.NETHACK_SRC ?? path.join(repoRoot, ".cache/upstream/nethack"));
export const runtimePath = path.join(repoRoot, "apps/web/public/runtime");

