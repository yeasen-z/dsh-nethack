// NetHack 3.6.7 engine worker.
//
// Runs the WASM engine on its own thread because `main()` busy-polls the
// windowport key callback synchronously: on the Host's main thread it would
// starve the event loop. All observation leaves through postMessage.
//
// The callback bridge below is the validated one (spike/nethack367-bridge.mjs);
// the three facts that matter, all established by experiment:
//   * getmsghistory must terminate with a NULL char*, or the engine spins.
//   * string returns need ONE reusable buffer per shim (the engine retains the
//     pointer and calls some shims in very hot loops).
//   * number_pad:1 maps directions to the digit keys.

import { parentPort, workerData } from "node:worker_threads";

const CONDITION_NAMES = ["bare_handed", "blind", "busy", "confused", "deaf", "elf_iron", "flying",
  "food_poisoned", "glowing_hands", "grabbed", "hallucinating", "held", "icy", "in_lava",
  "levitating", "paralyzed", "riding", "sleeping", "sliming", "slippery", "stoning", "strangled",
  "stunned", "submerged", "terminally_ill", "tethered", "trapped", "unconscious", "wounded_legs", "holding"];

let mod = null;
let nextWindowId = 1;
const windowKinds = new Map();
const menus = new Map();
const strBuffers = new Map();
const messageHistory = [];
let historyCursor = 0;
const bufferedKeys = [];

// A pending input request: the engine thread is parked inside this promise.
let pendingInput = null;
let inputSeq = 0;

const playerName = String(workerData?.name ?? "NHChat").slice(0, 31) || "NHChat";

function post(msg) { parentPort.postMessage(msg); }
function emit(event) { post({ type: "event", event }); }

const constName = (scope, value) => {
  const table = globalThis.nethackGlobal?.constants?.[scope];
  return table ? (table[value] ?? value) : value;
};

function installHelpers() {
  const ng = (globalThis.nethackGlobal ??= {});
  ng.constants ??= {}; ng.globals ??= {}; ng.pointers ??= {}; ng.helpers ??= {};
  ng.helpers.getPointerValue = (name, ptr, type) => {
    if (!ptr) return type === "s" ? "" : 0;
    switch (type) {
      case "s": return mod.UTF8ToString(ptr);
      case "b": return mod.getValue(ptr, "i8") === 1;
      case "c": return String.fromCharCode(mod.getValue(ptr, "i8"));
      case "0": return mod.getValue(ptr, "i8");
      case "1": return mod.getValue(ptr, "i16");
      case "2": case "i": case "n": case "p": return mod.getValue(ptr, "i32");
      case "f": return mod.getValue(ptr, "float");
      case "d": return mod.getValue(ptr, "double");
      case "v": return undefined;
      default: return 0;
    }
  };
  ng.helpers.setPointerValue = (name, ptr, type, value) => {
    if (!ptr || type === "v") return;
    if (type === "s") {
      if (!strBuffers.has(name)) strBuffers.set(name, { ptr: mod._malloc(2048), cap: 2048 });
      returnImage(name, ptr, value);
      return;
    }
    switch (type) {
      case "b": mod.setValue(ptr, value ? 1 : 0, "i8"); return;
      case "c": case "0": mod.setValue(ptr, typeof value === "string" ? value.charCodeAt(0) : value, "i8"); return;
      case "1": mod.setValue(ptr, value, "i16"); return;
      case "2": case "i": case "n": case "p": mod.setValue(ptr, value, "i32"); return;
      case "f": mod.setValue(ptr, value, "float"); return;
      case "d": mod.setValue(ptr, value, "double"); return;
      default: return;
    }
  };
}

function returnImage(name, outPtr, value) {
  const slot = strBuffers.get(name);
  if (value == null) { mod.setValue(outPtr, 0, "i32"); return; } // NULL char*
  const text = String(value).slice(0, slot.cap - 1);
  const bytes = new TextEncoder().encode(text).length + 1;
  if (bytes > slot.cap) { mod._free(slot.ptr); slot.cap = bytes * 2; slot.ptr = mod._malloc(slot.cap); }
  mod.stringToUTF8(text, slot.ptr, slot.cap);
  mod.setValue(outPtr, slot.ptr, "i32");
}

