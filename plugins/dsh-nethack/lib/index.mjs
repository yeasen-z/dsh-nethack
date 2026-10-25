// dsh-nethack — Host half.
//
// Runs one NetHack engine for this Host process, exposes it to the model as
// tools, and serves the Web UI panel over two package-owned routes.
//
// Both callers drive the SAME NetHackGame instance: the tools below and the
// `/api/dsh-nethack.action` route the client panel posts to. No operation
// logic is duplicated between them ("One operation, two callers").
//
// Deliberately free of `@deepseek-ai/*` imports: a Loader row of a profile
// bundle registers tools with a plain definition object.

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { NetHackGame, DIRECTIONS, mintGameId } from "./game.mjs";
import {
  buildGrid, nearestFrontier, unseenNeighbours,
  reachableClosedDoors, isPassable, isWalkThrough, posKey,
} from "./navigate.mjs";
import { GameSession, GAME_PRESET } from "./session.mjs";

export const name = "dsh-nethack";

/**
 * Services used opportunistically; the plugin stays valid without them.
 *
 * `llm`, `sessionController`, and `agentDefaultModel` back the panel's OWN chat.
 * They are read with `ctx.get(...)` at call time rather than listed here: that is the
 * documented optional-access pattern (it needs an undefined check), and listing
 * them as injections would stop this whole plugin from loading in a profile
 * that has no model service. The chat route reports "unavailable" instead.
 *
 * `tools` is deliberately absent: the game tools are not registered globally, so
 * nothing here needs the registry. See `registerTools()`.
 */
const OPTIONAL = ["connection"];

/**
 * Routes the Web UI panel calls with the browser's own `fetch`.
 *
 * Registered on `ctx.connection.fetch` rather than the raw Web server so they
 * sit inside Connection's authentication fence: the panel is served by the
 * authenticated page and its requests carry the page's credential, exactly
 * like the shipped `/api/present.host` route.
 */
const ROUTE_STATE = "/api/dsh-nethack.state";
const ROUTE_ACTION = "/api/dsh-nethack.action";
const ROUTE_SESSION = "/api/dsh-nethack.session";
const ROUTE_DIAG = "/api/dsh-nethack.diag";
const PLAYER_NAME = "NHChat";

let game = null;

/**
 * Cross-reload slot for the game's DSH session binder.
 *
 * Same reason as the engine slot: a reload evicts this module while the session
 * it attached the tools to is still live, so the successor must find the same
 * binder rather than assume no session exists. Without this, a reload would
 * either lose track of the game's session (so `cancel` and the diag route go
 * blind) or re-register the tools into a scope that already has them.
 */
const SESSION_SLOT = Symbol.for("dsh-nethack.session.v1");

function sessionSlot() {
  const shared = globalThis;
  shared[SESSION_SLOT] ??= { sessions: null };
  return shared[SESSION_SLOT];
}

/** Forget the game's session after the engine it belonged to is gone. */
function detachGameSession(ctx) {
  const slot = sessionSlot();
  slot.binding = undefined;
  if (!slot.sessions) {
    // A reload before any attach: build the binder this module would use, so the
    // next attach is recorded in a place the successor module can find.
    slot.sessions = new GameSession(ctx, { definitions: registerTools(ctx) });
  }
  slot.sessions.detach();
}

/**
 * Cross-reload slot holding the one engine for this Host process.
 *
 * A plugin reload evicts this module and builds a fresh one, so a module-local
 * variable would look empty while the previous engine was still running — and
 * the old module's unload effect would stop it, discarding a live game. Keying
 * the slot on `globalThis` lets the replacement module adopt the running engine.
 * `Symbol.for` is deliberate: separate module instances must agree on the key.
 *
 * The engine is owned by the PROCESS, not by the plugin row. Unloading
 * deliberately does not stop it: reloading a linked plugin means disabling and
 * re-enabling its row, and those are separate approval-gated steps that a person
 * can put minutes apart, so no hand-over deadline can tell "a reload is coming"
 * from "the plugin is gone for good". Keeping the engine costs nothing while it
 * is idle — the worker is `unref`'d, so it never holds the process open — and
 * the OS reclaims it on exit.
 */
const GAME_SLOT = Symbol.for("dsh-nethack.engine");

function engineSlot() {
  let slot = globalThis[GAME_SLOT];
  if (!slot) {
    slot = { game: null };
    globalThis[GAME_SLOT] = slot;
  }
  return slot;
}

/**
 * Resolve the NetHack engine module from the published upstream package.
 *
 * The engine is NOT vendored into this plugin: `@neth4ck/wasm-367` is declared
 * as a dependency so the installer fetches the official build, its license and
 * its provenance instead of trusting a binary this repository happens to ship.
 * The version is pinned in `package.json`; resolution failure is reported
 * instead of silently loading some directory beside this file.
 */
function resolveEngineUrl() {
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve("@neth4ck/wasm-367")).href;
  } catch (cause) {
    throw new Error("NetHack engine dependency @neth4ck/wasm-367 is missing; reinstall the plugin bundle", { cause });
  }
}

/**
 * The single engine for this Host process, started on first use.
 *
 * Deliberately lazy: loading a profile should not boot a 5 MB WASM engine and
 * hold a worker thread for a user who never opens the panel or calls a tool.
 */
function ensureGame(ctx) {
  const slot = engineSlot();
  if (slot.game) {
    // Adopt the running engine: after a reload this module must drive the same
    // game rather than booting a second one beside it.
    game = slot.game;
    adoptGameId(game, slot);
    return game;
  }
  const instance = new NetHackGame({
    moduleUrl: resolveEngineUrl(),
    name: PLAYER_NAME,
    onLog: (message) => ctx.logger?.info?.(`[nethack] ${message}`),
  });
  instance.start();
  slot.game = instance;
  game = instance;
  adoptGameId(game, slot);
  return game;
}

/**
 * Give the adopted game an identity the client can key its archive by.
 *
 * A plugin reload replaces this module but adopts the running game, whose
 * `observe()` was compiled by the *previous* module and so does not report
 * `game_id` at all (the same limitation that makes method changes need
 * `nethack_restart`). Minting one here — on the fresh module, whose client does
 * understand it — keeps the archive working without discarding a live game.
 * Recorded on the engine slot so every later reload and every route agrees.
 */
function adoptGameId(gameInstance, slot) {
  if (typeof gameInstance.gameId !== "string" || gameInstance.gameId === "") {
    gameInstance.gameId = mintGameId();
  }
  slot.gameId = gameInstance.gameId;
  return gameInstance.gameId;
}

/**
 * New messages since the last call, tolerating an engine instance from an older
 * module.
 *
 * A plugin reload adopts the running engine rather than rebooting it, so this
 * module can be handed an instance whose *class* was compiled by the previous
 * module. A method added after that instance was built is simply absent, and
 * calling it threw `instance.takeNewMessages is not a function` in every tool
 * that needed the delta -- turning a cosmetic improvement into a hard failure
 * the model could not recover from, since even `nethack_observe` died.
 *
 * Falls back to the last few lines, which is exactly what the delta exists to
 * avoid repeating; a stale instance therefore gets more text, never an error.
 */
function newMessages(instance, observation) {
  const lines = Array.isArray(observation?.messages) ? observation.messages : [];
  if (observation?.ended) return lines.slice(-8);
  if (typeof instance?.takeNewMessages !== "function") return lines.slice(-3);
  try {
    return instance.takeNewMessages();
  } catch {
    // Private-field or version mismatch inside the old method: the same
    // degrade, decided after trying rather than only before.
    return lines.slice(-3);
  }
}

