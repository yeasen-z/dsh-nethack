# dsh-nethack

Play NetHack inside DeepSeek Harness. A panel opens the real NetHack 3.6.7 WASM
engine; you can play it yourself with an on-screen direction pad, or hand the
character to the model and talk to it in an ordinary DSH conversation.

Hand-play and model-play drive the **same** engine: the panel always shows the
game the model is playing, and the model sees the map you see.

![The game on the left, the AI conversation on the right](../docs/screenshots/panel-ai-chat.png)

![The pack tab](../docs/screenshots/panel-pack.png)

| | |
|---|---|
| Package | `@yeaszn/dsh-neth4ck` on npm (a DSH bundle: Host plugin + Client plugin + agent preset); the plugin is still called `dsh-nethack` inside DSH |
| Engine | `@neth4ck/wasm-367@2.1.2` — the published upstream NetHack 3.6.7 WASM build, not vendored |
| DSH | `>=0.2.1-rc.3 <0.3.0` (`engines.dsh`; only 0.2.1-rc.3 was actually exercised) |
| License | MIT for this bundle; the engine keeps its NetHack General Public License |

## Install

Pick one of these. Each ends the same way: enable the NetHack plugin **and** its
`nethack` agent preset, then refresh DSH and open **@ / NetHack**.

### From the plugin market

Open **Plugins → Discover**, choose **Add index source** (on an empty Discover
tab this is the empty state's button), and paste this URL:

```text
https://raw.githubusercontent.com/yeasen-z/dsh-nethack/main/plugins/dsh-nethack/market/index.json
```

Then type **`nethack`** in the search box and install the **NetHack** entry.

Search covers names, authors, keywords, and every language of the titles,
descriptions, categories and labels, so these all find it too:

| Query | Matches because |
|---|---|
| `nethack` | package name, title and keyword |
| `net` | prefix of those |
| `地牢` or `游戏` | Chinese title and description |
| `roguelike`, `wasm`, `agent`, `game` | keywords |
| `yeasen-z` | author |

Words in a query must **all** match, so `nethack postgres` returns nothing. If
the source cannot be read, the **Index sources** dialog shows the read error
next to it — the usual cause is no route to `raw.githubusercontent.com`.

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

### From npm

In **Plugins → Add plugin** type the package name, or ask the plugin manager:

```json
{"action":"install_bundle","target":"@yeaszn/dsh-neth4ck@0.2.1"}
```

The npm name is `@yeaszn/dsh-neth4ck`: the registry rejects a new package whose name
contains `nethack` ("That word is not allowed"), so the package is published under
a respelling. Nothing else changes: the panel, the `@ / NetHack` entry, the
`nethack` preset and the `/api/dsh-nethack.*` routes keep their names.

If the install fails with `404 ... Not Found`, the **Install source** selector is
on a mirror that has not synced the package yet: the mainland China mirror
(`registry.npmmirror.com`) lags the official registry for new packages and
versions. Switch the source to **npm official** and install again, or wait a few
minutes and retry. A maintainer can force the mirror to catch up with
`curl -X PUT "https://registry-direct.npmmirror.com/@yeaszn/dsh-neth4ck/sync?sync_upstream=true"`.

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
- The panel is two columns: **the game on the left** (status HUD, the map, the
  console) and **a side column on the right** holding the AI conversation, the
  pack and the message log as tabs. In a narrow dock (the right-column tab) the
  columns stack instead of shrinking the map.
- **HUD** (top): the character and depth, HP and Pw as bars (green, amber, red
  as HP drops), AC, gold, turn, strength, and any active conditions. Refresh and
  **New game** sit at its right; a new game asks for confirmation before
  discarding the current run.
- **Stage**: the map, with the engine's last three lines fading above it and the
  full log one click away in the Messages tab. `@` glows, your pet is
  underlined, monsters are red. The `?` corner explains every glyph, including
  `░` (an unseen cell: neither floor nor wall).
- **Console** (bottom left, always visible): eight-direction pad, wait, search,
  pick up, open, stairs, space/Enter/Escape and a raw key field. Every button
  shows the engine key it sends. Arrow keys and numpad are captured only while
  the console has focus — the label says "Keyboard captured" when it does, and
  the chat composer is never intercepted.
- **Questions** the engine asks rise over the map as a card. Menu rows become
  buttons carrying their own accelerator, so a name, an item or a "--More--"
  page is answered with one click; a line prompt keeps a text field.
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
| `nethack_observe` | Map (with `░` for never-seen cells), status, pack, recent messages, the pending prompt, and the keys that prompt accepts. |
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

## Development and release checks

Run source tests from a full git checkout, with the engine dependency installed:

```sh
node --test plugins/dsh-nethack/tests/*.mjs
# Inspect the plugin package, NOT the workspace root package:
(cd plugins/dsh-nethack && npm pack --dry-run)
```

The DSH parser integration test is explicitly **skipped** when its package is
not resolvable. Structural tests passing does not establish DSH parser acceptance.
For a release, point at an accessible, installed or extracted DSH parser module
and require that check (a missing/broken parser then fails instead of skipping):

```sh
DSH_MARKET_VALIDATOR=/absolute/path/to/dsh-plugin-market-index/lib/index.js \
DSH_REQUIRE_MARKET_VALIDATOR=1 \
node --test plugins/dsh-nethack/tests/market-index.mjs
```

Do not modify DSH or its profile to run this check. Ordinary Node cannot read
inside Electron's `app.asar`; use an accessible package or an extracted copy.
The validator version should match the DSH release you are verifying.

### Publishing an index

1. Finish the release code, update the package version and changelog, then commit
   those bundle changes. The generator refuses uncommitted bundle files (except
   its output index), so the index cannot claim unpublished working-tree code.
2. Push the release-code commit. From the repository root run:
   `node plugins/dsh-nethack/scripts/market-index.mjs`.
3. Run the required-parser check above. Tests compare the **current** manifest,
   icon and generator output against the complete index using its pinned SHA
   and timestamp; they also read the pinned commit's manifest and timestamp.
   No fields are silently excluded, and HEAD need not equal the release pin.
4. Commit the generated index separately, then push that index commit. The index
   pins the earlier release-code commit, not its own commit: **do not regenerate
   merely to chase every new index-only commit**.
5. Fetch the public index URL without credentials, parse it, and check that its
   pinned commit can be fetched anonymously. An index is only a declaration;
   local tests cannot prove remote accessibility or installation in DSH's GUI.

The generator checks whether the release SHA is reachable from **local
`origin/main`**. This is a tracking snapshot, not a network check; stale refs,
missing refs or incomplete history require manual verification. It warns when
that snapshot does not contain the release or cannot be checked.

The inventory tests use standalone Wizard games, wait for inventory events, and
select unequipped items. Dropping worn armor is correctly refused by NetHack;
repeated refreshes cannot make that action succeed. Tests assert the exact
remaining items and separately verify that a genuinely empty pack clears the
cached inventory. No test operates the Host's live game.

## Source layout

```
lib/index.mjs          Host routes, model tools, prompt/answer presentation
lib/session.mjs        game Session binding, tool filtering, execution guard
lib/game.mjs           engine state: prompts, inventory, turn accounting
lib/engine-worker.mjs  worker bridge to the WASM engine
lib/navigate.mjs       grid, pathfinding and exploration
lib/client.js          the panel: HUD, map stage, console, side tabs, native conversation slot
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
