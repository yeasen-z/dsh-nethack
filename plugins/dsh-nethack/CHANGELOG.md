# Changelog

All notable changes to the `dsh-nethack` bundle. The version here is the version
in [`package.json`](package.json); the market index lists the same strings.

## Unreleased

- Mark undrawn cells with `░` instead of `?`, which is the engine's scroll glyph,
  and explain the blind cell in the map key and the persona: it is neither floor
  nor wall, must not be routed through or assumed reachable.
- Fix the map key calling `#` rock: `#` is a corridor the character walks through.
  The persona now names the terrain glyphs (`#` corridor, `|`/`-` walls, `.` floor,
  `+` door, `<>` stairs) instead of leaving the model to guess which one blocks.
- Fix cached inventory remaining nonempty after the last item is dropped: the
  engine's `Not carrying anything.` message now clears the cache.
- Fix the drop test fixture: choose unequipped supplies, wait for real inventory
  updates, and verify all remaining items rather than accepting an empty pack.
- Replace the reversed ahead/behind warning with a local `origin/main`
  reachability check; explicitly report unknown publication status.
- Make missing DSH parser validation a visible skip, with a required-parser
  release mode. Check the full generated index against current source inputs
  and verify the pinned manifest and timestamp without chasing HEAD hashes.

## 0.1.0 — 2026-10-25

First public bundle. Playable, with the engine, panel and isolated game
conversation in place.

### Added

- Host plugin running the upstream NetHack 3.6.7 WASM engine on a worker thread.
- Panel with live map, status, pack, always-visible key controls and **New game**.
- Game conversation as a real, isolated DSH Session: only `nethack_observe`,
  `nethack_act` and `nethack_respond` are visible to it, and it can reach no
  other tool.
- Three model tools that cover the whole game loop: observe, typed actions with
  bounded repeats and exploration, and answers to engine prompts.
- Format-1 plugin market index, generated from git so the published entry pins a
  real commit and repeats `engines.dsh`.

### Changed

- The engine is a pinned dependency (`@neth4ck/wasm-367@2.1.2`) instead of a
  vendored copy, so installs fetch the official artifact and its license.
- `engines.dsh` is declared, so an incompatible Host refuses the bundle.

### Fixed

- The panel's conversation survived a panel switch by reusing the game's Session.
- The empty conversation's composer sat in the middle; it now stays at the bottom.
- Two scrollbars appeared in the pack: only the pack body scrolls now.
- The pack froze until someone pressed `i`; it re-renders after actions that can
  change it, without spending a turn.
- The model called its own pet a wall and apologised for a dead end it had read
  off blank map cells: unseen cells now print as `?`, `nethack_observe` names the
  pet and the unseen sides, and a blocked move says what is there.
- Prompt answers had to be guessed from the engine's raw choice string; every
  question now lists the keys it accepts.