/** Wait until the engine is either at the command prompt or asking a question. */
async function settle(gameInstance, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observation = gameInstance.observe();
    const kind = observation.waiting_for;
    if (kind !== "running" && kind !== "starting") return kind;
    // A finished engine will never ask again; polling it out would stall every
    // caller for the full timeout before they learn nothing is coming.
    if (observation.ended) return kind;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return gameInstance.observe().waiting_for;
}

/** Largest `count` one call may spend, so a single tool call cannot eat a game. */
const MAX_REPEAT = 50;

/**
 * Keystrokes that can move items between the pack and the world.
 *
 * NetHack command letters for pick up (`g`), take off (`T`), eat (`e`), drink
 * (`q`), read (`r`), zap (`z`), wear (`W`), wield (`w`), apply (`a`), put on
 * (`P`), remove (`R`), drop (`d`), throw (`t`), pay (`p`), tip (`t`) and the
 * inventory/add-to-inventory pair (`i`, which only displays). Anything else —
 * movement, searching, opening — cannot change the pack.
 */
const ITEM_COMMAND_KEYS = new Set("gTqerzwWaPRdtpio");

/**
 * Turn a caller's `count` into an `explore` step budget.
 *
 * Both the tool and the panel route use this, so "how many steps may one explore
 * take" is answered in one place. A missing or nonsensical value means "the whole
 * allowance", not zero: a bad argument should not silently do nothing.
 */
function exploreBudget(count) {
  const value = Math.trunc(Number(count));
  if (!Number.isFinite(value) || value < 1) return MAX_REPEAT;
  return Math.min(value, MAX_REPEAT);
}

/**
 * Settle, then page through `--More--` prompts automatically.
 *
 * A `--More--` page asks nothing: it is the engine showing text it has already
 * produced, and the only accepted answer is "space". Driving it through the model
 * cost a whole round — a full LLM call, several seconds — to send one space, and
 * the boot message alone burned one. Paging here keeps the text (it still rides
 * back in the tool result) and reserves rounds for actual decisions. `yn`, `line`
 * and `menu` are deliberately NOT auto-answered: those carry a real choice.
 *
 * The inventory screen (`i`) is a PICK_NONE menu, i.e. a *display*, not a choice.
 * It is taken back by the engine wrapper instead of answered, so a queued display
 * can never be handed to a later prompt as its answer.
 *
 * Bounded, because a wedged engine must not page forever, and it returns as soon
 * as anything other than `more` comes up.
 */
async function settlePastPages(gameInstance, signal, { maxPages = 12, timeoutMs = 4000, waitForMap = true } = {}) {
  let waiting = await settle(gameInstance, timeoutMs);
  // The engine paints the map as it starts, so `command` can arrive with only a
  // few rows drawn and no character on them. Read the position only once the map
  // is there, or the cursor fallback would be reported as the character's place —
  // the very confusion this layer exists to prevent.
  if (waitForMap) {
    const deadline = Date.now() + timeoutMs;
    while (!gameInstance.observe().position_verified && !gameInstance.observe().ended
      && Date.now() < deadline) {
      signal?.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 60));
      waiting = gameInstance.observe().waiting_for;
      if (waiting !== "command") break;
    }
  }
  let pages = 0;
  while (waiting === "more" && pages < maxPages) {
    signal?.throwIfAborted();
    const result = gameInstance.respond("");
    if (!result.accepted) break;
    pages += 1;
    waiting = await settle(gameInstance, timeoutMs);
  }
  return { waiting, pages };
}

/**
 * Run one action `count` times, one keystroke per turn.
 *
 * The repeat lives here rather than in `act()` because the worker buffers the
 * tail of any multi-character answer and feeds those leftovers to the next
 * prompt before consulting the host. Re-sending a single key only while the
 * engine is still at the command prompt keeps every keystroke accounted for:
 * the first question the engine asks stops the loop and is reported back.
 */
/** HP as a number, or null when the engine has not reported it yet. */
function hpOf(observation) {
  const value = Number(observation?.status?.BL_HP);
  return Number.isFinite(value) ? value : null;
}

/**
 * Monsters pictured on the eight tiles around the player.
 *
 * NetHack draws monsters as letters and objects as punctuation, so a letter on
 * a neighbour tile is a monster (the player's own `@` sits at `player`, not on a
 * neighbour). Returns the distinct glyphs.
 *
 * The player's own pet is excluded: it draws as an ordinary lowercase letter, so
 * counting it would make a walk stop the moment the pet caught up — which is
 * every few steps, since the pet follows the player everywhere. The engine marks
 * it with `MG_PET` on the tile, which is the only reliable way to tell it apart.
 */
/**
 * What is standing in one direction from the player.
 *
 * A move into an occupied tile is an ATTACK, not a step: the turn passes and the
 * character stays put. The model could only see "the way is blocked", which reads
 * as a wall — so it never learned the useful move here, swapping places with the
 * follower by pressing the movement key at it. Naming what is there (and whether
 * it is the pet) gives it the information the map's single glyph does not.
 *
 * @returns a description, or null when the tile is empty or unknown.
 */
