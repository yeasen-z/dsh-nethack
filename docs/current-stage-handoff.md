# Current stage handoff

**Date:** 2026-10-03  
**Repository:** NetHack-Chat  
**Status:** Phase 2 complete as a browser Worker probe; stop here before Phase 3.

## What is in place

- Phase 0 groundwork and the implementation roadmap: `docs/real-runtime-implementation-plan.md`.
- A reproducibly pinned upstream NetHack + Emscripten runtime build, manifest,
  verification scripts, and setup notes: `vendor/upstream-lock.json`,
  `vendor/UPSTREAM.md`, `scripts/runtime-*.mjs`, and `docs/runtime-build.md`.
- A real browser Worker probe and its event/input protocol notes:
  `apps/web/public/runtime-probe.html`,
  `apps/web/public/runtime-probe.worker.js`, and `docs/runtime-worker.md`.

## Verified behavior

The pinned WASM runtime initializes in Chrome, enters the game, emits copied
shim events (including glyph/map callbacks, messages, menu data, and raw status
callbacks), pauses on the opening `--More--` page, accepts the tutorial choice,
and then waits at the actual `shim_nh_poskey` command boundary. A selectable
tutorial menu correctly returns its selected accelerator. A `PICK_NONE`
inventory menu is observed but does not block for host input. Worker-side
pointer helpers cover the upstream glue's missing 16-bit and pointer-string
cases; no C patch was needed for this probe.

## Known limits / next work

This is deliberately not the production middleware or game UI. The next
planned phase is Phase 3 in the roadmap: implement `RuntimeWorkerClient` and
`ObservationBuilder`, decode status fields, map glyphs to terrain/entities,
model prompts, and implement the MVP action recipes behind the existing
session/scheduler boundary. Then add adapter contract tests before expanding
to agent integration.

The probe currently reports status callback pointer/value data without
decoding it, logs glyphs rather than rendering a polished map, and is not yet
integrated with the agent loop. Persistence, robust quit/restart, recovery,
cross-browser coverage, and a production UI remain out of scope for this stage.

## Local verification / cleanup

```sh
node --check apps/web/public/runtime-probe.worker.js
npm run runtime:verify
npm run typecheck
npm run clean
```

The last command removes generated build outputs; tracked generated files may
therefore appear as deletions in the working tree. The built runtime under
`apps/web/public/runtime/` is ignored and can be recreated with
`npm run runtime:build`.
