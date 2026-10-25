// Standalone NetHack 3.6.7 <-> JS bridge, modelled on the repo's validated
// runtime-probe.worker.js handler but WITHOUT the @neth4ck/neth4ck shim:
// the shim's decodeArgs() mis-parses this build's numeric arguments, and it
// hard-fails on string returns it does not expect.
//
// The build itself publishes its own constant tables through set_const(), so we
// decode window ids and status fields from nethackGlobal.constants instead.

const CONDITION_NAMES = ["bare_handed", "blind", "busy", "confused", "deaf", "elf_iron", "flying",
  "food_poisoned", "glowing_hands", "grabbed", "hallucinating", "held", "icy", "in_lava",
  "levitating", "paralyzed", "riding", "sleeping", "sliming", "slippery", "stoning", "strangled",
  "stunned", "submerged", "terminally_ill", "tethered", "trapped", "unconscious", "wounded_legs", "holding"];

export async function startEngine({ createModule, onEvent, requestInput, name = "NHChat" }) {
  let mod = null;
  let nextWindowId = 1;
  const windowKinds = new Map();
  const menus = new Map();
  const bufferedKeys = [];
  let resolveReady;
  const ready = new Promise(r => (resolveReady = r));
  const playerName = String(name).slice(0, 31) || "NHChat";
  const messageHistory = [];
  let historyCursor = 0;

  const emit = (e) => { try { onEvent(e); } catch { /* observer must not break the engine */ } };
  const constName = (scope, value) => {
    const t = globalThis.nethackGlobal?.constants?.[scope];
    return t ? (t[value] ?? value) : value;
  };

  function installHelpers() {
    const ng = (globalThis.nethackGlobal ??= {});
    ng.constants ??= {}; ng.globals ??= {}; ng.pointers ??= {};
    ng.helpers ??= {};
    ng.helpers.getPointerValue = (n, p, type) => {
      if (!p) return type === "s" ? "" : 0;
      switch (type) {
        case "s": return mod.UTF8ToString(p);
        case "b": return mod.getValue(p, "i8") === 1;
        case "c": return String.fromCharCode(mod.getValue(p, "i8"));
        case "0": return mod.getValue(p, "i8");
        case "1": return mod.getValue(p, "i16");
        case "2": case "i": case "n": case "p": return mod.getValue(p, "i32");
        case "f": return mod.getValue(p, "float");
        case "d": return mod.getValue(p, "double");
        case "v": return undefined;
        default: return 0;
      }
    };
    ng.helpers.setPointerValue = (n, p, type, value) => {
      if (!p || type === "v") return;
      if (type === "s") {
        // The engine retains the returned char*, so back every string return
        // with ONE reusable buffer per shim instead of a fresh malloc: this
        // build calls shim_getmsghistory in a very hot loop.
        if (!strBuffers.has(n)) strBuffers.set(n, { ptr: mod._malloc(2048), cap: 2048 });
        returnImage(n, p, value); return;
      }
      switch (type) {
        case "s": {
          // svp.plname is an inline char array; everything else is char**.
          if (n === "svp.plname") { mod.stringToUTF8(String(value ?? "").slice(0, 31), p, 32); return; }
          const text = value == null ? null : String(value);
          if (text === null) { mod.setValue(p, 0, "i32"); return; }
          const bytes = new TextEncoder().encode(text).length + 1;
          const sp = mod._malloc(bytes);
          mod.stringToUTF8(text, sp, bytes);
          mod.setValue(p, sp, "i32");
          return;
        }
        case "b": mod.setValue(p, value ? 1 : 0, "i8"); return;
        case "c": case "0": mod.setValue(p, typeof value === "string" ? value.charCodeAt(0) : value, "i8"); return;
        case "1": mod.setValue(p, value, "i16"); return;
        case "2": case "i": case "n": case "p": mod.setValue(p, value, "i32"); return;
        case "f": mod.setValue(p, value, "float"); return;
        case "d": mod.setValue(p, value, "double"); return;
        default: return;
      }
    };
  }

  const strBuffers = new Map();
  // Write a persistent C string into the shim's reusable buffer and publish it
  // through the char** out-parameter.
  function returnImage(n, outPtr, value) {
    const slot = strBuffers.get(n);
    if (value == null) { mod.setValue(outPtr, 0, "i32"); return; }   // NULL char*
    const text = String(value).slice(0, slot.cap - 1);
    const bytes = new TextEncoder().encode(text).length + 1;
    if (bytes > slot.cap) { mod._free(slot.ptr); slot.cap = bytes * 2; slot.ptr = mod._malloc(slot.cap); }
    mod.stringToUTF8(text, slot.ptr, slot.cap);
    mod.setValue(outPtr, slot.ptr, "i32");
  }

  async function takeKeys(prompt) {
    if (bufferedKeys.length) return bufferedKeys.shift();
    const text = String((await requestInput(prompt)) ?? " ");
    const keys = Array.from(text);
    bufferedKeys.push(...keys.slice(1));
    return keys[0] ?? " ";
  }

  async function handle(name, ...args) {
    switch (name) {
      case "shim_init_nhwindows":
        installHelpers();
        emit({ type: "init" });
        return 0;
      case "shim_player_selection_or_tty": return 1;
      case "shim_player_selection": return 0;
      case "shim_number_pad": return 0;
      case "shim_askname":
        // The engine asks for a name even though -u was passed; svp.plname is
        // an inline char array, so write it directly through the helper.
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
        if (typeof args[2] === "string" && args[2].trim()) { messageHistory.push(args[2]); emit({ type: "message", text: args[2] }); }
        return 0;
      case "shim_raw_print": case "shim_raw_print_bold":
        if (typeof args[0] === "string" && args[0].trim()) { messageHistory.push(args[0]); emit({ type: "message", text: args[0] }); }
        return 0;
      case "shim_start_menu":
        menus.set(args[0], { windowId: args[0], how: null, title: "", items: [] });
        return 0;
      case "shim_add_menu": {
        const [, , identifier, accelerator, , , , text] = args;
        menus.get(args[0])?.items.push({ identifier, accelerator, text: text ?? "" });
        return 0;
      }
      case "shim_end_menu":
        { const m = menus.get(args[0]); if (m) m.title = args[1] ?? ""; }
        return 0;
      case "shim_select_menu": {
        const m = menus.get(args[0]) ?? { windowId: args[0], title: "", items: [], how: null };
        m.how = constName("MENU_SELECT", args[1]);
        menus.delete(args[0]);
        emit({ type: "menu", title: m.title, how: m.how, items: m.items.filter(i => i.identifier !== 0) });
        return 0;
      }
      case "shim_print_glyph": {
        const g = readGlyph(args[3]);
        emit({ type: "glyph", x: args[1], y: args[2], tty: g.tty, color: g.color, special: g.special, glyph: g.glyph });
        return 0;
      }
      case "shim_status_init": emit({ type: "status_init" }); return 0;
      case "shim_status_enablefield": return 0;
      case "shim_status_update": {
        const field = constName("STATUS_FIELD", args[0]);
        if (field === "BL_RESET" || field === "BL_FLUSH") return 0;
        if (field === "BL_CONDITION") {
          const mask = (mod.getValue(args[1], "i32") >>> 0);
          emit({ type: "status", field, value: mask, conditions: CONDITION_NAMES.filter((_, i) => mask & (1 << i)) });
          return 0;
        }
        // Every non-condition field arrives as a pointer to a formatted C
        // string (a raw number here is a pointer value, never the text).
        const value = args[1] ? mod.UTF8ToString(args[1]) : "";
        emit({ type: "status", field, value });
        return 0;
      }
      case "shim_yn_function": {
        const value = await takeKeys({ kind: "yn", question: String(args[0] ?? "") });
        return String(value).charCodeAt(0) || 27;
      }
      case "shim_getlin": {
        const value = await takeKeys({ kind: "line", question: String(args[0] ?? "") });
        mod.stringToUTF8(String(value).slice(0, 240), args[1], 256);
        return 0;
      }
      case "shim_nhgetch": {
        const value = await takeKeys({ kind: "key" });
        return String(value).charCodeAt(0) || 32;
      }
      case "shim_nh_poskey":
        return (await takeKeys({ kind: "command" })).charCodeAt(0) || 32;
      case "shim_display_nhwindow":
        // The blocking wait is consumed by the port's own key callback; consuming
        // it here too would swallow the key the engine is about to ask for.
        emit({ type: "display", blocking: !!args[1] });
        return 0;
      case "shim_getmsghistory": {
        // Cursor semantics, as in the upstream libnh windowport: `init`
        // (args[0]=true) rewinds, then each call yields the next line and a
        // NULL pointer terminates the walk. Returning a valid pointer forever
        // is what produced the observed 59k-call spin.
        if (args[0]) historyCursor = 0;
        if (historyCursor < messageHistory.length) return messageHistory[historyCursor++];
        return null;   // end of history: published as a NULL char*
      }
      case "shim_get_color_string": return "";
      case "shim_exit_nhwindows": emit({ type: "exit" }); return 0;
      case "shim_update_inventory": emit({ type: "inventory" }); return 0;
      case "shim_update_positionbar": return 0;
      case "shim_nhbell": return 0;
      default: return 0;
    }
  }

  function readGlyph(ptr) {
    if (!ptr) return { glyph: 0, tty: 0, color: 0, special: 0 };
    return {
      glyph: mod.getValue(ptr, "i32"),
      tty: mod.getValue(ptr + 4, "i32"),
      color: mod.getValue(ptr + 8, "i32"),
      special: mod.getValue(ptr + 12, "i32"),
    };
  }
  // Hard safety net: if a code path stops consuming our answers the engine
  // spins synchronously, so cap total callback volume for diagnostics.
  let cbTotal = 0;
  const cbNames = [];
  globalThis.__cbNames = cbNames;
  const CB_CAP = Number(process.env.NHC_CB_CAP || 0);
  globalThis.nethackCallback = (n, ...a) => {
    if (CB_CAP && ++cbTotal > CB_CAP) {
      const e = new Error('callback cap reached at ' + n);
      emit({ type: 'debug', text: 'CAP@' + n });
      throw e;
    }
    cbNames.push(n);
    return handle(n, ...a);
  };

  const argv = ["nethack", "-@", `-u${name.slice(0, 31)}`];
  mod = await createModule({
    noInitialRun: true,
    print: (t) => emit({ type: "stdout", text: t }),
    printErr: (t) => { if (!/^$/.test(t)) emit({ type: "stderr", text: t }); },
    preRun: [(m) => { m.ENV.NETHACKOPTIONS = `name:${name},number_pad:1,time`; }],
    onRuntimeInitialized() { resolveReady(); },
  });
  await ready;
  const fs = mod.FS;
  for (const d of ["/save", "/tmp"]) if (!fs.analyzePath(d).exists) fs.mkdir(d);
  mod.ccall("shim_graphics_set_callback", null, ["string"], ["nethackCallback"]);

  const ptrs = argv.map((s) => {
    const bytes = new TextEncoder().encode(s).length + 1;
    const p = mod._malloc(bytes); mod.stringToUTF8(s, p, bytes); return p;
  });
  const argvPtr = mod._malloc((ptrs.length + 1) * 4);
  ptrs.forEach((p, i) => mod.setValue(argvPtr + i * 4, p, "i32"));
  mod.setValue(argvPtr + ptrs.length * 4, 0, "i32");

  mod.ccall("main", "number", ["number", "number"], [ptrs.length, argvPtr], { async: true })
    .then(() => emit({ type: "ended", code: 0 }))
    .catch((e) => emit({ type: e?.name === "ExitStatus" ? "ended" : "error", code: e?.status, message: e?.message }));
  return { module: mod, emit };
}