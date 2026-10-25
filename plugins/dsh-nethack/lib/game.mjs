// NetHack game state owner for the Host plugin.
//
// One engine worker per game session. The worker owns the WASM engine; this
// class owns the observable game state, the request/response bookkeeping, and
// the semantics that both the model tools and the Web UI panel call.

import { Worker } from "node:worker_threads";

/**
 * number_pad:1 maps directions to the digit keys, not to vi's hjkl
 * (verified: hjkl yields "cmdassist: Invalid direction key!").
 */
export const DIRECTIONS = {
  north: "8", northeast: "9", east: "6", southeast: "3",
  south: "2", southwest: "1", west: "4", northwest: "7",
};

/**
 * A fresh identity for each game.
 *
 * `runtime_id` names the engine build, not the game, so it cannot tell one game
 * from the next; the panel needs that distinction to keep each game's
 * conversation separate and to find it again later. Minted per instance, so
 * `nethack_restart` (which builds a new instance) starts a new identity, while a
 * plugin reload (which adopts the running instance) keeps the old one.
 */
export function mintGameId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid === "string") return uuid;
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The `MG_PET` bit of a glyph's `special` flags (NetHack `display.h`).
 *
 * Verified against the engine by watching every non-zero-`special` tile across a
 * whole game: the bit is set on the player's own pet and cleared on hostile
 * monsters, and it does not depend on the `hilite_pet` option (that only changes
 * how the pet is coloured), so it identifies a pet even with default options.
 */
export const MG_PET = 0x08;

/** Terrain inferred from the tty glyph the engine drew. */
function terrainOf(ttyChar) {
  switch (ttyChar) {
    case 0x20: case 0xb7: return "floor";        // space / middle dot
    case 0x2d: case 0x7c: return "wall";         // - |
    case 0x2b: return "door_closed";             // +
    case 0x2e: return "floor";                   // .
    case 0x23: return "corridor";                // #
    case 0x3e: return "stairs_down";             // >
    case 0x3c: return "stairs_up";               // <
    case 0x7b: return "water";                   // {
    case 0xa0: return "unknown";
    default: return "other";
  }
}

/** A readable one-character rendering of a glyph, when it is printable. */
function glyphText(ttyChar) {
  if (ttyChar >= 0x21 && ttyChar <= 0x7e) return String.fromCharCode(ttyChar);
  if (ttyChar === 0x20) return " ";
  return "?";
}

export class NetHackGame {
  #worker = null;
  #pending = null;          // { requestId, resolve }
  #inputQueue = [];         // answers to deliver, in order
  #nextRequest = 1;
  #listeners = new Set();
  #stateVersion = 0;
  #startedAt = null;
  #reportedMessages = 0;

  constructor({ moduleUrl, name = "NHChat", onLog = () => {} }) {
    this.moduleUrl = moduleUrl;
    this.name = name;
    this.onLog = onLog;
    this.status = {};
    this.conditions = [];
    this.tiles = new Map();      // "x,y" -> { x, y, tty, terrain, text }
    this.player = null;          // { x, y } — the character, from the "@" glyph
    // Where the engine last put the map cursor. This is NOT the character: the
    // engine parks the cursor on the hero at the command prompt, but `getpos`
    // (travel `_`, farlook `;`, aiming) moves the cursor while the hero stands
    // still. Kept apart from `player` so a position prompt is detectable.
    this.cursor = null;          // { x, y }
    // False when `player` is the cursor fallback rather than read off the map.
    this.positionVerified = false;
    this.messages = [];
    this.inventory = [];         // [{ text, letter }] — last PICK_NONE list shown
    this.input = { kind: "starting" };
    this.runtimeId = null;
    // Identity of *this game*, as opposed to `runtimeId` (the engine build).
    // Stable for the instance's whole life, so it survives a plugin reload that
    // adopts the instance, and changes when a new game is started.
    this.gameId = mintGameId();
    this.alive = false;
    // Set once the engine has finished tearing down. Kept apart from `alive`
    // because `alive` is false before the engine starts, too: only `ended`
    // means "this game is over and its worker will never ask again".
    this.ended = false;
    this.turn = 0;
  }

  // ---- lifecycle ----------------------------------------------------------