/**
 * The engine is parked here while it waits for a key. main() never returns, so
 * this promise is the only way to advance the game step by step.
 */
function waitForKeys(prompt) {
  if (bufferedKeys.length) return Promise.resolve(bufferedKeys.shift());
  if (pendingInput) {
    // A nested request means the previous prompt was answered with something
    // the engine could not consume. Fail loudly rather than deadlock.
    const err = new Error(`nested input request: ${pendingInput.prompt.kind} -> ${prompt.kind}`);
    emit({ type: "error", message: err.message });
    return Promise.reject(err);
  }
  const requestId = `in-${++inputSeq}`;
  post({ type: "input_required", requestId, prompt });
  return new Promise((resolve) => { pendingInput = { requestId, prompt, resolve }; });
}

async function takeKeys(prompt) {
  if (pendingInput) throw new Error(`nested input request: ${pendingInput.prompt.kind} -> ${prompt.kind}`);
  if (bufferedKeys.length) return bufferedKeys.shift();
  const requestId = `in-${++inputSeq}`;
  post({ type: "input_required", requestId, prompt });
  const text = String((await new Promise((resolve) => { pendingInput = { requestId, prompt, resolve }; })) ?? " ");
  const keys = Array.from(text);
  bufferedKeys.push(...keys.slice(1));
  return keys[0] ?? " ";
}

/**
 * Decode one `shim_print_glyph` call into a drawable cell.
 *
 * The fourth argument is a glyph NUMBER, not a pointer — reading it as a
 * struct yields ASCII garbage and renders the whole map as `?`. The port
 * installs `nethackGlobal.helpers.mapglyphHelper(glyph, x, y, mgflags)` from
 * its own C code, which resolves the number into the tty character, colour and
 * special flag through `_mapglyph`.
 *
 * @see engine/build/nethack.js `js_helpers_init` — the helper is registered
 * there and called by the WASM through import `E`.
 */
function decodeGlyph(glyph, x, y, mgflags) {
  const helper = globalThis.nethackGlobal?.helpers?.mapglyphHelper;
  if (typeof helper !== "function") {
    return { tty: 0, color: 0, special: 0, tile: 0 };
  }
  const info = helper(glyph, x, y, mgflags);
  return { tty: info?.ch ?? 0, color: info?.color ?? 0, special: info?.special ?? 0, tile: info?.tileIdx ?? 0 };
}

/**
 * Normalize one `shim_status_update` string field.
 *
 * Two defects of this port are corrected here, both verified by dumping the
 * raw values across a full game start:
 *
 * 1. `BL_GOLD` does not arrive as a number. It is a debug envelope of the form
 *    `\G<hex-address>:<amount>` — for example `\G0000090C:814` and, after the
 *    same field moved, `\G0B52090C:814`. The amount after the last colon is the
 *    real value; the hex address is an artifact and must not be shown.
 * 2. Fields declared as character arrays (`BL_TITLE`, `BL_LEVELDESC`) arrive
 *    space-padded to their C array width, so they must be trimmed.
 *
 * @param value - the raw `UTF8ToString` of the field pointer.
 * @returns the display value.
 */
function normalizeStatusValue(value) {
  const raw = String(value ?? "");
  const colon = raw.lastIndexOf(":");
  if (raw.startsWith("\\G") && colon !== -1 && /^\d+$/.test(raw.slice(colon + 1).trim())) {
    return raw.slice(colon + 1).trim();
  }
  return raw.trim();
}

