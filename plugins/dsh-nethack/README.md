# dsh-nethack

Play NetHack inside DeepSeek Harness. A panel opens the real NetHack 3.6.7 WASM
engine; you can play it yourself with an on-screen direction pad, or hand the
character to the model and talk to it in an ordinary DSH conversation.

Hand-play and model-play drive the **same** engine: the panel always shows the
game the model is playing, and the model sees the map you see.

| | |
|---|---|
| Package | `dsh-nethack` (a DSH bundle: Host plugin + Client plugin + agent preset) |
| Engine | `@neth4ck/wasm-367@2.1.2` — the published upstream NetHack 3.6.7 WASM build, not vendored |
| DSH | `>=0.2.1-rc.3 <0.3.0` (`engines.dsh`; only 0.2.1-rc.3 was actually exercised) |
| License | MIT for this bundle; the engine keeps its NetHack General Public License |

## Install

Pick one of these. Each ends the same way: enable the NetHack plugin **and** its
`nethack` agent preset, then refresh DSH and open **@ / NetHack**.

### From the plugin market

Add this URL as a plugin market source in DSH, then install `dsh-nethack` from
the discovery page:

```text
https://raw.githubusercontent.com/yeasen-z/dsh-nethack/main/plugins/dsh-nethack/market/index.json
```

### Straight from this repository

No clone needed; pin the commit, because a branch would let the installed copy
change under you:

```json
{"action":"install_bundle","target":"git+https://github.com/yeasen-z/dsh-nethack.git#<commit>&path:/plugins/dsh-nethack"}
```

`<commit>` is any full SHA from this repository — the newest one on the market
page is [the current pin](market/index.json) (`versions[0].source.commit`).

### From a local checkout

```sh
git clone https://github.com/yeasen-z/dsh-nethack.git
```

Then ask DSH to install the absolute path to the **plugin directory**, not the
repository root:

```json
{"action":"install_bundle","target":"/absolute/path/to/dsh-nethack/plugins/dsh-nethack"}
```

### From npm (after publication)

```json
{"action":"install_bundle","target":"dsh-nethack@0.1.0"}
```

The manifest carries `license`, `repository`, `keywords` and `engines.dsh`, and
the bundling is allowed to fetch its engine dependency from the registry.

### Requirements

- A desktop or local Node-based DSH Host with the native conversation UI and
  session controller (the game chat is a real DSH Session).
- A configured model/provider for **chat**. Manual controls need no LLM.
- No external game server and no WASM compiler: the engine is a pinned npm
  dependency, downloaded at install time.

Installation changes the current DSH profile. Do not copy or hand-edit profile
configuration files.

## Play

- Talk to the game in its conversation, e.g. "探索附近房间". It uses DSH's
  transcript, streaming, model picker and stop control.
- **Key controls** (lower left, always visible): eight-direction pad, wait,
  pickup, search, open, stairs, and raw answer input. Keyboard capture is local
  to the focused control area; the chat box is not intercepted.
- **New game** asks for confirmation before discarding the current run.
- Switching away and coming back reuses this game's conversation; a new game
  gets a new one. The composer stays at the bottom of an empty conversation.
- The model answers engine questions itself, but you can too: a direction
  prompt takes one numpad key (`8` north, `2` south, `4` west, `6` east, and
  `7 9 1 3` for diagonals), `<`/`>` for stairs, Escape to cancel. The vi keys
  `h j k l` and words like `north` are **not** accepted by this engine.

## What the model can do

Only three tools are exposed in the game model's assembled request:

| Tool | Purpose |
|---|---|
| `nethack_observe` | Map (with `?` for never-seen cells), status, pack, recent messages, the pending prompt, and the keys that prompt accepts. |
| `nethack_act` | Move, wait, pick up, search, open, stairs, explore, or raw keys. Repeats stop on a question, damage, an arrival, or a step that did not land. |
| `nethack_respond` | Answer item, direction, yes/no, text, menu or position prompts. |

They are registered in the game Agent scope, never globally. Inherited tools are
masked, model-request assembly filters same-scope contributions such as Agent
Teams tools, and a scoped execution guard denies every non-game tool. The
restart definition is not exposed to the model: only the confirmed button calls
it. Other sessions keep their own tools and Team functionality.

## Update, disable, remove

- **Update:** in a local clone run `git pull --ff-only`, then ask the plugin
  manager to reinstall the same directory. Market installs carry an exact commit,
  so "update" means installing a newer version from the market.
- **Disable:** turning the plugin off removes its UI and bindings. The live
  worker survives until the Host exits, so a reload does not reset the run.
- **New game** is the only way to discard a run; disable is not a reset.

## Limits

- **One live game per Host process**, shared by every panel connected to it.
- **The game lives in memory.** Quitting the Host ends it. Persisted chat history
  is *not* a saved NetHack game.
- **Only DSH 0.2.1-rc.3 was exercised.** `engines.dsh` admits the rest of 0.2.x;
  a newer Host installs the bundle without having been tested.
- **Chat needs a model.** Without a working provider the panel and pad still work.
- The game conversation is an ordinary, non-archived Session, so it can appear in
  session lists.
- A hidden panel stops polling; reopening it refreshes the game and reopens the
  same conversation.
- A chat startup error carries its real binding detail. It does not mean the
  engine needs restarting: check the model configuration before pressing
  **New game**.
- Cross-machine installation has not been tested. Source tests and installed
  registration checks do not replace a test on your DSH version.

## Development

```sh
node --test plugins/dsh-nethack/tests/*.mjs        # 57 tests, incl. real-engine ones
node plugins/dsh-nethack/scripts/market-index.mjs  # regenerate market/index.json
npm pack --dry-run --prefix plugins/dsh-nethack    # what a registry install receives
```

The release workflow is: bump `version` in `package.json`, commit, run the
generator, commit the index, push. The market pins an exact commit, so the SHA
must be on the remote before the index that names it — a market install of an
unknown commit fails at fetch time. `tests/market-index.mjs` validates the index
with DSH's own `parseMarketIndex` and fails if the generator would change the
committed file.

The engine tests start their own worker, never the Host's live game. A randomly
generated starting character is occasionally itemless; those tests retry the
start rather than assert on the dice.

## Source layout

```
lib/index.mjs          Host routes, model tools, prompt/answer presentation
lib/session.mjs        game Session binding, tool filtering, execution guard
lib/game.mjs           engine state: prompts, inventory, turn accounting
lib/engine-worker.mjs  worker bridge to the WASM engine
lib/navigate.mjs       grid, pathfinding and exploration
lib/client.js          the panel: map, pack, pad, native conversation slot
cordis.patch.yml       bundle patch and the `nethack` agent preset (persona)
market/index.json      generated format-1 plugin market index
locale/                panel strings (en, zh)
tests/                 node:test suites, including real-engine ones
```

## Licenses

This bundle is MIT (repository `LICENSE`). The NetHack 3.6.7 WASM engine is the
published package `@neth4ck/wasm-367@2.1.2`
([neth4ck-monorepo](https://github.com/apowers313/neth4ck-monorepo)), distributed
under the NetHack General Public License; installation fetches that artifact, its
license and its npm provenance. Read its `LICENSE.md` before redistributing
anything derived from it, and verify the pin with `npm view @neth4ck/wasm-367`.
