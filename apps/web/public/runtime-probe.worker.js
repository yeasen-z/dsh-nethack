import createNetHackModule from "./runtime/nethack.js";

let moduleRef;
let started = false;
let inputSequence = 0;
let pendingInput = null;
let nextWindowId = 1;
let commandInputBuffer = [];
const menus = new Map();
const windowTypes = new Map();
// Pinned include/botl.h condition bits, copied while the callback is active.
const conditionNames = ["bare_handed", "blind", "busy", "confused", "deaf", "elf_iron", "flying", "food_poisoned", "glowing_hands", "grabbed", "hallucinating", "held", "icy", "in_lava", "levitating", "paralyzed", "riding", "sleeping", "sliming", "slippery", "stoning", "strangled", "stunned", "submerged", "terminally_ill", "tethered", "trapped", "unconscious", "wounded_legs", "holding"];

function send(message) {
  self.postMessage(message);
}

function sendEvent(name, data = {}) {
  send({ type: "event", sequence: ++inputSequence, name, data });
}

function installPointerHelpers() {
  const helpers = globalThis.nethackGlobal.helpers;
  helpers.getPointerValue = (name, pointer, type) => {
    if (!pointer) return type === "s" ? "" : 0;
    switch (type) {
      case "s": return moduleRef.UTF8ToString(pointer);
      case "b": return moduleRef.getValue(pointer, "i8") === 1;
      case "c":
      case "0": return type === "c" ? String.fromCharCode(moduleRef.getValue(pointer, "i8")) : moduleRef.getValue(pointer, "i8");
      case "1":
      case "2": return moduleRef.getValue(pointer, "i16");
      case "i":
      case "n": return moduleRef.getValue(pointer, "i32");
      case "p": return moduleRef.getValue(pointer, "i32");
      case "f": return moduleRef.getValue(pointer, "float");
      case "d": return moduleRef.getValue(pointer, "double");
      case "v": return undefined;
      default: throw new TypeError(`Unsupported NetHack shim argument type ${type} for ${name}`);
    }
  };
  helpers.setPointerValue = (name, pointer, type, value = 0) => {
    if (!pointer || type === "v") return;
    switch (type) {
      case "s": {
        if (name === "svp.plname") {
          moduleRef.stringToUTF8(String(value ?? "").slice(0, 31), pointer, 32);
        } else if (value == null) {
          moduleRef.setValue(pointer, 0, "i32");
        } else {
          const text = String(value);
          const bytes = new TextEncoder().encode(text).length + 1;
          const stringPointer = moduleRef._malloc(bytes);
          moduleRef.stringToUTF8(text, stringPointer, bytes);
          moduleRef.setValue(pointer, stringPointer, "i32");
        }
        return;
      }
      case "b": moduleRef.setValue(pointer, value ? 1 : 0, "i8"); return;
      case "c":
      case "0": moduleRef.setValue(pointer, typeof value === "string" ? value.charCodeAt(0) : value, "i8"); return;
      case "1":
      case "2": moduleRef.setValue(pointer, value, "i16"); return;
      case "i":
      case "n": moduleRef.setValue(pointer, value, "i32"); return;
      case "p": moduleRef.setValue(pointer, value, "i32"); return;
      case "f": moduleRef.setValue(pointer, value, "float"); return;
      case "d": moduleRef.setValue(pointer, value, "double"); return;
      default: throw new TypeError(`Unsupported NetHack shim return type ${type} for ${name}`);
    }
  };
}

function waitForInput(prompt) {
  if (pendingInput) throw new Error(`Nested shim input request while ${pendingInput.prompt.kind} is pending`);
  const requestId = `input-${++inputSequence}`;
  send({ type: "input_required", requestId, prompt });
  return new Promise((resolve) => {
    pendingInput = { requestId, prompt, resolve };
  });
}

function safeGlyphInfo(pointer) {
  if (!pointer) return null;
  return {
    glyph: moduleRef.getValue(pointer, "i32"),
    ttychar: moduleRef.getValue(pointer + 4, "i32"),
    framecolor: moduleRef.getValue(pointer + 8, "i32"),
    glyphFlags: moduleRef.getValue(pointer + 12, "i32"),
    color: moduleRef.getValue(pointer + 16, "i32"),
    symbolIndex: moduleRef.getValue(pointer + 20, "i32"),
  };
}