async function handle(name, ...args) {
  switch (name) {
    case "shim_init_nhwindows": installHelpers(); emit({ type: "init" }); return 0;
    case "shim_player_selection_or_tty": return 1;
    case "shim_player_selection": return 0;
    case "shim_number_pad": return 0;
    case "shim_askname":
      globalThis.nethackGlobal.globals.svp.plname = playerName;
      return 0;
    case "shim_create_nhwindow": {
      const id = nextWindowId++;
      windowKinds.set(id, constName("WIN_TYPE", args[0]));
      emit({ type: "window", id, kind: windowKinds.get(id) });
      return id;
    }
    case "shim_clear_nhwindow":
      if (windowKinds.get(args[0]) === "NHW_MAP") emit({ type: "map_clear" });
      return 0;
    case "shim_curs":
      if (windowKinds.get(args[0]) === "NHW_MAP") emit({ type: "player", x: args[1], y: args[2] });
      return 0;
    case "shim_putstr":
      if (typeof args[2] === "string" && args[2].trim()) {
        messageHistory.push(args[2]);
        emit({ type: "message", text: args[2] });
      }
      return 0;
    case "shim_raw_print":
    case "shim_raw_print_bold":
      if (typeof args[0] === "string" && args[0].trim()) {
        messageHistory.push(args[0]);
        emit({ type: "message", text: args[0] });
      }
      return 0;
    case "shim_start_menu":
      menus.set(args[0], { windowId: args[0], how: null, title: "", items: [] });
      return 0;
    case "shim_add_menu": {
      // Verified argument order (raw shim args):
      //   [win, glyph, identifier, accelerator, groupacc, attr, text, preselected]
      // Reading index 7 as `text` yields the `preselected` boolean, which is how
      // every menu label previously came out as `false`.
      const [, glyph, identifier, accelerator, , , text, preselected] = args;
      menus.get(args[0])?.items.push({
        identifier,
        accelerator,
        text: typeof text === "string" ? text : "",
        glyph,
        preselected: preselected === true,
      });
      return 0;
    }
    case "shim_end_menu": {
      const menu = menus.get(args[0]);
      if (menu) menu.title = args[1] ?? "";
      return 0;
    }
    case "shim_select_menu": {
      const menu = menus.get(args[0]) ?? { windowId: args[0], title: "", items: [], how: null };
      menu.how = constName("MENU_SELECT", args[1]);
      menus.delete(args[0]);
      const items = menu.items.filter((item) => item.identifier !== 0);
      emit({ type: "menu", title: menu.title, how: menu.how, items });
      if (menu.how === "PICK_NONE") return 0;
      // Interactive menus: hand the choice to the Host and wait for a key.
      // `how` travels with the prompt so a consumer can tell a single-choice
      // menu (PICK_ONE) from a multi-select one (PICK_ANY).
      const value = await takeKeys({ kind: "menu", title: menu.title, how: menu.how, items });
      return value.charCodeAt(0) || 27;
    }
    case "shim_print_glyph": {
      const cell = decodeGlyph(args[3], args[1], args[2], args[4]);
      emit({ type: "glyph", x: args[1], y: args[2], glyph: args[3], ...cell });
      return 0;
    }
    case "shim_status_init": emit({ type: "status_init" }); return 0;
    case "shim_status_enablefield": return 0;
    case "shim_status_update": {
      const field = constName("STATUS_FIELD", args[0]);
      if (field === "BL_RESET" || field === "BL_FLUSH") return 0;
      if (field === "BL_CONDITION") {
        const mask = mod.getValue(args[1], "i32") >>> 0;
        emit({ type: "status", field, value: mask, conditions: CONDITION_NAMES.filter((_, i) => mask & (1 << i)) });
        return 0;
      }
      // Every non-condition field arrives as a pointer to a formatted C string.
      emit({
        type: "status",
        field,
        value: args[1] ? normalizeStatusValue(mod.UTF8ToString(args[1])) : "",
      });
      return 0;
    }
    case "shim_yn_function": {
      const question = String(args[0] ?? "");
      const choices = String(args[1] ?? "");
      // getdir uses the yes/no callback with no choices, but its answer is a
      // number-pad direction, NOT y/n. Verified with the actual engine's open
      // command; vi keys produce cmdassist's "Invalid direction key!" screen.
      const direction = /\bin what direction\?$/i.test(question) && choices === "";
      return (await takeKeys({
        kind: direction ? "direction" : "yn", question,
        choices: direction ? "12346789<>.s" : choices,
      })).charCodeAt(0) || 27;
    }
    case "shim_getlin": {
      const value = await takeKeys({ kind: "line", question: String(args[0] ?? "") });
      mod.stringToUTF8(String(value).slice(0, 240), args[1], 256);
      return 0;
    }
    case "shim_nhgetch":
      return (await takeKeys({ kind: "key" })).charCodeAt(0) || 32;
    case "shim_nh_poskey":
      // The command prompt lives here: this build busy-polls it.
      return (await takeKeys({ kind: "command" })).charCodeAt(0) || 32;
    case "shim_display_nhwindow":
      if (args[1]) await takeKeys({ kind: "more" });
      return 0;
    case "shim_getmsghistory":
      // Cursor walk terminated by a NULL char* (see file header).
      if (args[0]) historyCursor = 0;
      if (historyCursor < messageHistory.length) return messageHistory[historyCursor++];
      return null;
    case "shim_get_color_string": return "";
    case "shim_exit_nhwindows": emit({ type: "exit" }); return 0;
    case "shim_update_inventory": emit({ type: "inventory" }); return 0;
    case "shim_update_positionbar": return 0;
    case "shim_nhbell": return 0;
    default: return 0;
  }
}

