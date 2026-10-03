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
- `npm test`, `npm run eval:real-node`, `npm run eval:real`, and `npm run runtime:serve`;
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
wait/move/open/pickup/respond. Initial inventory is copied from the read-only
menu and marked stale after inventory-change notifications. The previous
headless Chromium run passed 10
runtime checks for startup, observation stability, actions, stale/duplicate
rejection and epoch handoff; the browser suite now also asserts eight-way
movement controls, but those UI assertions are not yet rerun locally. Twelve
transport/adapter tests and three fetch regression checks pass.
An additional Node Worker integration test exercises startup prompts, stable
real observations, and a real wait action without browser automation.
The wait recipe sends NetHack's forced-rest sequence (`m.`), avoiding the
zero-turn response that can occur when a bare `.` is rejected as pointless.
The fake suite remains 26 passed, 0 failed, 2 skipped.

For the current local checkout, `npm run eval:real-node` was verified using
the already-built runtime. `npm run eval:real` was not rerun because the local
`playwright` package is absent; the read-only `npm run doctor` reports this
along with the Node/npm version mismatch. No dependency install, runtime
switch, or desktop-browser interaction was performed.

## Known limits / next work

The diagnostic now has a large glyph-character map on the left and a
Control/Inventory/Messages tab panel on the right. It runs the real NetHack
WASM engine but is still a prototype, not the upstream graphical tileset.
Current visibility and entities are unavailable; inventory refresh after later
mutations remains unverified; terrain is conservatively remembered and real
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