function occupantAt(observation, direction) {
  const player = observation?.player;
  const step = DIRECTIONS[direction];
  if (!player || !step) return null;
  const dx = Number(step) % 3 === 1 ? -1 : Number(step) % 3 === 2 ? 0 : 1;
  const dy = Number(step) <= 3 ? 1 : Number(step) <= 6 ? 0 : -1;
  const tile = (observation.tiles ?? []).find((t) => t.x === player.x + dx && t.y === player.y + dy);
  if (!tile?.text || tile.text === " ") return null;
  const creature = /^[A-Za-z@&;:'"]$/.test(tile.text);
  const pet = tile.pet
    ? "your pet/follower"
    : creature ? "a creature" : "something";
  return { glyph: tile.text, pet: !!tile.pet, label: pet };
}

/**
 * What to do about the tile a move failed to enter.
 *
 * Kept as one sentence so every caller (a repeated walk, a single step) tells the
 * model the same thing: this is not a wall, and the engine has a move for it.
 */
/**
 * The eight cells around the player, named the way the tools name directions.
 *
 * Kept next to `occupantAt` so "what is beside me" and "what did I walk into" use
 * one table of offsets rather than two that can drift apart.
 */
const COMPASS = [
  ["northwest", -1, -1], ["north", 0, -1], ["northeast", 1, -1],
  ["west", -1, 0], ["east", 1, 0],
  ["southwest", -1, 1], ["south", 0, 1], ["southeast", 1, 1],
];

/**
 * The creatures standing next to the player, pet first.
 *
 * The map draws the player's own pet as an ordinary lowercase letter, so from the
 * legend alone it is indistinguishable from a hostile monster — and the model
 * talked itself into "blocked by my cat" without knowing whether the letter was
 * even a pet. The engine marks the pet (MG_PET), so this states it outright.
 */
function neighbours(observation) {
  const player = observation?.player;
  if (!player) return [];
  const at = new Map((observation.tiles ?? []).map((tile) => [`${tile.x},${tile.y}`, tile]));
  const found = [];
  for (const [name, dx, dy] of COMPASS) {
    const tile = at.get(`${player.x + dx},${player.y + dy}`);
    if (!tile?.text || tile.text === " ") continue;
    const creature = /^[A-Za-z@&;:'"]$/.test(tile.text);
    if (!creature && !tile.pet) continue;
    found.push({ direction: name, glyph: tile.text, pet: !!tile.pet });
  }
  // Pet first: it is the one that changes what a move does (a swap, not a fight).
  return found.sort((a, b) => Number(b.pet) - Number(a.pet));
}

/** One line for `nethack_observe`, or null when nothing is adjacent. */
export function neighboursLine(observation) {
  const found = neighbours(observation);
  if (!found.length) return null;
  return `next to you: ${found.map((n) => `${n.pet ? "your pet" : "a creature"} "${n.glyph}" (${n.direction})`).join(", ")}`;
}

function blockedHint(observation, direction) {
  const occupant = occupantAt(observation, direction);
  if (!occupant) {
    // Nothing stands there, so this was solid rock. Supplying the unexplored
    // sides turns "blocked" into the next thing to try, instead of an answer the
    // model has to guess its way out of (one spent a long reply apologising for
    // a dead end it had read off blank cells).
    const unseen = unseenDirectionsLine(observation);
    return `rock and nothing else. ${unseen ?? "Every side of you has been seen; this stretch is closed — go back the way you came."}`;
  }
  if (occupant.pet) {
    return `"${occupant.glyph}" there is ${occupant.label}. Moving into it swaps places with your follower instead of walking — press the same direction again to trade places, and do not attack it.`;
  }
  return `"${occupant.glyph}" there is ${occupant.label}: moving ${direction} attacks it rather than moving. Fight only if it is worth it, otherwise go around it or wait for it to move.`;
}

function adjacentThreats(observation) {
  const player = observation?.player;
  const found = new Set();
  if (!player) return found;
  for (const tile of observation.tiles) {
    if (Math.abs(tile.x - player.x) > 1 || Math.abs(tile.y - player.y) > 1) continue;
    if (tile.x === player.x && tile.y === player.y) continue;
    if (tile.pet) continue;
    if (/^[A-Za-z]$/.test(tile.text)) found.add(tile.text);
  }
  return found;
}

/**
 * Show the pack again after a turn that can change it.
 *
 * The panel's pack is not live data: it is the rows of the last inventory screen
 * the engine rendered, so it only moves when something puts that screen up. This
 * re-renders it after actions that can move items between the pack and the world,
 * and only while the engine is parked at the command prompt — a refresh during a
 * question would replace the question (and a long walk would refresh per step).
 * `i` displays without using a turn, and the resulting page is taken back off the
 * queue by `NetHackGame`, so nothing is answered by accident.
 *
 * @returns the waiting kind afterwards, so the caller reports the real state.
 */
async function refreshPack(gameInstance) {
  if (gameInstance.observe().waiting_for !== "command") return false;
  if (!gameInstance.refreshInventory()) return false;
  return (await settle(gameInstance, 1200)) === "command";
}

/**
 * Whether an action that just ran can change the pack.
 *
 * Only the item verbs are inspected, and `raw_keys` is read as literal
 * keystrokes because that is how the panel and the model reach item commands;
 * a word typed into a `line` prompt is not a command and must not trigger this.
 */
function packMayHaveChanged(body) {
  if (body?.action === "pickup" || body?.action === "descend" || body?.action === "ascend") return true;
  if (body?.action !== "raw_keys") return false;
  const keys = typeof body.keys === "string" ? body.keys : "";
  // One keystroke only: a multi-key string is scripted input, and the panel sends
  // exactly one key per press, so scanning it for letters would misfire.
  return keys.length === 1 && ITEM_COMMAND_KEYS.has(keys);
}

async function actRepeated(instance, args, signal) {
  const raw = Math.trunc(Number(args?.count ?? 1)) || 1;
  // `raw_keys` passes an arbitrary string straight through; repeating it would
  // replay a whole scripted answer, so it always runs exactly once.
  const total = args?.action === "raw_keys" ? 1 : Math.min(Math.max(raw, 1), MAX_REPEAT);
  let performed = 0;
  // Whether the game actually advanced. A move into a wall is *accepted* but
  // costs no turn and changes nothing, so counting accepted keystrokes as
  // progress would report `repeated: 5/5` for a walk that never happened — and
  // that line is read by the model, which would believe it moved. `state_version`
  // cannot stand in for this: the engine re-renders either way.
  let progressed = false;
  let result = { accepted: false, reason: "no_attempt" };
  const started = instance.observe();
  let previous = started;
  let waiting = started.waiting_for;
  const hpAtStart = hpOf(started);
  // The player's pet follows them everywhere and is normally adjacent already,
  // so only a monster that *appears* during the walk is a reason to stop —
  // otherwise every stroll would abort after the first step.
  const threatAtStart = adjacentThreats(started);
  let stoppedFor = null;
  // Set when a key turned out to be cursor movement inside a position prompt
  // rather than a game action (see the check below).
  let cancelledPositionPick = false;
  let previousCursor = started.cursor ? { ...started.cursor } : null;
  for (let i = 0; i < total; i++) {
    signal.throwIfAborted();
    if (i > 0 && instance.observe().waiting_for !== "command") break;
    result = instance.act(args ?? {});
    if (!result.accepted) break;
    performed += 1;
    // Page through any --More-- the step produced and carry on walking: those
    // pages ask nothing, and stopping the walk for one would hand the model a
    // half-finished journey plus a page to dismiss. `yn`/`line`/`menu` still stop
    // it, because they carry a real choice.
    const paged = await settlePastPages(instance, signal, { maxPages: 4 });
    waiting = paged.waiting;
    // A move key pressed inside a position prompt (farlook `;`, travel `_`,
    // aiming) moves the map cursor rather than the character. The engine offers no
    // warning: getpos re-enters through the same shim as the command prompt
    // (`shim_nh_poskey`), and the cursor still sits on the hero when the prompt
    // opens, so nothing distinguishes the two until a key has been spent. Catch it
    // here -- no turn passed, the hero did not move, but the cursor did -- then
    // cancel the prompt. Reporting "the way is blocked" would be a lie, and
    // leaving it open would strand every later action.
    //
    // Only for `move`: a `raw_keys` digit is how a caller deliberately steers the
    // cursor inside a farlook, and cancelling that would make the feature unusable.
    // A `move` is never cursor steering -- it means "walk", which is the mistake.
    const nowPosition = instance.observe();
    const cursorMoved = !!nowPosition.cursor && !!previousCursor
      && (nowPosition.cursor.x !== previousCursor.x || nowPosition.cursor.y !== previousCursor.y);
    if (args?.action === "move" && cursorMoved && nowPosition.player && previous.player
      && nowPosition.player.x === previous.player.x && nowPosition.player.y === previous.player.y
      && nowPosition.turn === previous.turn) {
      // Undo the phantom step and back out of the prompt.
      performed -= 1;
      cancelledPositionPick = true;
      const escape = instance.act({ action: "raw_keys", keys: "\u001b" });
      if (escape.accepted) await settlePastPages(instance, signal, { maxPages: 2 });
      break;
    }
    previousCursor = nowPosition.cursor ? { ...nowPosition.cursor } : null;
    if (waiting !== "command") break;
    // Each repeat is another turn the monsters get, so a long walk must not
    // spend the whole count while the situation is changing. Stop the moment it
    // needs a decision and let the model re-read the board.
    const now = nowPosition;
    if (!now.alive) { stoppedFor = "the game ended"; break; }
    const hpNow = hpOf(now);
    if (hpNow !== null && hpAtStart !== null && hpNow < hpAtStart) {
      stoppedFor = `you were hurt (HP ${hpAtStart} -> ${hpNow})`;
      break;
    }
    // Repeating something the game ignores would burn the whole count on a
    // no-op and then claim the steps happened, so stop and name the reason.
    const turnAdvanced = now.turn !== previous.turn;
    const positionChanged = !!now.player && !!previous.player
      && (now.player.x !== previous.player.x || now.player.y !== previous.player.y);
    previous = now;
    if (turnAdvanced || positionChanged) progressed = true;
    if (!turnAdvanced && !positionChanged && i + 1 < total) {
      stoppedFor = args?.action === "move" && args?.direction
        ? (blockedHint(now, args.direction) ?? `you cannot move ${args.direction} — the way is blocked`)
        : "nothing changed — repeating it would have no effect";
      break;
    }
    if (i + 1 < total) {
      const fresh = [...adjacentThreats(now)].filter((glyph) => !threatAtStart.has(glyph));
      if (fresh.length) {
        stoppedFor = `a "${fresh.join('", "')}" came next to you`;
        break;
      }
    }
  }
  return { performed, total, progressed, clamped: raw > MAX_REPEAT, result, waiting, stoppedFor, cancelledPositionPick };
}

/** Render the tile set as a compact ASCII map, the way the player sees it. */
/**
 * The key that selects one menu entry.
 *
 * `accelerator` is the letter the engine accepts for this row (0 when the row
 * is a header or is not selectable); a handful of screens use the identifier
 * itself as the reply. Headers carry identifier 0 and are filtered out by the
 * caller.
 */
/**
 * The engine's `yn_function` choice string, spelled out as keys to send.
 *
 * The engine hands over its raw choice characters (`"12346789<>.s"` for a
 * direction), which read as a wall of symbols: the model spent rounds guessing
 * whether "north" or "8" goes into `nethack_respond`. Answering in the engine's
 * own alphabet is the only thing that works, so the accepted answers are listed
 * as literal replies.
 *
 * @returns lines to print under the question, or [] when there is nothing to add.
 */
export function answerLines(prompt) {
  const choices = String(prompt?.choices ?? "");
  const kind = prompt?.kind;
  if (kind === "direction" || /\bin what direction\?$/i.test(prompt?.question ?? "")) {
    // Measured on the real engine: those digits are accepted and the vi letters
    // (h/j/k/l) are refused, so only the digits are offered.
    return [
      "accepted answers: exactly ONE of these keys —",
      "  7=northwest 8=north 9=northeast 4=west 6=east 1=southwest 2=south 3=southeast, < = up stairs, > = down stairs, s = yourself (e.g. 'zap at myself'), Escape = cancel",
      "  The vi letters h/j/k/l are NOT accepted by this engine. 'north', 'east' and other words are not accepted either.",
    ];
  }
  if (kind === "menu" || kind === "pick") {
    return ["accepted answers: the letter shown in front of an option (or its number); Enter confirms a single pick, Escape cancels."];
  }
  if (kind === "line") {
    return ["accepted answers: any typed text; Enter submits it, Escape cancels."];
  }
  if (kind === "key") {
    return ["accepted answers: any single key; Enter or Escape usually cancels."];
  }
  if (kind === "more") {
    return ["accepted answers: space or Enter to continue (either works)."];
  }
  if (!choices) return [];
  // No special kind: fall back to the engine's own alphabet, one key per answer.
  return [`accepted answers: one of these keys: ${choices.split("").join(" ")}`];
}

function menuKey(item) {
  const acc = Number(item.accelerator);
  if (Number.isFinite(acc) && acc > 32 && acc < 127) return `[${String.fromCharCode(acc)}] `;
  return "";
}

function renderMap(observation) {
  if (observation.tiles.length === 0) return "(no map drawn yet)";
  const xs = observation.tiles.map((t) => t.x);
  const ys = observation.tiles.map((t) => t.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const at = new Map(observation.tiles.map((t) => [`${t.x},${t.y}`, t]));
  const lines = [];
  for (let y = minY; y <= maxY; y++) {
    let row = "";
    for (let x = minX; x <= maxX; x++) {
      const tile = at.get(`${x},${y}`);
      // A cell nothing has drawn is UNSEEN, not a wall. Leaving it blank made the
      // model read an unexplored gap as solid rock and announce a dead end it had
      // never checked (its "then my map must be wrong" reply was the second cost).
      row += tile ? tile.text : "?";
    }
    lines.push(row.replace(/ {2,}/g, " ").replace(/\s+$/, ""));
  }
  return lines.join("\n");
}

/** One-line key for `?`, spelled out where the map is printed. */
export const MAP_KEY = "'?' marks a cell you have NOT seen yet — it is unknown, not a wall. Only '#' is rock.";

/**
 * Which directions from the player have never been drawn.
 *
 * Stated next to the map so "is this a dead end?" is answerable from the output
 * instead of from a guess about blank space.
 */
export function unseenDirectionsLine(observation) {
  const player = observation?.player;
  if (!player) return null;
  const drawn = new Set((observation.tiles ?? []).map((t) => `${t.x},${t.y}`));
  const unseen = [];
  for (const [name, dx, dy] of COMPASS) {
    if (!drawn.has(`${player.x + dx},${player.y + dy}`)) unseen.push(name);
  }
  if (!unseen.length) return null;
  return `unseen beside you: ${unseen.join(", ")} — those cells could be open floor.`;
}

/**
 * Walk towards unexplored ground until something needs a decision.
 *
 * This is the one action that saves real time: choosing where to go and taking
 * every step in between costs one model round here instead of one per step, and a
 * round is a full LLM call. It stops the moment the game needs the model -- a
 * creature arrives, HP drops, the route is refused -- and says why, so the caller
 * re-reads the board instead of being handed a silently half-finished journey.
 *
 * The tile set accumulates every cell drawn for this level (measured: 85 walks
 * left all 70 start-map tiles in place), so the frontier is simply "a walkable cell
 * next to a cell that has never been drawn". Nothing is remembered between calls.
 */
async function explore(instance, signal, { budget = MAX_REPEAT, maxAttempts = 6 } = {}) {
  // The engine paints the map as it starts, so `command` can arrive with only a
  // few rows drawn. Planning on that would find no frontier and report the level as
  // finished, so wait for the map. `settlePastPages` also clears any --More--.
  await settlePastPages(instance, signal);
  const start = instance.observe();
  const hpAtStart = hpOf(start);
  const threatAtStart = adjacentThreats(start);
  let steps = 0;
  let targets = 0;
  let stoppedFor = null;
  let doors = [];
  // Cells the engine refused to let the character enter. Treated as walls, so a
  // dead end becomes "try somewhere else" instead of "the level is finished".
  const blocked = new Set();
  const exhausted = new Set();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (steps >= budget) { stoppedFor = "the step budget ran out"; break; }
    const observation = instance.observe();
    if (observation.ended) { stoppedFor = "the game ended"; break; }
    if (observation.waiting_for !== "command") break;
    // `position_verified` false means the `@` was not on the map and the position
    // came from the cursor instead. At the command prompt the cursor sits on the
    // character (measured 120/120 checks), and `walkRoute` confirms every single
    // step by whether the character actually moved, so proceeding is safe: a wrong
    // start shows up immediately as a refused step, not as silent bad movement.
    // Only a genuinely unknown position is fatal. The report says "unconfirmed".
    if (!observation.player) {
      stoppedFor = "the map is not drawn yet";
      break;
    }
    const grid = buildGrid(observation.tiles);
    const from = { x: observation.player.x, y: observation.player.y };
    const refused = (tile) => !tile || blocked.has(posKey(tile.x, tile.y));
    // The diagonal rule is pure geometry (what stands beside the step); whether the
    // destination is somewhere we want to go is a separate question, because a
    // creature does not make a diagonal geometrically illegal.
    const walkable = (tile) => isPassable(tile) && !refused(tile);
    const enterable = (tile) => !refused(tile) && isWalkThrough(tile);

    const planned = nearestFrontier(grid, from, { exhausted, passable: walkable, enterable });
    const routes = planned
      ? [planned]
      // No known target: step into the dark, which is all an unlit corridor offers.
      : unseenNeighbours(grid, from)
        .filter((n) => !blocked.has(posKey(n.x, n.y)))
        .map((n) => ({ target: { x: n.x, y: n.y }, path: [{ name: n.name, x: n.x, y: n.y }] }));
    if (routes.length === 0) {
      doors = reachableClosedDoors(grid, from);
      stoppedFor = doors.length
        ? `nowhere left to explore; ${doors.length} closed door${doors.length > 1 ? "s" : ""} seen`
        : "nowhere left to explore on this level that I can reach";
      break;
    }

    const route = routes[0];
    const before = observation;
    const outcome = await walkRoute(instance, route, {
      signal, budget, steps, hpAtStart, threatAtStart, blocked,
    });
    steps += outcome.steps;
    if (outcome.steps > 0) targets += 1;
    if (outcome.stoppedFor) { stoppedFor = outcome.stoppedFor; break; }
    // This route gave nothing: do not choose it again, or the next round would pace
    // back to the same place forever. A refused route is the same story.
    const gained = instance.observe().tile_count - before.tile_count;
    if (gained <= 0 || outcome.routeFailed) exhausted.add(posKey(route.target.x, route.target.y));
  }
  return { steps, targets, stoppedFor, doors, exhausted: exhausted.size, budget };
}

/**
 * Take one planned route, stopping the moment it needs a decision.
 *
 * Split out so `explore`'s bookkeeping (which routes are exhausted, how many steps
 * were really spent) stays readable. Returns the steps actually taken -- a refused
 * step and an attack both count as zero, because neither moved the character.
 */
async function walkRoute(instance, route, ctx) {
  const { signal, budget, hpAtStart, threatAtStart, blocked } = ctx;
  let steps = 0;
  let routeFailed = false;
  let stoppedFor = null;
  for (const step of route.path) {
    signal.throwIfAborted();
    if (ctx.steps + steps >= budget) { stoppedFor = "the step budget ran out"; break; }
    const current = instance.observe();
    if (current.waiting_for !== "command") break;
    const result = instance.act({ action: "move", direction: step.name });
    if (!result.accepted) {
      stoppedFor = `the engine refused a move ${step.name} (${result.reason})`;
      break;
    }
    const paged = await settlePastPages(instance, signal, { maxPages: 4 });
    if (paged.waiting !== "command") break;

    const now = instance.observe();
    if (!now.alive) { stoppedFor = "the game ended"; break; }
    if (!now.player) break;
    // A step counts only when the character actually moved. Stepping into a
    // creature ATTACKS: the turn passes and the character stays where it was, so
    // counting it would report ground covered that was never covered.
    const moved = now.player.x !== current.player.x || now.player.y !== current.player.y;
    if (!moved) {
      if (now.turn !== current.turn) {
        stoppedFor = `a step ${step.name} became an attack — something is standing there, and you did not move`;
        break;
      }
      blocked.add(posKey(step.x, step.y));
      routeFailed = true;
      break;
    }
    steps += 1;
    const hpNow = hpOf(now);
    if (hpNow !== null && hpAtStart !== null && hpNow < hpAtStart) {
      stoppedFor = `you were hurt (HP ${hpAtStart} -> ${hpNow})`;
      break;
    }
    const fresh = [...adjacentThreats(now)].filter((glyph) => !threatAtStart.has(glyph));
    if (fresh.length) {
      stoppedFor = `a "${fresh.join('", "')}" came next to you`;
      break;
    }
  }
  return { steps, routeFailed, stoppedFor };
}

/** Human/model-facing summary of the current game state. */
function describe(observation) {
  const s = observation.status;
  const parts = [
    `turn ${observation.turn}`,
    observation.player
      ? `at (${observation.player.x},${observation.player.y})${observation.position_verified === false ? " (unconfirmed: map not fully drawn yet, re-observe)" : ""}`
      : "position unknown",
  ];
  if (s.BL_HP) parts.push(`HP ${s.BL_HP}${s.BL_HPMAX ? `/${s.BL_HPMAX}` : ""}`);
  if (s.BL_AC) parts.push(`AC ${s.BL_AC}`);
  if (s.BL_GOLD) parts.push(`gold ${s.BL_GOLD}`);
  if (s.BL_LEVELDESC) parts.push(`on ${s.BL_LEVELDESC}`);
  if (observation.conditions.length) parts.push(`conditions: ${observation.conditions.join(", ")}`);
  return parts.join(" | ");
}

export function apply(ctx) {
  // Adopt a running engine immediately at load: a reload builds this module while
  // the old one's engine still runs, and claiming here (rather than on first use)
  // keeps the same game even if nothing calls it in between.
  const carried = engineSlot();
  if (carried.game) game = carried.game;

  ctx.inject(OPTIONAL, (child) => {
    // The tools are built here and handed to the routes only; they are never
    // registered globally, so no other conversation can see or call them.
    const definitions = registerTools(child);
    // One game session for this Host process, attached on first use. It holds
    // no engine of its own: the tools it lends the session call the same game.
    // Reused across reloads, so the session attached by the previous module is
    // still the one this module cancels and reports on.
    const slot = sessionSlot();
    slot.sessions?.dispose?.();
    const sessions = new GameSession(child, { definitions });
    slot.sessions = sessions;
    // Tools belong to this plugin lifetime; the separately retained engine
    // deliberately survives unload, but stale game-tool closures must not.
    child.effect(() => () => {
      if (sessions.sessionId && sessions.gameId) slot.binding = { sessionId: sessions.sessionId, gameId: sessions.gameId };
      sessions.dispose();
    });
    registerRoutes(child, definitions, sessions);
    const inspect = child.get("cordisInspect");
    if (inspect) child.effect(() => inspect.register({
      manifest: {
        id: "NetHack",
        description: "Read-only NetHack session binding diagnostics.",
        methods: [{ name: "sessionStatus", description: "Read the latest binding result and visible tool names.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          outputSchema: { description: "Game-owned binding diagnostics, without messages or credentials." } }],
      },
      async query(method) {
        if (method !== "sessionStatus") throw new Error("unknown diagnostic method");
        const active = sessions.live();
        const promptTools = active ? (await active.ctx.systemPrompt.assemble({ scope: active })).tools.map(tool => tool.name) : [];
        return { attached: !!sessions.sessionId, tools: sessions.tools(), promptTools, failure: sessions.lastFailure ?? null };
      },
    }));
  });

  // No teardown on purpose. The engine belongs to the Host process, not to this
  // plugin row, so unloading leaves it running: a reload is a disable plus an
  // enable, and stopping the engine in between would throw away a live game at
  // whatever turn the player had reached. Nothing leaks — the worker is
  // `unref`'d, so it never holds the process open, and the OS reclaims it on
  // exit. A successor module adopts the same instance.
}

/** Model-facing tools. Both this and the UI route call the same game methods. */
function registerTools(ctx) {
  const definitions = [];

  // Built here, REGISTERED LATER, and never globally. The definitions are
  // collected into a plain array; `GameSession.install()` registers them into the
  // one game session's own scope when that session exists. Registering them here
  // instead would put them in every conversation in the profile, which is the
  // opposite of the isolation this plugin promises: you start the game by opening
  // the panel, and the model that plays it is the one you talk to there.
  //
  // `ctx` is still required: every tool body calls `ensureGame(ctx)` to reach the
  // engine. Dropping the parameter while keeping the bodies is exactly the bug the
  // isolation test caught ("ctx is not defined" inside `nethack_observe`).
  const register = (definition) => { definitions.push(definition); };

  register({
    name: "nethack_observe",
    description:
      "Look at the current NetHack game: the visible map, player position and status, recent messages, and what the game is waiting for. This never advances game time, so it is always safe to call. Call it before acting to see the situation, and after acting to see what changed.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      exec.signal.throwIfAborted();
      const instance = ensureGame(ctx);
      // Observe should not hand the model a --More-- to dismiss either: page it
      // here so the text is visible in the same call.
      const paged = await settlePastPages(instance, exec.signal);
      const waiting = paged.waiting;
      const observation = instance.observe();
      const lines = [
        `runtime: ${observation.runtime_id ?? "starting"}`,
        `state_version: ${observation.state_version}`,
        describe(observation),
        `waiting_for: ${waiting}`,
      ];
      // State the pet outright instead of leaving it to glyph guesswork.
      const beside = neighboursLine(observation);
      if (beside) lines.push(beside);
      if (waiting === "command") {
        lines.push("", "You are at the command prompt and may act with nethack_act.");
      } else if (waiting === "position") {
        // The engine reports this as the command prompt, but direction keys move
        // a cursor rather than the character. Saying so prevents a "move" that
        // silently goes nowhere and leaves the turn unchanged.
        // The kind itself names the situation, so the sentence below is enough; a
        // position pick has no engine question to echo.
        lines.push(
          "",
          "The engine is asking you to pick a position on the map (travel/farlook/aim). Direction keys move the CURSOR, not the character, so nethack_act cannot move you here. Cancel it with nethack_respond (reply with a single Escape character), or confirm the current cursor position with nethack_respond (reply with a single Return character \"\\n\").",
        );
      } else if (waiting === "running") {
        // The engine is mid-step and will ask again shortly. Saying so glibly
        // would hide a genuinely stuck engine, so name the state explicitly.
        lines.push(
          "",
          observation.ended
            ? "The engine has stopped and will not ask again; this game is over. Start a new game to continue."
            : "The engine is mid-step (running) and has not asked for input yet. Call nethack_observe again to see if it settled; if it stays here, the engine is stuck.",
        );
      } else if (waiting === "ended") {
        lines.push("", "The game has ended and the engine has stopped. Start a new game to continue.");
      } else {
        lines.push("", `The game is asking for input (${waiting}). Answer it with nethack_respond.`);
        const prompt = observation.prompt;
        if (prompt?.question) lines.push(`question: ${prompt.question}`);
        if (prompt?.choices) lines.push(`raw choices from the engine: ${prompt.choices}`);
        lines.push(...answerLines(prompt));
        if (prompt?.title) lines.push(`menu: ${prompt.title}`);
        if (prompt?.how) lines.push(`menu kind: ${prompt.how}`);
        if (Array.isArray(prompt?.items) && prompt.items.length) {
          // Menu entries carry the key that selects them; without it the model
          // can read the options but cannot answer. Skip headers (identifier 0).
          const options = prompt.items.filter((i) => i.identifier !== 0).slice(0, 20);
          lines.push("options:", ...options.map((i) => `  ${menuKey(i)}${i.text}`));
        }
      }
      lines.push("", "Map:", renderMap(observation), MAP_KEY);
      // Say which sides are still dark, so "dead end" is answered by the output.
      const unseenHere = unseenDirectionsLine(observation);
      if (unseenHere) lines.push(unseenHere);
      if (observation.inventory?.length) {
        // The last inventory list the engine displayed. Headers group the items
        // below them and carry no reply key.
        lines.push("", "Carrying:",
          ...observation.inventory.slice(0, 30).map((item) =>
            item.header ? `  ${item.text}:` : `  ${item.letter ? `[${item.letter}] ` : ""}${item.text}`));
      }
      if (observation.messages.length) {
        // Only lines the model has not already been given: the boot message used
        // to be re-sent on every single observe until it aged out.
        const fresh = newMessages(instance, observation);
        if (fresh.length) {
          lines.push("", "New messages:", ...fresh.slice(-10).map((m) => `  ${m}`));
        }
      }
      return lines.join("\n");
    },
  });

  register({
    name: "nethack_act",
    description:
      "Perform a NetHack game action as the player character. Only valid when nethack_observe reports waiting_for: command. Moving into a wall, a monster, or another creature does not advance the turn; the result message explains what happened.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["move", "wait", "pickup", "descend", "ascend", "open", "search", "explore", "raw_keys"],
          description:
            "move: step in a direction. explore: walk to unexplored ground automatically, choosing the route and taking every step — use this instead of a long series of move calls when you want to see more of the level. wait: rest one turn ('.'). pickup: pick up what you are standing on. descend/ascend: use the stairs under you. open: ask which adjacent door to open; then answer the direction prompt. search: search for hidden doors and traps. raw_keys: send literal NetHack keystrokes for anything not covered here.",
        },
        direction: {
          type: "string",
          enum: Object.keys(DIRECTIONS),
          description: "Required for action: move.",
        },
        count: {
          type: "integer",
          description: `How much to do in one call instead of calling once per step. 1-${MAX_REPEAT}. For move, wait, search and open it repeats that action, default 1, e.g. {"action":"move","direction":"north","count":8}. For explore it is the step budget, default ${MAX_REPEAT}. Any action stops early when the engine asks a question, when you are hurt, when the game ends, when a step does not land (a move into a wall is accepted but costs no turn), or when a monster comes next to you, so it will not walk you blindly into trouble. raw_keys is never repeated.`,
        },
        keys: {
          type: "string",
          description: "Required for action: raw_keys. Literal keys, e.g. \"i\" for inventory.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      exec.signal.throwIfAborted();
      const instance = ensureGame(ctx);
      await settle(instance);
      const before = instance.observe();
      if (before.waiting_for === "position") {
        return "Action rejected (engine_in_position_prompt). The engine is asking you to pick a position on the map, so direction keys would move a cursor instead of the character. Cancel it with nethack_respond (reply with a single Escape character) and then act.";
      }
      if (before.waiting_for !== "command") {
        return `Action rejected (engine_not_at_command_prompt:${before.waiting_for}). The engine is at "${before.waiting_for}", not at the command prompt. Call nethack_observe to see what it wants.`;
      }
      // `explore` chooses its own route, so it does not go through the single
      // action dispatch: it plans on the accumulated map and takes every step.
      if (args?.action === "explore") {
        const plan = await explore(instance, exec.signal, { budget: exploreBudget(args?.count) });
        const paged = await settlePastPages(instance, exec.signal);
        const state = instance.observe();
        const lines = [
          describe(state),
          `waiting_for: ${paged.waiting}`,
          `explored: ${plan.steps} step(s) toward ${plan.targets} area(s)`,
        ];
        if (plan.stoppedFor) {
          lines.push("", `Exploration stopped: ${plan.stoppedFor}. Decide what to do next.`);
        } else if (plan.steps >= plan.budget) {
          lines.push("", `The step budget (${plan.budget}) ran out. Call explore again to keep going.`);
        } else {
          // Say which limit was hit. Claiming the step budget ran out when the
          // area limit did would send the model looking for steps that are not
          // the problem.
          lines.push("", "Exploration made as much progress as it could this call. Call explore again, or try opening a door or a different direction.");
        }
        if (plan.doors?.length) {
          lines.push("", `Closed doors seen at ${plan.doors.slice(0, 6).map((d) => `(${d.x},${d.y})`).join(", ")}. Face one and use action "open" to get through.`);
        }
        const fresh = newMessages(instance, state);
        if (fresh.length) lines.push("", "New messages:", ...fresh.slice(-10).map((m) => `  ${m}`));
        lines.push("", "Map:", renderMap(state), MAP_KEY);
        const unseenHere = unseenDirectionsLine(state);
        if (unseenHere) lines.push(unseenHere);
        return lines.join("\n");
      }
      const run = await actRepeated(instance, args ?? {}, exec.signal);
      // Handled before the "performed === 0" branch: the step was undone on
      // purpose, so this is not a rejection — it is a prompt that has been dealt
      // with, and the model needs to be told that rather than sent to observe.
      if (run.cancelledPositionPick) {
        const state = instance.observe();
        return [
          "Your key did not move you: the engine was asking for a position on the map (travel/farlook/aim), so direction keys move a cursor instead of the character. That prompt has now been cancelled, and nothing changed.",
          describe(state),
          `waiting_for: ${state.waiting_for}`,
          "",
          "Map:",
          renderMap(state),
          MAP_KEY,
        ].join("\n");
      }
      if (run.performed === 0) {
        // `reason` is normally set by act(), but a result without one must not
        // reach the model as the literal word "undefined".
        const why = run.result?.reason ?? (run.result?.accepted ? "no_step_taken" : "not_accepted");
        if (why === "engine_in_position_prompt") {
          return "Action rejected (engine_in_position_prompt). The engine is asking for a position on the map, so direction keys would move a cursor instead of the character. Call nethack_observe and cancel it with nethack_respond.";
        }
        return `Action rejected (${why}). The engine is at "${before.waiting_for}", not at the command prompt. Call nethack_observe to see what it wants.`;
      }
      // Page through any --More-- the action produced instead of spending a round
      // on it; `run.stoppedFor` still explains why a long walk halted.
      const paged = await settlePastPages(instance, exec.signal);
      let waiting = paged.waiting;
      // The model acts through these tools, so a pack change it caused must show
      // up in the panel too. Same rule as the panel route: only item actions, and
      // only once the engine is parked at the command prompt again.
      if (waiting === "command" && packMayHaveChanged(args, instance.observe())) {
        await refreshPack(instance);
        waiting = instance.observe().waiting_for;
      }
      const after = instance.observe();
      const lines = [
        describe(after),
        `waiting_for: ${waiting}`,
        `state_version: ${before.state_version} -> ${after.state_version}`,
      ];
      if (paged.pages > 0) {
        lines.push(`auto-paged ${paged.pages} --More-- page(s); the text is below.`);
      }
      if (run.total > 1) {
        lines.push(`repeated: ${run.performed}/${run.total}${run.clamped ? ` (count clamped to ${MAX_REPEAT})` : ""}`);
      }
      // No turn passed and the character did not move: say so outright. The
      // count alone would read as "walked 5 tiles" to the model. Name what is
      // standing there when it is a creature: a pet in the way is a swap, not a
      // wall, and callers used to be told "blocked" and give up.
      if (run.performed > 0 && !run.progressed && !run.stoppedFor
        && args?.action === "move" && args?.direction) {
        const hint = blockedHint(before, args.direction);
        lines.push("", hint
          ? `You did not move ${args.direction}. ${hint}`
          : `You did not move: the way ${args.direction} is blocked.`);
      }
      if (run.performed < run.total) {
        lines.push(
          "",
          run.stoppedFor
            ? `The repeat stopped after ${run.performed} of ${run.total}: ${run.stoppedFor}. Decide what to do next.`
            : `The repeat stopped after ${run.performed} of ${run.total}: the engine is now at "${waiting}" and needs an answer before more game actions.`,
        );
      }
      // Only what is new since the last tool call: re-sending the same lines every
      // round wastes attention and makes stale text look like fresh news.
      if (after.prompt?.question) lines.push(`question: ${after.prompt.question}`);
      if (after.prompt?.choices) lines.push(`raw choices from the engine: ${after.prompt.choices}`);
      if (after.prompt) lines.push(...answerLines(after.prompt));
      const fresh = newMessages(instance, after);
      const recent = (fresh.length ? fresh : after.messages.slice(-3));
      if (recent.length) {
        lines.push("", ...recent.slice(-8).map((m) => `  ${m}`));
      }
      const recentText = recent.join(" ").toLowerCase();
      if (/\b(killed|die|died|death)\b/.test(recentText) && !after.alive) lines.push("", "The game has ended.");
      lines.push("", "Map:", renderMap(after), MAP_KEY);
      return lines.join("\n");
    },
  });

  register({
    name: "nethack_respond",
    description:
      "Answer a NetHack prompt that is not the command prompt: a yes/no question, a line of text, a menu, or a position pick (travel/farlook). Only valid when nethack_observe reports a waiting_for other than command. For a menu, reply with the option's key (letter or digit). For a position pick, reply with a single Escape character to cancel. Plain --More-- pages are dismissed automatically and never need a reply.",
    parameters: {
      type: "object",
      properties: {
        reply: {
          type: "string",
          description: "For more/--More--: send a single space (or an empty string). For yes/no: \"y\" or \"n\". For a line: the text. For a menu: the option key. For a direction: exactly one numpad key (north=8, south=2, west=4, east=6, NW=7, NE=9, SW=1, SE=3; up=<, down=>, self=.); Escape cancels. Never use vi letters or direction words.",
        },
      },
      required: ["reply"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      exec.signal.throwIfAborted();
      const instance = ensureGame(ctx);
      const before = instance.observe();
      // Also protect adopted pre-update game instances whose worker labels a
      // direction prompt as yn. Reject BEFORE any characters enter the key queue.
      if ((before.waiting_for === "direction" || (before.waiting_for === "yn" && /\bin what direction\?$/i.test(before.prompt?.question ?? "")))
        && !(typeof args?.reply === "string" && /^[12346789<>.s\x1b]$/.test(args.reply))) {
        throw new Error("invalid_direction_reply: use ONE numpad key: N=8 S=2 W=4 E=6 NW=7 NE=9 SW=1 SE=3, up=< down=> self=.; Escape cancels. No letters or direction words.");
      }
      const result = instance.respond(args?.reply);
      if (!result.accepted) {
        // Name the actual reason: "already at the command prompt" is only one of
        // them, and reporting it for an ended engine sends the model in circles.
        if (result.reason === "engine_ended") {
          return "Reply rejected (engine_ended). The engine has stopped and will not ask again; this game is over. Start a new game to continue.";
        }
        if (result.reason === "empty_reply") {
          return "Reply rejected (empty_reply). Call nethack_observe to see what the engine wants.";
        }
        if (result.reason === "engine_at_command_prompt") {
          return "Reply rejected (engine_at_command_prompt). The engine is already at the command prompt; use nethack_act.";
        }
        return `Reply rejected (${result.reason}). Call nethack_observe to see what the engine wants.`;
      }
      // Page any --More-- the answer produced BEFORE observing, so the reported
      // state is the settled one rather than a snapshot of a page being shown.
      const paged = await settlePastPages(instance, exec.signal);
      const waiting = paged.waiting;
      const after = instance.observe();
      const lines = [
        `Answered ${JSON.stringify(args?.reply ?? "")} (was ${before.waiting_for}).`,
        `now waiting_for: ${waiting}`,
        describe(after),
      ];
      if (paged.pages > 0) {
        lines.push(`auto-paged ${paged.pages} --More-- page(s); the text is below.`);
      }
      if (after.prompt?.question) lines.push(`question: ${after.prompt.question}`);
      if (after.prompt?.choices) lines.push(`raw choices from the engine: ${after.prompt.choices}`);
      if (after.prompt) lines.push(...answerLines(after.prompt));
      const fresh = newMessages(instance, after);
      if (fresh.length) lines.push("", "New messages:", ...fresh.slice(-10).map((m) => `  ${m}`));
      lines.push("", "Map:", renderMap(after), MAP_KEY);
      return lines.join("\n");
    },
  });

  register({
    name: "nethack_restart",
    description:
      "Abandon the current game and start a brand-new one from turn 1. Use this only when the game has ended or the engine is stuck: if nethack_observe reports waiting_for: ended, or stays at running across two calls, no other action can make progress. This discards all progress and cannot be undone.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    isConcurrencySafe: () => false,
    execute: async (_args, exec) => {
      exec.signal.throwIfAborted();
      // A new game is a new conversation: the next attach names a new session,
      // and forgetting the old one here means nothing can keep acting on a
      // session that belongs to a game nobody can see any more. The session
      // itself is left alone -- it is the person's transcript of that game.
      const instance = await restartGame(ctx);
      const waiting = await settle(instance, 15000);
      const observation = instance.observe();
      return [
        "Started a new game.",
        describe(observation),
        `waiting_for: ${waiting}`,
        ...(waiting === "command" ? ["", "You are at the command prompt and may act with nethack_act."] : []),
        "",
        "Map:",
        renderMap(observation),
        MAP_KEY,
      ].join("\n");
    },
  });

  return definitions;
}

/**
 * Throw away the current engine and boot a fresh game.
 *
 * The only way out of a dead or wedged engine: `nethack_observe` can report the
 * state but nothing else can clear it, because the WASM `main()` never returns
 * and a stuck worker cannot be nudged. The old worker is terminated and the
 * process-wide slot is replaced, so a later reload adopts the new game.
 */
async function restartGame(ctx) {
  const currentSession = sessionSlot().sessions;
  if (currentSession?.sessionId) currentSession.cancel(currentSession.sessionId);
  detachGameSession(ctx);
  const slot = engineSlot();
  const previous = slot.game ?? game;
  if (previous) {
    try {
      await previous.stop();
    } catch { /* a worker that cannot be terminated must not block a restart */ }
  }
  slot.game = null;
  game = null;
  return ensureGame(ctx);
}

/**
 * Package-owned routes backing the Web UI panel, inside the auth fence.
 *
 * Exported for the tests: the route table is a contract with the panel, and the
 * session route's accept/reject behaviour is exactly the part that cannot be
 * observed from the UI until it is wrong.
 */
export function registerRoutes(ctx, toolDefinitions = [], sessions) {
  if (!ctx.connection?.fetch) return;
  const instance = () => ensureGame(ctx);

  const json = (body, status = 200) => Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

  /**
   * Which LLM route the panel's own conversation would use, and nothing else.
   *
   * Deliberately reports booleans and the provider/model pair only: it answers
   * "is the chat wired up?" without exposing credentials.
   */
  ctx.connection.fetch.register({
    path: ROUTE_DIAG,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async () => {
      const llm = ctx.get("llm");
      const selection = ctx.get("agentDefaultModel")?.currentSelection?.() ?? null;
      return json({
        hasLlm: typeof llm?.stream === "function",
        hasSelection: !!selection,
        provider: selection?.provider ?? null,
        model: selection?.model ?? null,
        toolCount: toolDefinitions.length,
        gameSession: {
          session: sessions.sessionId ?? null,
          game: sessions.gameId ?? null,
          tools: sessions.tools(),
        },
      });
    },
  });

  /**
   * Bind a DSH Session to the game.
   *
   * The panel creates the Session (so its own catalog knows the identity and
   * can retain it), then posts the id here. This route attaches the game's
   * three tools to that session's agent scope and returns the tool names the
   * session actually ended up with — the panel shows them, which is how the
   * isolation is verified from the outside instead of assumed.
   *
   * `{type:"cancel"}` aborts whatever that session is doing, which is what the
   * panel's Stop button posts.
   */
  ctx.connection.fetch.register({
    path: ROUTE_SESSION,
    methods: ["GET", "POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      if (request.method === "GET") {
        const gameId = new URL(request.url).searchParams.get("game_id");
        const saved = sessionSlot().binding;
        return json({ session_id: saved?.gameId === gameId ? saved.sessionId : null });
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      const sessionId = typeof body?.session_id === "string" ? body.session_id.trim() : "";
      if (!sessionId) return json({ error: "missing_session_id" }, 400);
      if (body?.type === "cancel") {
        return json({ cancelled: sessions.cancel(sessionId) });
      }
      if (body?.type === "detach") {
        sessions.detach();
        return json({ detached: true });
      }
      const gameId = body?.game_id === undefined ? undefined : String(body.game_id);
      const result = sessions.attach(sessionId, gameId);
      if (!result.error) sessionSlot().binding = { sessionId, gameId };
      return json(result, result.error === undefined ? 200 : 409);
    },
  });

  /**
   * The single read operation the panel polls.
   *
   * The settle here is deliberately short: a poll is a snapshot, and waiting
   * for a turn to finish before answering makes the panel lag behind the
   * engine. A caller that acts waits properly on the action route instead.
   */
  const readState = async () => {
    const game0 = instance();
    // Clear pending `--More--` pages before reporting. The opening narrative is
    // longer than one screen, so a freshly booted game sits at `waiting_for:
    // "more"` until SOMETHING pages through it. The tools did that; this route
    // did not, so the panel reported "more" forever and the game looked stuck on
    // "Starting NetHack…". Paging here makes the panel self-sufficient.
    //
    // Bounded and best-effort: a `more` that will not clear must still return a
    // state rather than hang the poll.
    let waiting = await settle(game0, 250);
    for (let pages = 0; waiting === "more" && pages < 12; pages += 1) {
      const result = game0.respond("");
      if (!result.accepted) break;
      waiting = await settle(game0, 250);
    }
    const observation = game0.observe();
    return {
      ...observation,
      // Stated explicitly rather than trusted from `observe()`: a game adopted
      // from a pre-reload module reports no `game_id`, and the panel would then
      // have nothing to key its archive by. `ensureGame` has just backfilled it.
      game_id: adoptGameId(game0, engineSlot()),
      waiting_for: waiting,
      map: renderMap(observation),
      summary: describe(observation),
    };
  };

  ctx.connection.fetch.register({
    path: ROUTE_STATE,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async () => json(await readState()),
  });

  // The panel's action path and the `nethack_act`/`nethack_respond` tools
  // call the same NetHackGame methods; no operation logic is duplicated.
  ctx.connection.fetch.register({
    path: ROUTE_ACTION,
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      if (body?.action === "restart") {
        await restartGame(ctx);
        return json(await readState());
      }
      const game0 = instance();
      await settle(game0, 2000);
      // `explore` picks its own route and takes many steps, so it is not one
      // keystroke and cannot go through `act()`. Both callers use this same helper
      // rather than each growing their own loop.
      if (body?.action === "explore" && body?.kind !== "respond") {
        const plan = await explore(game0, request.signal ?? new AbortController().signal, {
          budget: exploreBudget(body?.count),
        });
        const waiting = await settle(game0, 3000);
        const observation = game0.observe();
        return json({
          ...observation,
          waiting_for: waiting,
          explored: { steps: plan.steps, areas: plan.targets, stopped_for: plan.stoppedFor },
          map: renderMap(observation),
          summary: describe(observation),
        });
      }
      const result = body?.kind === "respond"
        ? game0.respond(body.reply ?? " ")
        : game0.act(body ?? {});
      if (!result.accepted) return json({ error: result.reason }, 409);
      let waiting = await settle(game0, 3000);
      // Refresh only after the action has settled: a refresh during a still-running
      // step would either be swallowed or land on a prompt nobody saw.
      if (waiting === "command" && packMayHaveChanged(body, game0.observe())) {
        await refreshPack(game0);
        waiting = game0.observe().waiting_for;
      }
      const observation = game0.observe();
      return json({
        ...observation,
        waiting_for: waiting,
        map: renderMap(observation),
        summary: describe(observation),
      });
    },
  });
}