  start() {
    if (this.#worker) return;
    this.#worker = new Worker(new URL("./engine-worker.mjs", import.meta.url), {
      workerData: { moduleUrl: this.moduleUrl, name: this.name },
    });
    this.#worker.on("message", (msg) => this.#onMessage(msg));
    this.#worker.on("error", (error) => {
      this.onLog(`engine worker error: ${error?.message ?? error}`);
      this.#publish({ type: "error", message: String(error?.message ?? error) });
    });
    this.#worker.unref?.();
  }

  async stop() {
    const worker = this.#worker;
    this.#worker = null;
    this.#pending = null;
    this.alive = false;
    if (worker) await worker.terminate();
  }

  get running() { return this.alive; }
  get stateVersion() { return this.#stateVersion; }
  get uptimeMs() { return this.#startedAt ? Date.now() - this.#startedAt : 0; }

  // ---- observation --------------------------------------------------------

  /**
   * Whether the engine is asking the player to pick a position on the map.
   *
   * `getpos` (travel `_`, farlook `;`, aiming a wand) leaves the engine at what
   * looks like the command prompt — it takes the same key entry path — but a
   * direction key moves the CURSOR, not the character, and costs no turn. The
   * only reliable signal is that the cursor has left the hero: measured over 120
   * command prompts the cursor matched the "@" every single time, while during a
   * farlook it wandered several tiles away and the "@" stayed put. Reporting this
   * as `command` (as the engine does) invites a move that silently goes nowhere.
   */
  #inPositionPrompt() {
    if (this.input.kind !== "command") return false;
    if (!this.cursor || !this.player) return false;
    return this.cursor.x !== this.player.x || this.cursor.y !== this.player.y;
  }

  /**
   * Recompute the character's position from the map's "@" glyph.
   *
   * The cursor cannot be trusted (see `#inPositionPrompt`), so the hero is read
   * off the map instead. Human monsters also draw as "@", so when several are on
   * screen: prefer the one the engine just parked the cursor on (authoritative at
   * the command prompt), otherwise the one nearest the previous position — the
   * character cannot have moved while the cursor is off exploring.
   */
  #refreshPlayer() {
    const ats = [];
    for (const tile of this.tiles.values()) if (tile.text === "@") ats.push(tile);
    if (ats.length === 0) {
      // Before the map is first painted there is no "@" to read, and reporting a
      // null position would break every consumer that had always had one. Fall
      // back to the cursor: it sits on the character at the command prompt, so it
      // is right until the map arrives. A position prompt is not detected while
      // the fallback is in use, but one cannot be reached before the map is drawn.
      //
      // The map really can be missing here: the engine paints it as it starts, so
      // a caller can race it and see three rows and no character. `position_verified`
      // exists so a caller can tell this guess from a read of the map and wait.
      if (this.cursor) {
        this.player = { x: this.cursor.x, y: this.cursor.y };
        this.positionVerified = false;
      }
      return;
    }
    if (ats.length === 1) {
      this.player = { x: ats[0].x, y: ats[0].y };
      this.positionVerified = true;
      return;
    }
    const onCursor = this.cursor
      ? ats.find((t) => t.x === this.cursor.x && t.y === this.cursor.y)
      : null;
    const target = onCursor ?? (() => {
      const previous = this.player;
      if (!previous) return ats[0];
      let best = ats[0], bestDistance = Infinity;
      for (const tile of ats) {
        const distance = Math.abs(tile.x - previous.x) + Math.abs(tile.y - previous.y);
        if (distance < bestDistance) { bestDistance = distance; best = tile; }
      }
      return best;
    })();
    this.player = { x: target.x, y: target.y };
    this.positionVerified = true;
  }

  /**
   * Show the pack without changing the game.
   *
   * NetHack's pack is the in-game inventory screen: the engine only re-renders it
   * when something puts it on screen, which is why the panel's pack used to freeze
   * until someone pressed `i`. Sending `i` re-renders it and costs no turn.
   *
   * The display arrives as a PICK_NONE menu, which this class treats as the pack
   * itself and never as a prompt (see `#applyEvent` "menu"), so it is only sent
   * while the engine is parked at the command prompt.
   *
   * @returns true when `i` was sent.
   */
  refreshInventory() {
    if (this.input.kind !== "command" || this.ended || this.#inPositionPrompt()) return false;
    // The command prompt's request stays intact: the engine needs it to ask again.
    // Taking it here made the engine unable to ask, so the very next key was lost.
    return this.sendKeys("i", "refresh").accepted === true;
  }

  /**
   * Messages the caller has not been shown yet, advancing the cursor.
   *
   * Tools report only what is new, so the birth message is not repeated in every
   * round's output. Explicitly opt-in: the panel polls `observe()` constantly and
   * must never consume anything.
   */
  takeNewMessages() {
    const fresh = this.messages.slice(this.#reportedMessages);
    this.#reportedMessages = this.messages.length;
    return fresh;
  }

  /** Stable snapshot. Never advances the game (the engine is parked). */
  observe() {
    const tiles = [...this.tiles.values()];
    const rows = {};
    for (const tile of tiles) (rows[tile.y] ??= []).push(tile);
    const positionPrompt = this.#inPositionPrompt();
    return {
      runtime_id: this.runtimeId,
      // The game's own identity, unlike `runtime_id`, which is the engine build.
      // The panel stores each game's conversation under this id. `started_at`
      // reuses `#startedAt` (the same clock behind `uptimeMs`) rather than
      // keeping a second copy that could drift.
      game_id: this.gameId,
      started_at: this.#startedAt,
      state_version: this.#stateVersion,
      alive: this.alive,
      // True once the engine has stopped: `waiting_for` is then terminal and a
      // caller must not wait on it. See #onMessage "ended".
      ended: this.ended,
      turn: this.turn,
      player: this.player ? { ...this.player } : null,
      // Whether `player` was read from the map's "@" (true) or is the cursor
      // fallback used before the map is painted (false).
      position_verified: this.positionVerified,
      // The raw map cursor, kept separate from `player` so a consumer can see the
      // difference that identifies a position prompt.
      cursor: this.cursor ? { ...this.cursor } : null,
      status: { ...this.status },
      conditions: [...this.conditions],
      tile_count: tiles.length,
      tiles,
      messages: this.messages.slice(-12),
      inventory: this.inventory.map((item) => ({ ...item })),
      // A position prompt takes the same key path as the command prompt, so the
      // engine reports it as one; `position` is this layer's correction.
      waiting_for: positionPrompt ? "position" : this.input.kind,
      // The prompt fields (question, title, items, choices) are carried flat on
      // `input`, so consumers read `prompt.question` rather than a nested copy.
      // No `question` here on purpose: the panel shows `prompt.question` verbatim
      // ahead of its own localised label, so an English sentence baked in here
      // would be displayed untranslated. Leaving it out lets each consumer supply
      // its own wording.
      prompt: positionPrompt
        ? { kind: "position" }
        : this.input.kind === "command" ? null : { ...this.input },
    };
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #publish(change) {
    this.#stateVersion += 1;
    for (const listener of this.#listeners) {
      try { listener(change, this.observe()); } catch { /* a view must not break the game */ }
    }
  }

  // ---- input --------------------------------------------------------------

  /**
   * Send raw keystrokes as the answer to the engine's current prompt.
   * Returns immediately; the effect is observable through `observe()`.
   */
  sendKeys(text, source = "human") {
    if (!this.#worker) return { accepted: false, reason: "no_game" };
    if (this.input.kind === "starting") return { accepted: false, reason: "engine_starting" };
    // A dead engine has no pending request, so a queued key would never be read
    // yet the call would still report success.
    if (this.ended) return { accepted: false, reason: "engine_ended" };
    const value = String(text);
    if (value.length === 0) return { accepted: false, reason: "empty_input" };
    this.#inputQueue.push({ value, source, at: ++this.#nextRequest });
    this.#flushInput();
    return { accepted: true, queued: this.#inputQueue.length, state_version: this.#stateVersion };
  }

  /**
   * One semantic action. Directional moves share one code path.
   *
   * Game actions are only meaningful at the command prompt: the engine also
   * asks `more`/`yn`/`line`/`menu` questions, and a movement key delivered to
   * one of those would be silently swallowed. Callers route those through
   * `respond()` instead.
   */
  act(action) {
    if (this.input.kind !== "command") {
      return { accepted: false, reason: `engine_not_at_command_prompt:${this.input.kind}` };
    }
    // A position prompt looks like the command prompt but eats direction keys as
    // cursor movement, so a `move` there would look like a step that never
    // happened. Only literal keys may pass (ESC to cancel, Enter to confirm).
    if (this.#inPositionPrompt() && action?.action !== "raw_keys") {
      return { accepted: false, reason: "engine_in_position_prompt" };
    }
    // Exactly one keystroke per call, deliberately. A repeated string would be
    // buffered inside the worker (`takeKeys` keeps the tail of a multi-character
    // answer) and those leftovers are handed to whatever prompt comes next
    // BEFORE the host is asked — so a stray key would answer a `--More--` or a
    // yes/no question nobody saw. Repetition is sequenced by the caller.
    switch (action?.action) {
      case "move": {
        const key = DIRECTIONS[action.direction];
        if (!key) return { accepted: false, reason: `unknown_direction:${action.direction}` };
        return this.sendKeys(key, "model");
      }
      case "wait": return this.sendKeys(".", "model");
      case "pickup": return this.sendKeys(",", "model");
      case "descend": return this.sendKeys(">", "model");
      case "ascend": return this.sendKeys("<", "model");
      case "open": return this.sendKeys("o", "model");
      case "search": return this.sendKeys("s", "model");
      case "raw_keys": {
        if (typeof action.keys !== "string") return { accepted: false, reason: "raw_keys_requires_keys" };
        return this.sendKeys(action.keys, "model");
      }
      default: return { accepted: false, reason: `unknown_action:${action?.action}` };
    }
  }

  /**
   * Answer a non-command prompt: `direction`, `more`, `yn`, `line`, `menu` or `key`.
   * Kept separate from `act()` so a movement key is never spent on a question.
   */
  respond(reply) {
    // A position prompt takes the same pending key request as the command
    // prompt; without this exception the only way out of a farlook would be
    // impossible, because every reply would be refused as "already at command".
    if (this.input.kind === "command" && !this.#inPositionPrompt()) {
      return { accepted: false, reason: "engine_at_command_prompt" };
    }
    if (this.input.kind === "starting") return { accepted: false, reason: "engine_starting" };
    if (this.ended) return { accepted: false, reason: "engine_ended" };
    // An empty answer is not a rejection: `""` is what the model sends for a
    // `--More--` page, and an argument that is only whitespace arrives here
    // trimmed to "". Both mean "press space", which is the engine's own default
    // for an empty reply, so send that instead of refusing.
    const value = String(reply ?? "") || " ";
    // A direction consumes ONE key. Passing "north" verbatim made the engine
    // reject 'n', then execute the remaining 'orth' as unrelated commands. Reject
    // rather than guess/translate: 'h' is not west in number_pad:1, while 's'
    // means self, not south. Escape is the explicit cancellation key.
    if (this.input.kind === "direction" && !/^[12346789<>.s\u001b]$/.test(value)) {
      return { accepted: false, reason: "invalid_direction_reply" };
    }
    this.#inputQueue.push({ value, source: "model", at: ++this.#nextRequest });
    this.#flushInput();
    return { accepted: true, state_version: this.#stateVersion };
  }

  #flushInput() {
    if (!this.#pending) return;
    const next = this.#inputQueue.shift();
    if (!next) return;
    const { requestId, resolve } = this.#pending;
    this.#pending = null;
    this.input = { kind: "running" };
    resolve(next.value);
  }

  // ---- worker messages ----------------------------------------------------

  #onMessage(msg) {
    switch (msg?.type) {
      case "started":
        this.runtimeId = msg.runtimeId;
        this.alive = true;
        this.#startedAt = Date.now();
        this.onLog(`engine started: ${msg.runtimeId}`);
        this.#publish({ type: "started", runtimeId: msg.runtimeId });
        return;
      case "ended":
        this.alive = false;
        // Leave "running" before publishing. `running` means "the engine is
        // mid-step and will ask again", but a finished engine never asks again,
        // so keeping it strands every caller: settle() spins out its whole
        // timeout and respond() reports success for a key nobody reads.
        this.ended = true;
        this.input = { kind: "ended" };
        this.#pending = null;
        this.#inputQueue.length = 0;
        this.#publish({ type: "ended", code: msg.code });
        return;
      case "exit":
        // The windowport is closing; the process is about to finish. Treat it
        // like `ended` so no caller is left waiting on a prompt that is gone.
        this.ended = true;
        this.input = { kind: "ended" };
        return;
      case "error":
        this.onLog(`engine error: ${msg.message}`);
        // An engine error can abort a step that was in flight, which would
        // otherwise leave `running` set forever. Fail the pending prompt so the
        // next caller sees a state it can act on instead of a silent stall.
        if (this.input.kind === "running") {
          this.input = { kind: "error", message: String(msg.message ?? "") };
        }
        this.#publish({ type: "error", message: msg.message });
        return;
      case "input_required": {
        // Flatten the prompt onto `input`: the worker's payload already carries
        // the fields each prompt kind needs (question, choices, title, items),
        // and `observe()` publishes them as `prompt` without re-nesting them.
        const prompt = msg.prompt ?? {};
        this.input = prompt.kind === "command" ? { kind: "command" } : { ...prompt };
        this.#pending = { requestId: msg.requestId, resolve: (value) => {
          this.#worker?.postMessage({ type: "respond", requestId: msg.requestId, value });
        } };
        this.#publish({ type: "input_required", kind: this.input.kind });
        this.#flushInput();
        return;
      }
      case "event":
        this.#applyEvent(msg.event);
        return;
      default:
        return;
    }
  }

  #applyEvent(event) {
    switch (event?.type) {
      case "map_clear":
        this.tiles.clear();
        this.#publish({ type: "map_clear" });
        return;
      case "glyph": {
        const tile = {
          x: event.x, y: event.y, tty: event.tty,
          terrain: terrainOf(event.tty), text: glyphText(event.tty),
          // Whether this cell is the player's own pet. Needed so a long walk is
          // not cut short every time the pet catches up: it draws as an ordinary
          // lowercase letter, so it is otherwise indistinguishable from a hostile
          // monster arriving.
          pet: (Number(event.special) & MG_PET) !== 0,
        };
        this.tiles.set(`${event.x},${event.y}`, tile);
        // A "@" may be the hero or a human monster, so this is where the position
        // is settled rather than trusting the cursor.
        if (tile.text === "@") this.#refreshPlayer();
        this.#publish({ type: "glyph", tile });
        return;
      }
      case "player":
        // `player` is the raw engine event name, but the value is the map CURSOR
        // (`shim_curs`); the character's position comes from `#refreshPlayer()`.
        this.cursor = { x: event.x, y: event.y };
        this.#refreshPlayer();
        this.#publish({ type: "player", cursor: { ...this.cursor }, player: this.player ? { ...this.player } : null });
        return;
      case "status": {
        if (event.field === "BL_CONDITION") {
          this.conditions = event.conditions ?? [];
        } else {
          this.status[event.field] = event.value;
          if (event.field === "BL_TIME") this.turn = Number(event.value) || this.turn;
        }
        this.#publish({ type: "status", field: event.field });
        return;
      }
      case "menu": {
        // A PICK_NONE menu is the engine *displaying* a list rather than asking
        // a question — the inventory screen arrives this way. Keep the rows as
        // the current inventory so the panel can show a 背包 view, and do not
        // treat it as a prompt (the engine is not waiting on it).
        if (event.how === "PICK_NONE") {
          this.inventory = (event.items ?? [])
            .filter((item) => item.text)
            .map((item) => {
              const selectable = item.accelerator > 32 && item.accelerator < 127;
              return {
                text: item.text,
                // Headers ("Weapons", "Armor") carry no accelerator: they group
                // the rows below them rather than naming an item.
                letter: selectable ? String.fromCharCode(item.accelerator) : "",
                header: !selectable,
              };
            });
          this.#publish({ type: "inventory", inventory: this.inventory });
        }
        return;
      }
      case "message": {
        if (typeof event.text !== "string" || !event.text.trim()) return;
        this.messages.push(event.text);
        if (this.messages.length > 200) {
          // Drop the oldest and shift the "already reported" marker with them, or
          // trimming would make the next takeNewMessages() re-send old lines.
          const dropped = this.messages.length - 200;
          this.messages.splice(0, dropped);
          this.#reportedMessages = Math.max(0, this.#reportedMessages - dropped);
        }
        this.#publish({ type: "message", text: event.text });
        return;
      }
      default:
        // window/status_init/inventory/init/stdout are lifecycle noise here.
        return;
    }
  }
}