async function start() {
  const { default: createModule } = await import(workerData.moduleUrl);

  globalThis.nethackCallback = (name, ...args) => {
    try {
      return handle(name, ...args);
    } catch (error) {
      post({ type: "error", message: `${name}: ${error?.message ?? error}` });
      throw error;
    }
  };

  let resolveReady;
  const ready = new Promise((resolve) => (resolveReady = resolve));

  mod = await createModule({
    noInitialRun: true,
    print: (text) => emit({ type: "stdout", text }),
    printErr: (text) => { if (text && text.trim()) emit({ type: "stderr", text }); },
    preRun: [(m) => { m.ENV.NETHACKOPTIONS = `name:${playerName},number_pad:1,time`; }],
    onRuntimeInitialized() { resolveReady(); },
  });
  await ready;

  for (const dir of ["/save", "/tmp"]) {
    if (!mod.FS.analyzePath(dir).exists) mod.FS.mkdir(dir);
  }
  mod.ccall("shim_graphics_set_callback", null, ["string"], ["nethackCallback"]);

  const args = ["nethack", "-@", `-u${playerName}`];
  const pointers = args.map((text) => {
    const bytes = new TextEncoder().encode(text).length + 1;
    const ptr = mod._malloc(bytes);
    mod.stringToUTF8(text, ptr, bytes);
    return ptr;
  });
  const argv = mod._malloc((pointers.length + 1) * 4);
  pointers.forEach((ptr, i) => mod.setValue(argv + i * 4, ptr, "i32"));
  mod.setValue(argv + pointers.length * 4, 0, "i32");

  post({ type: "started", runtimeId: "nh3.6.7-wasm@neth4ck", name: playerName });

  // main() runs the entire game; it resolves only when the game ends.
  mod.ccall("main", "number", ["number", "number"], [pointers.length, argv], { async: true })
    .then(() => post({ type: "ended", code: 0 }))
    .catch((error) => post({
      type: error?.name === "ExitStatus" ? "ended" : "error",
      code: error?.status,
      message: error?.message,
    }));
}

parentPort.on("message", (msg) => {
  if (msg?.type === "respond") {
    if (!pendingInput || pendingInput.requestId !== msg.requestId) {
      post({ type: "error", message: "response does not match the pending input request" });
      return;
    }
    const { resolve } = pendingInput;
    pendingInput = null;
    resolve(msg.value);
  }
});

start().catch((error) => post({ type: "error", message: error?.stack ?? String(error) }));