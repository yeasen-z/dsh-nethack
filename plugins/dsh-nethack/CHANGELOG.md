# Changelog

All notable changes to the `dsh-nethack` bundle. The version here is the version
in [`package.json`](package.json); the market index lists the same strings.

## 2026-10-27 — 0.2.0

- Redesign the panel: the game is a full-height left column (HUD, map stage,
  console) and the right column holds the AI conversation, the pack and the
  message log as tabs, so the map is no longer squeezed by the transcript. A
  narrow dock stacks the columns instead of shrinking both.
- Add a status HUD: character, depth, HP and Pw bars with low-HP colouring, AC,
  gold, turn, strength, active conditions, and refresh/new game on the right.
- Float the engine's last three messages over the map (older lines fade) and
  move the full history into the Messages tab; add a `?` map legend that
  explains `░`, `#`, traps and items.
- Raise engine questions over the map as a card whose menu rows are buttons
  carrying their own accelerator, so a menu, `--More--` or yes/no question is
  answered with one click; position prompts now explain that the cursor, not the
  character, moves.
- Merge the key manual and the action buttons into one always-visible console
  strip with a visible "keyboard captured" state, and label every action button
  with the engine key it sends.
- Underline the pet instead of painting it as a monster, using the tile next to
  the player rather than colouring every letter.
- Fix the glyph table: a closed door (`+`, which shares its glyph with a
  spellbook) was drawn as a spellbook and never as a door, and traps (`^`),
  undrawn cells (`░`) and the `)` weapon glyph were missing from it entirely.
- Add the panel screenshots (AI conversation, pack) to both READMEs.
- Fix the palette to use hover/tertiary tokens that actually exist
  (`interactive-bg-hover`, `label-tertiary`, `bg-module-platform`) instead of
  inventing hover fills, and confirm every `--dsw-alias-*` name against the
  host theme sheet.
- Rewrite the game persona around the tools' real behaviour: batch with
  `explore`/`count`, observe only at the start or after a question, search in
  batches of ten rather than three, keep digit keys for prompt answers and
  direction names for `move`, and report at milestones instead of running
  without a stop condition. The pet-swap note no longer claims a swap is free.
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
