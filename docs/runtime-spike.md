# Runtime Spike Plan — NetHack 5.0 WASM (Milestone 1)

Status: NOT STARTED. Until this lands, `npm run demo`/`npm run eval` run against
the clearly-labeled fake runtime (`fake-nh@0.1`) in `packages/adapter-wasm`.
The delivered MVP demo must use a real session (handoff §11 "Real runtime").

## Goal
Report the ACTUAL integration points of the pinned upstream build, then
implement `wasm-bridge.ts` behind the existing `GameAdapter` interface so no
other package changes.

## Steps (record every command + output into this file as you go)
1. **Pin revisions.** Record exact commits of `NetHack/NetHack` (5.0 branch),
   `e3sh/Nethack-wasm-webUI`, and the Emscripten toolchain into
   `vendor/UPSTREAM.md`. Note each license at the pinned revision.
2. **Reproduce the browser build.** Build the WebUI target; save the build
   commands here; verify it boots in a browser and accepts manual input.
3. **Locate callbacks.** Map these shim/window-port points to adapter events:
   - map window updates (put/glyph changes) → tiles/entities
   - status window fields → player.hp/max_hp/conditions
   - message window lines → messages[]
   - menu/win display requests → InputState `menu`
   - prompt requests (`getpos`, yes/no, more, line-in) → direction/yes_no/more/text
   - turn/energy updates and `moveloop` idle points → stable input boundary
   - program exit / death → game_over + terminal flag
   - save/load surfacing
4. **Verify boundaries.** Confirm observations can be emitted only at
   recognized input boundaries (§5) and that `observe()` never consumes time.
5. **Inventory accessible observations.** Which minimum fields from §5 are
   available without engine changes? List gaps needing a narrow shim extension
   (keep upstream diffs small and isolated; document each gap).
6. **Input delivery.** Prove one semantic action's expected key sequence
   (e.g., open: `O` + direction) can be delivered through the single write
   path, and that an unexpected prompt halts delivery (§6).
7. **Decisions log.** Any deviation from WASM-first (PTY/NLE fallback) needs an
   ADR in `docs/adr/` before implementation (§3).

## Adapter conformance checklist for `wasm-bridge.ts`
- [ ] `capabilities.runtime_id` = pinned build id
- [ ] `snapshot()` builds Observation with visible vs remembered tiles, null
      unknowns preserved, entity refs snapshot-scoped
- [ ] `deliver()` encodes only expected per-action sequences; returns
      `unexpected_prompt` otherwise; never blind key injection
- [ ] text prompts report `supports_automatic_text_entry=false` → UI hands off
- [ ] busy state surfaced; scheduler is the only writer
- [ ] termination surfaces reason + terminal observation

## Known contract risks (from handoff §3)
References establish direction, not proof that any field/API exists upstream.
Expect gaps around: per-tile visibility flags, level identifiers, prompt IDs,
turn counters exposed to JS, and reliable "input boundary" signals.
