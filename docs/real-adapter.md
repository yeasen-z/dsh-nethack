# Initial real middleware integration

Phase 3 now has a real vertical slice:

```text
diagnostic page -> MiddlewareSession -> RealWasmAdapter
    -> RuntimeWorkerClient -> browser Worker -> pinned NetHack WASM
```

The existing fake demo remains separate. No production chat UI or real
navigation skill is claimed by this milestone.

## Run and validate

Use the pinned Node/npm versions, install with `npm ci`, and build the runtime
with `npm run bootstrap` (Docker or local Emscripten as in `runtime-build.md`).
Then run:

```sh
npm test
npm run eval:fake
npm run eval:real
npm run runtime:serve
```

`runtime:serve` binds to loopback port 4173; its root redirects to the real
middleware diagnostic. It serves only the public assets and compiled core and
adapter modules. The adapter page cannot run when only `apps/web/public` is
served: it also needs the compiled workspace modules. The original standalone
probe and module smoke page can still use the public-only server.

`eval:real` verifies artifact hashes and initialization, starts its own server
on an unused loopback port, and launches headless Chromium. It uses
`CHROMIUM_EXECUTABLE_PATH` if provided, otherwise `/usr/bin/chromium` when
available, otherwise Playwright's installed browser. Use
`npx playwright install chromium` if no browser is available. Missing browsers
or artifacts fail the check; they are not converted into passing skips.

At this milestone, `npm test` passes 10 adapter/transport tests and 3 local-Git
fetch regression checks; `eval:real` passes 10 actual browser checks; the
existing fake suite passes 25 with its 2 real-runtime-related skips. The real
suite validates startup, observation stability, wait, move, direction prompt
handling, pickup delivery, deduplication, stale state and prompt rejection, and
takeover epoch rejection. It does not cover all item/menu/game-over scenarios,
in-flight skill interruption, save/load, or multiple browsers.

## Stable observations

The Worker copies status strings and the condition mask inside the shim
callback. The adapter never dereferences a pointer from another execution
context. HP, maximum HP, displayed dungeon label, turn and conditions are
decoded from the pinned upstream `botl.h`/`botl.c` protocol. Runtime environment
options must be injected in Emscripten `preRun`, before its environment cache
is created. `number_pad:1,time` enables keypad action recipes and the visible
turn field.

Map terrain comes from `glyph_info.gm.sym.symidx` and pinned `defsym.h`
indices, not ambiguous screen characters. Unknown, unexplored, and invalid
cells are not fabricated. Position comes from the map-window cursor callback.
Background glyphs are ignored: upstream can derive them from current engine
terrain rather than the player's remembered terrain. An entity overlay retains
previously observed terrain, or leaves it unknown.
Callbacks accumulate privately; an explicit blocking shim input or engine
exit publishes a new snapshot. Repeated reads clone the last snapshot and
never ask the engine to advance.

Windowport redraws include remembered map cells and do not reliably indicate
current line of sight. This version labels known terrain `remembered`, exports
empty `entities` and `inventory`, and sets `supports_navigation: false`.
`walk_to` refuses that capability before issuing input. Empty arrays here
mean these observation components are not implemented, not that the game has
no monsters or inventory. Unknown HP remains null.

Displayed dungeon labels are not durable level identifiers. `level_id` also
includes a map generation; clearing the map resets known cells and starts a
new coordinate namespace. A same-level redraw can conservatively change that
namespace. Reliable dungeon identity and visibility are still required before
real navigation or save/load integration.

## Input handling

Only `shim_nh_poskey` is a command boundary. `shim_nhgetch` and unrecognized
free-key questions are surfaced as unsupported text prompts. Direction prompts
use the pinned `getdir` question through `yn_function`; matching its English
question is an explicit compatibility limit, not a general prompt detector.
More, menu and yes/no prompts use their callback types.

Each action commits at most one input, then waits for the next boundary.
`open` sends `o` and surfaces a direction prompt; it does not automatically
send the direction in the original action. A subsequent typed `respond` must
match the current prompt ID. Menu responses validate option IDs and single vs
multiple selection, and use explicit indices to avoid numeric accelerator
aliases. Unknown prompts always stop automatic continuation. Human text entry
is not yet available through the current core response contract.

Prompt IDs include a fresh adapter generation, so recreating a Worker with the
same session ID cannot accept responses from an earlier game. Concurrent
deliveries are rejected. Worker errors and boundary timeouts poison the
transport: a potentially committed input is never retried, late events are
ignored, and callers must explicitly terminate and create a new session.
This is fail-stop behavior, not automatic recovery or commit reconciliation.

## Remaining Phase 3 work

- Establish authoritative player-visible visibility and current entity data.
- Complete inventory snapshots and stable dungeon identity.
- Cover multi-item pickup, all prompt types, death and unexpected engine exits
  against controlled real scenarios.
- Extend the existing core contract for human text entry and proper recovery.
- Reuse adapter tests across fake and real transports; then validate real
  navigation, in-flight Stop/Take Over, and production UI integration.
