import { rm } from "node:fs/promises";

const generatedPaths = [
  "dist",
  "eval/dist-harness",
  "packages/core/dist",
  "packages/adapter-wasm/dist",
  "packages/skills/dist",
  "packages/agent/dist",
  "apps/web/dist",
  "apps/model-gateway/dist",
  "packages/core/tsconfig.tsbuildinfo",
  "packages/adapter-wasm/tsconfig.tsbuildinfo",
  "packages/skills/tsconfig.tsbuildinfo",
  "packages/agent/tsconfig.tsbuildinfo",
  "apps/web/tsconfig.tsbuildinfo",
  "apps/model-gateway/tsconfig.tsbuildinfo",
];

await Promise.all(generatedPaths.map((path) => rm(path, { recursive: true, force: true })));
