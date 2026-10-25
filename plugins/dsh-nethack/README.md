# dsh-nethack

Play NetHack inside DeepSeek Harness: a Host plugin runs the upstream NetHack
WASM engine on a worker thread and exposes it to the model as tools; the Client
plugin renders the live game as a central panel reached from a single top-left
entry. Hand-play and model-play drive the *same* engine, so the panel always
shows the game the model is playing.

## Install

Requires **DSH `>=0.2.1-rc.3 <0.3.0`** (declared as `engines.dsh`, so an
incompatible Host refuses the install instead of failing at runtime). Verified
interactively on 0.2.1-rc.3 only: a newer 0.2.x Host is allowed by the range but
has not been exercised. Use a desktop/local Node-based DSH Host with the native
conversation UI and session controller available. No external game server or
WASM compiler is needed.

### From the Git repository

```sh
git clone https://github.com/yeasen-z/dsh-nethack-chatplay.git
```

Then ask DSH to install the bundle straight from the repository (pin the commit:
a moving branch would make the installed copy change under you):

```json
{"action":"install_bundle","target":"git+https://github.com/yeasen-z/dsh-nethack-chatplay.git#<commit>&path:/plugins/dsh-nethack"}
```

### From a local checkout

Point the plugin manager at the absolute path to `plugins/dsh-nethack`:

```json
{"action":"install_bundle","target":"/absolute/path/to/dsh-nethack-chatplay/plugins/dsh-nethack"}
```

### From npm, once published

The package is prepared for the registry (`license`, `repository`, `keywords`,
`engines.dsh`; the manifest is packed from this directory, not from the repo
root). After `npm publish` from this directory:

```json
{"action":"install_bundle","target":"dsh-nethack@0.1.0"}
```

### From a plugin market

This repository publishes a format-1 market index at
[`market/index.json`](market/index.json). Add its URL to DSH's plugin market
sources, or install straight from the index entry:

```text
https://raw.githubusercontent.com/yeasen-z/dsh-nethack-chatplay/main/plugins/dsh-nethack/market/index.json
```

A market entry pins an exact commit and cannot follow a branch, so the index is
**generated**, never edited by hand:

```sh
node plugins/dsh-nethack/scripts/market-index.mjs
```

Run it after bumping `version` in `package.json`, commit both files, then push:
the pinned SHA must already be on the remote or installation fails at fetch
time. `node --test plugins/dsh-nethack/tests/market-index.mjs` checks the index
with DSH's own `parseMarketIndex` and fails if the generator would change the
committed file.

The entry is `source: {"type":"git", ...}` with
`path: "plugins/dsh-nethack"` (the bundle is a subdirectory of the repository,
not its root), and `engines` repeats the manifest's `engines.dsh` — the market
will not list a version that does not state its compatibility. Switching the
entry to npm later only replaces `source` with `{"type":"npm"}` and drops `path`
from the install target.

Approve the installation and enable the NetHack plugin and its `nethack` preset.
Refresh the page, then open **@ / NetHack** in the sidebar. The plugin also
registers a right-pane NetHack tab. Installation changes this DSH profile;
do not copy or edit profile configuration files by hand.

Configure a working model/provider in DSH before using chat. Manual controls
work without an LLM. Model calls use your provider account and may incur costs.

## Play

- Give instructions in the game's conversation, for example “探索附近房间”.
  It uses DSH's transcript, streaming, model picker and stop control.
- **按键操作 / Key controls**, at lower left, expands an eight-direction pad,
  waiting, pickup, search, doors, stairs and raw answer input. Keyboard capture
  is local to the focused control area; chat input is not intercepted.
- **重开游戏 / New game** asks for confirmation before discarding the current game.
- When the engine asks “What do you want to use or apply? [b or ?*]”, answer
  `b` to select that inventory letter, `?`/`*` to inspect choices, or Escape to
  cancel. The model uses `nethack_respond` for these prompts.
- Switching away and returning reuses this game's Session. A new game gets a
  new conversation. The empty conversation composer stays at the bottom.

## Isolation

Only these tools are exposed in the game model's assembled request:

| Tool | Purpose |
|---|---|
| `nethack_observe` | Read the visible map, status, inventory, messages and pending prompt. |
| `nethack_act` | Move, wait, pick up, search, open, use stairs, explore or send raw keys. Repeated actions stop on relevant changes. |
| `nethack_respond` | Answer an item-selection, direction, yes/no, text, menu or position prompt. |

They are registered in the game Agent scope, never globally. Inherited tools
are masked; model-request assembly filters same-scope contributions such as
Agent Teams tools, and a scoped execution guard denies all non-game tools.
The restart definition is not exposed to the game model: the confirmed UI
button calls the shared restart implementation. Other sessions keep their own
tools and Team functionality.

## Update / disable

Run `git pull --ff-only` in the clone and ask DSH's plugin manager to reinstall
the same absolute bundle directory. Do not install the repository root as an
npm package. A plugin-only reload retains the live engine, but this is not a
save-game facility. Disabling the plugin removes its UI and bindings; the live
worker remains until the Host exits so a temporary reload does not reset it.

## Limits and troubleshooting

- One live game per Host process, shared by panel instances/users connected to it.
- The engine runs in memory. Quitting the Host ends the game; persisted DSH chat
  history is not persisted NetHack progress.
- Game chat uses an ordinary, non-archived Session; it may appear in session lists.
- A hidden panel stops polling. Reopening it refreshes the game and reopens the
  same conversation identity.
- A chat startup error includes its actual binding detail. It does not imply the
  engine needs a restart. Check the model configuration and report the complete
  error before using the destructive New game button.
- **Only 0.2.1-rc.3 is verified.** `engines.dsh` admits the rest of 0.2.x, so a
  newer 0.2.x Host installs the bundle without having been tested; widen or
  narrow the range deliberately when you test another version.
- **Chat needs a working model/provider** configured in the target DSH. Without
  one the panel and key controls still work, but the conversation cannot answer.
- **One live game per Host process**, and the game lives in memory: quitting DSH
  ends the run. Persisted chat history is not persisted NetHack progress.

- Plugin source tests and installed registration checks do not replace testing
  on the target DSH version. Cross-machine installation has not yet been tested.

## Development and packaging

From the repository root:

```sh
node --test plugins/dsh-nethack/tests/*.mjs
npm pack --dry-run --json --prefix plugins/dsh-nethack
```

Or run `npm pack --dry-run --json` from this plugin directory. The package file
allowlist includes the Host/Client modules, locales, icon, bundle patch and WASM
engine. No install/build scripts or external runtime dependencies are required.
The standalone engine test starts its own worker, not the Host's current game;
its randomly generated starting character can occasionally make the direction
fixture fail (“no hands”).

## Source layout and licenses

- `lib/index.mjs`: Host routes and model tool definitions.
- `lib/session.mjs`: game Session binding, model tool filtering and execution guard.
- `lib/client.js`: panel, session reuse, native conversation occurrence and controls.
- `lib/game.mjs`, `lib/engine-worker.mjs`: engine state and worker bridge.

Engine: the NetHack 3.6.7 WASM build is **not vendored here**. `package.json`
pins the published upstream package `@neth4ck/wasm-367@2.1.2`
([neth4ck-monorepo](https://github.com/apowers313/neth4ck-monorepo), NetHack
General Public License), so installation fetches the official artifact, its
license and its npm provenance. Verify it with `npm view @neth4ck/wasm-367`
before installing, and read its `LICENSE.md` before redistributing anything.
Project license: [repository license](<../../LICENSE>).
