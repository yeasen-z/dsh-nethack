# Current stage handoff

**Date:** 2026-10-03  
**Repository:** NetHack-Chat  
**Status:** Phase 3 initial real middleware slice implemented and tested; Phase 3 remains incomplete.

## What is in place

- Phase 0 groundwork and the implementation roadmap: `docs/real-runtime-implementation-plan.md`.
- A reproducibly pinned upstream NetHack + Emscripten runtime build, manifest,
  verification scripts, and setup notes: `vendor/upstream-lock.json`,
  `vendor/UPSTREAM.md`, `scripts/runtime-*.mjs`, and `docs/runtime-build.md`.
- A real browser Worker probe and its event/input protocol notes:
  `apps/web/public/runtime-probe.html`,
  `apps/web/public/runtime-probe.worker.js`, and `docs/runtime-worker.md`.
- `RealWasmAdapter`, `RuntimeWorkerClient`, and `ObservationBuilder`, wired to
  the existing `MiddlewareSession` in `runtime-adapter-smoke.html`.
- `npm test`, `npm run eval:real`, and `npm run runtime:serve`;
  behavior and limitations are documented in `docs/real-adapter.md`.
- Fetch regression fixes for new no-checkout clones and nested non-Git paths.

## Verified behavior

The pinned WASM runtime initializes in Chrome, enters the game, emits copied
shim events (including glyph/map callbacks, messages, menu data, and raw status
callbacks), pauses on the opening `--More--` page, accepts the tutorial choice,
and then waits at the actual `shim_nh_poskey` command boundary. A selectable
tutorial menu correctly returns its selected accelerator. A `PICK_NONE`
inventory menu is observed but does not block for host input. Worker-side
pointer helpers cover the upstream glue's missing 16-bit and pointer-string
cases; no C patch was needed for this probe.

The real middleware now decodes HP, maximum HP, turn, conditions, terrain and
position, publishes observations at stable boundaries, and executes typed
wait/move/open/pickup/respond. Headless Chromium passes 10 real checks for
startup, observation stability, actions, stale/duplicate rejection and epoch
handoff. Ten transport/adapter tests and three fetch regression checks pass.
The fake suite remains 25 passed, 0 failed, 2 skipped.

## Known limits / next work

The diagnostic is not a production game UI. Current visibility, entities and
inventory are incomplete; terrain is conservatively remembered and real
`walk_to` is blocked through `supports_navigation: false`. Dungeon identity
uses a conservative map generation. Complete those observation components and
real pickup/prompt/death scenarios before expanding to agent integration.
Persistence, robust quit/restart, commit reconciliation, cross-browser coverage
and a production UI remain outstanding. Transport failures require explicit
session recreation; inputs are never automatically replayed.

## Local verification / cleanup

```sh
node --check apps/web/public/runtime-probe.worker.js
npm run runtime:verify
npm run typecheck
npm test
npm run eval:fake
npm run eval:real
npm run runtime:serve
```

The built runtime under `apps/web/public/runtime/` is ignored and can be
recreated with `npm run runtime:build`. Avoid routine `npm run clean` during
environment setup; it can delete tracked generated files in older checkouts.