function safeMenuItem(args) {
  const [, glyphPointer, identifier, accelerator, glyphCharacter, attr, color, text, itemFlags] = args;
  return {
    glyph: safeGlyphInfo(glyphPointer),
    identifier: identifier ?? 0,
    accelerator,
    glyphCharacter,
    attr,
    color,
    text: text ?? "",
    itemFlags,
  };
}

function menuItemIsSelectable(item) {
  return item.identifier !== 0;
}

function buildSelection(menu, answer) {
  const choices = String(answer ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (choices.length === 1 && ["", "0", "esc", "escape", "cancel"].includes(choices[0])) return [];
  const selectable = menu.items.filter(menuItemIsSelectable);
  const selected = choices.flatMap((choice) => {
    // Typed adapter responses use explicit indices, avoiding accelerator aliases.
    if (/^index:\d+$/.test(choice)) {
      const item = selectable[Number(choice.slice(6)) - 1];
      return item ? [item] : [];
    }
    const byAccelerator = selectable.find((item) => String.fromCharCode(item.accelerator || 0).toLowerCase() === choice);
    if (byAccelerator) return [byAccelerator];
    const index = Number(choice);
    return Number.isInteger(index) && index > 0 && selectable[index - 1] ? [selectable[index - 1]] : [];
  });
  const unique = [...new Map(selected.map((item) => [item.identifier, item])).values()];
  if (menu.how === 1) return unique.slice(0, 1);
  return unique;
}

function makeMenuResult(menu, answer) {
  const selected = buildSelection(menu, answer);
  if (selected.length === 0) return 0;
  const itemSize = 16;
  const pointer = moduleRef._malloc(itemSize * selected.length);
  selected.forEach((item, index) => {
    const address = pointer + index * itemSize;
    moduleRef.setValue(address, item.identifier, "i32");
    moduleRef.setValue(address + 4, 0, "i32");
    moduleRef.setValue(address + 8, -1, "i32");
    moduleRef.setValue(address + 12, 1, "i32"); // SELECTED
  });
  return { pointer, count: selected.length };
}

async function handleShim(name, ...args) {
  switch (name) {
    case "shim_init_nhwindows":
      installPointerHelpers();
      sendEvent("init_nhwindows", {});
      return 0;
    case "shim_player_selection_or_tty":
      return true;
    case "shim_askname": {
      const nameInput = await waitForInput({ kind: "text", label: "What is your name?", defaultValue: "NHChat" });
      globalThis.nethackGlobal.globals.svp.plname = String(nameInput || "NHChat").slice(0, 31);
      sendEvent("player_name", { value: globalThis.nethackGlobal.globals.svp.plname });
      return 0;
    }
    case "shim_create_nhwindow": {
      const windowId = nextWindowId++;
      windowTypes.set(windowId, args[0]);
      sendEvent("create_nhwindow", { windowId, windowType: args[0] });
      return windowId;
    }
    case "shim_clear_nhwindow":
      sendEvent("clear_nhwindow", { windowId: args[0] });
      if (windowTypes.get(args[0]) === 3) sendEvent("map_cleared");
      return 0;
    case "shim_curs":
      if (windowTypes.get(args[0]) === 3) sendEvent("player_position", { x: args[1], y: args[2] });
      return 0;
    case "shim_putstr":
      sendEvent("message", { windowId: args[0], attr: args[1], text: args[2] ?? "" });
      return 0;
    case "shim_raw_print":
    case "shim_raw_print_bold":
      sendEvent("raw_message", { bold: name.endsWith("_bold"), text: args[0] ?? "" });
      return 0;
    case "shim_start_menu":
      menus.set(args[0], { windowId: args[0], how: null, title: "", items: [] });
      return 0;
    case "shim_add_menu": {
      const menu = menus.get(args[0]);
      if (menu) menu.items.push(safeMenuItem(args));
      return 0;
    }
    case "shim_end_menu": {
      const menu = menus.get(args[0]);
      if (menu) menu.title = args[1] ?? "";
      return 0;
    }
    case "shim_select_menu": {
      const menu = menus.get(args[0]) ?? { windowId: args[0], title: "", items: [] };
      menu.how = args[1];
      sendEvent("menu", { windowId: menu.windowId, windowType: windowTypes.get(menu.windowId), how: menu.how, title: menu.title, items: menu.items });
      if (menu.how === 0) {
        menus.delete(args[0]);
        return 0;
      }
      const answer = await waitForInput({ kind: "menu", allowMulti: menu.how === 2, label: menu.title || "Choose an option", items: menu.items.filter(menuItemIsSelectable).map((item, index) => ({
        index: index + 1,
        accelerator: String.fromCharCode(item.accelerator || 0),
        label: item.text,
      })) });
      const result = makeMenuResult(menu, answer);
      if (typeof result === "object") {
        moduleRef.setValue(args[2], result.pointer, "i32");
        menus.delete(args[0]);
        return result.count;
      }
      menus.delete(args[0]);
      return result;
    }
    case "shim_print_glyph":
      sendEvent("glyph", {
        windowId: args[0], x: args[1], y: args[2],
        glyph: safeGlyphInfo(args[3]), background: safeGlyphInfo(args[4]),
      });
      return 0;
    case "shim_status_init":
      sendEvent("status_init", {});
      return 0;
    case "shim_status_enablefield":
      sendEvent("status_field", { index: args[0], name: moduleRef.UTF8ToString(args[1]), format: moduleRef.UTF8ToString(args[2]), enabled: args[3] });
      return 0;
    case "shim_status_update": {
      sendEvent("status_raw", {
        fieldIndex: args[0], valueOrPointer: args[1], change: args[2], percent: args[3], color: args[4], colorMasksPointer: args[5],
      });
      // botl.c sends formatted C strings for every field except BL_CONDITION,
      // which is a pointer to a 32-bit mask (WASM32 unsigned long).
      if (args[0] >= 0 && args[1]) {
        const mask = args[0] === 22 ? moduleRef.getValue(args[1], "i32") >>> 0 : 0;
        sendEvent("status", { fieldIndex: args[0],
          value: args[0] === 22 ? mask : moduleRef.UTF8ToString(args[1]),
          ...(args[0] === 22 ? { conditions: conditionNames.filter((_, index) => mask & (1 << index)) } : {}),
        });
      }
      return 0;
    }
    case "shim_yn_function": {
      const [question, choices, defaultChoice] = args;
      if (String(question).startsWith("Shall I pick")) return "a".charCodeAt(0);
      // This pin routes getdir through yn_function with no response set. Only
      // recognize its known direction questions; other free-key prompts remain
      // unsupported text, never silently treated as a command boundary.
      const direction = !choices && /^In what direction\??/.test(String(question));
      const value = await waitForInput({ kind: direction ? "direction" : "yes_no_or_key", label: question, choices: choices ?? "", defaultValue: defaultChoice ?? "" });
      const text = String(value ?? defaultChoice ?? "\u001b");
      return text.length ? text.charCodeAt(0) : 27;
    }
    case "shim_getlin": {
      const value = await waitForInput({ kind: "text", label: args[0] ?? "Enter text" });
      moduleRef.stringToUTF8(String(value ?? "").slice(0, 240), args[1], 256);
      return 0;
    }
    case "shim_nhgetch": {
      const value = await waitForInput({ kind: "key", label: "NetHack is waiting for a key" });
      const text = String(value ?? " ");
      return text.length ? text.charCodeAt(0) : 32;
    }
    case "shim_nh_poskey": {
      if (commandInputBuffer.length) return commandInputBuffer.shift().charCodeAt(0);
      const value = await waitForInput({ kind: "command", label: "NetHack is waiting for a command" });
      const keys = Array.from(String(value ?? " "));
      commandInputBuffer.push(...keys.slice(1));
      return keys[0]?.charCodeAt(0) ?? 32;
    }
    case "shim_display_nhwindow": {
      sendEvent("display_window", { windowId: args[0], blocking: Boolean(args[1]) });
      if (args[1]) await waitForInput({ kind: "more", label: "Press Space or Enter to continue" });
      return 0;
    }
    case "shim_exit_nhwindows":
      sendEvent("exit_nhwindows", { message: args[0] ?? "" });
      return 0;
    case "shim_update_inventory":
      sendEvent("inventory_changed", {});
      return 0;
    case "shim_update_positionbar":
      sendEvent("positionbar", { text: args[0] ?? "" });
      return 0;
    case "shim_nhbell":
      sendEvent("bell", {});
      return 0;
    case "shim_number_pad":
      return 0;
    case "shim_getmsghistory":
      return null;
    case "shim_get_color_string":
      return null;
    default:
      sendEvent("shim_call", { name, args: args.map((value) => value ?? null) });
      return name.startsWith("shim_") ? 0 : 0;
  }
}

async function startGame(name) {
  if (started) throw new Error("This worker already started a game");
  started = true;
  moduleRef = await createNetHackModule({ noInitialRun: true,
    preRun: [(module) => Object.assign(module.ENV, {
      USER: name || "NHChat", LOGNAME: name || "NHChat", HOME: "/", HACKDIR: "/",
      SCOREDIR: "/save/", SAVEDIR: "/save/", LEVELDIR: "/", NETHACKOPTIONS: "number_pad:1,time",
    })],
    print: (text) => sendEvent("stdout", { text }), printErr: (text) => sendEvent("stderr", { text }) });
  const fs = moduleRef.FS;
  for (const directory of ["/save", "/tmp"]) {
    if (!fs.analyzePath(directory).exists) fs.mkdir(directory);
  }
  fs.writeFile("/.nethackrc", "OPTIONS=number_pad:1,time\nSCOREDIR=/save/\nSAVEDIR=/save/\nLEVELDIR=/\n");
  moduleRef.ENV.USER = name || "NHChat";
  moduleRef.ENV.LOGNAME = name || "NHChat";
  moduleRef.ENV.HOME = "/";
  moduleRef.ENV.HACKDIR = "/";
  moduleRef.ENV.SCOREDIR = "/save/";
  moduleRef.ENV.SAVEDIR = "/save/";
  moduleRef.ENV.LEVELDIR = "/";
  // Explicit runtime options are honored even when the compiled port chooses
  // a config filename other than /.nethackrc. Required for keypad recipes and
  // player-visible turn reporting through BL_TIME.
  moduleRef.ENV.NETHACKOPTIONS = "number_pad:1,time";
  globalThis.nhChatShimCallback = handleShim;
  moduleRef.ccall("shim_graphics_set_callback", null, ["string"], ["nhChatShimCallback"]);
  send({ type: "started", engine: "NetHack 5.0", runtimeId: "nh5.0-wasm-shim@9c3a54d" });
  const args = ["nethack", "-@", `-u${(name || "NHChat").slice(0, 31)}`];
  const argv = moduleRef._malloc((args.length + 1) * 4);
  args.forEach((arg, index) => {
    const byteLength = new TextEncoder().encode(arg).length + 1;
    const str = moduleRef._malloc(byteLength);
    moduleRef.stringToUTF8(arg, str, byteLength);
    moduleRef.setValue(argv + index * 4, str, "i32");
  });
  moduleRef.setValue(argv + args.length * 4, 0, "i32");
  try {
    const exitCode = await moduleRef.ccall("main", "number", ["number", "number"], [args.length, argv], { async: true });
    send({ type: "ended", exitCode });
  } catch (error) {
    if (error?.name === "ExitStatus") send({ type: "ended", exitCode: error.status });
    else throw error;
  }
}

self.onmessage = async ({ data }) => {
  try {
    if (data?.type === "start") {
      await startGame(data.name);
    } else if (data?.type === "respond") {
      if (!pendingInput || pendingInput.requestId !== data.requestId) {
        send({ type: "error", message: "Response does not match the pending input request" });
        return;
      }
      const { resolve } = pendingInput;
      pendingInput = null;
      resolve(data.value);
    }
  } catch (error) {
    send({ type: "error", message: error?.stack ?? String(error) });
  }
};
