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
npm run eval:real-node
npm run eval:real
npm run runtime:serve
```

`eval:real-node` runs the actual pinned WASM Worker through
`MiddlewareSession` using Node's built-in `worker_threads`; it needs the built
runtime but not Playwright or a desktop browser. It checks startup prompt
handling, decoded status/map/inventory data, stable reads, a real wait action,
and that stale/duplicate requests do not advance the game. This is useful for
engine/adapter regression coverage, but does not substitute for the separate
Chromium check of the browser Worker environment.

`runtime:serve` binds to loopback port 4173; its root redirects to the real
middleware page. It serves only public assets and compiled core, adapter, and
agent modules. The page cannot run when only `apps/web/public` is
served: it also needs the compiled workspace modules. The original standalone
probe and module smoke page can still use the public-only server.

The playable prototype uses a large left-hand map and a right-hand tabbed
panel (manual controls, assistant, inventory, messages). Map cells display the
printable character emitted by NetHack's glyph callback, with the player's
position overlaid; terrain-only symbols are a fallback. This is the real
NetHack 5.0 WASM engine, but not a port of a graphical tileset/windowport. The
adapter still cannot distinguish current line of sight from remembered cells,
so the page labels that limitation and does not enable navigation skills.

The assistant defaults to `OfflineDemoProvider`, which is a narrow rules-based
parser, not a language model. `HttpGatewayProvider` can send player-known
context to the same-origin `/api/decide` proxy. The proxy reaches the optional
loopback model gateway; that gateway defaults to echo mode and only calls an
actual OpenAI-compatible model when explicitly configured server-side. Model
actions are shown as proposals; the player must confirm them, and the confirmed
typed action is validated by `MiddlewareSession` before any runtime input.
Start `npm run gateway` separately from `npm run runtime:serve`. The gateway
binds only to loopback and its API key is never sent to the browser.

`eval:real` verifies artifact hashes and initialization, starts its own server
on an unused loopback port, and launches headless Chromium. It uses
`CHROMIUM_EXECUTABLE_PATH` if provided, otherwise a common system Chrome or
Chromium path for the host OS, otherwise Playwright's installed browser. Use
`npx playwright install chromium` if no browser is available. Missing browsers
or artifacts fail the check; they are not converted into passing skips.

At this milestone, `npm test` passes 12 adapter/transport tests and 3 local-Git
fetch regression checks; the existing fake suite passes 25 with its 2
real-runtime-related skips. The browser suite previously passed 10 runtime
checks and now also asserts the eight-direction movement and direction-prompt
controls; those new UI assertions have not been rerun in this local checkout
because Playwright is absent. The real suite validates startup, observation
stability, wait, move, direction prompt handling, pickup delivery,+deduplication, stale state and prompt rejection, and takeover epoch rejection.
It does not cover all item/menu/game-over scenarios, in-flight skill
interruption, save/load, or multiple browsers.

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
no current entities, and sets `supports_navigation: false`. `walk_to` refuses
that capability before issuing input. Unknown HP remains null.

Inventory is copied from the pinned shim's untitled, read-only (`PICK_NONE`)
menu when it contains NetHack inventory section headings. The adapter exports
the displayed item text and letter slot without inferring hidden item
properties. `inventory_current` is false before the first such menu and is
invalidated by `shim_update_inventory`; the last copied list is retained but
consumers must not treat it as current until another snapshot arrives. The
default runtime currently emits the complete inventory menu during startup;
how often it refreshes after later inventory mutations remains to be verified.

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

Each action is accepted only at a current boundary and waits for the next
stable boundary before returning. A typed recipe can contain a short sequence
of engine keys within that one delivery: `wait` sends `m.` because NetHack may
reject a bare `.` as pointless when no threat is nearby; the Worker consumes
the `m` prefix and `.` rest command without publishing the intermediate prefix
state. `open` sends `o` and surfaces a direction prompt; it does not
automatically send the direction in the original action. A subsequent typed
`respond` must match the current prompt ID. Menu responses validate option IDs
and single vs multiple selection, and use explicit indices to avoid numeric
accelerator aliases. Unknown prompts always stop automatic continuation.
Human text entry is not yet available through the current core response
contract.

Prompt IDs include a fresh adapter generation, so recreating a Worker with the
same session ID cannot accept responses from an earlier game. Concurrent
deliveries are rejected. Worker errors and boundary timeouts poison the
transport: a potentially committed input is never retried, late events are
ignored, and callers must explicitly terminate and create a new session.
This is fail-stop behavior, not automatic recovery or commit reconciliation.

## Remaining Phase 3 work

- Establish authoritative player-visible visibility and current entity data.
- Verify inventory refreshes after item mutations and stable dungeon identity.
- Cover multi-item pickup, all prompt types, death and unexpected engine exits
  against controlled real scenarios.
- Extend the existing core contract for human text entry and proper recovery.
- Reuse adapter tests across fake and real transports; then validate real
  navigation, in-flight Stop/Take Over, and production UI integration.
