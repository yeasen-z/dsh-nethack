import assert from "node:assert/strict";
import test from "node:test";
import { ObservationBuilder, RealWasmAdapter, RuntimeWorkerClient, terrainFromSymbol } from "@nhchat/adapter-wasm";
import type { RuntimeEvent, RuntimeWorker } from "@nhchat/adapter-wasm";
import { walkToExecutor } from "@nhchat/skills";

class ScriptedWorker implements RuntimeWorker {
  listeners = new Map<string, Set<(event: any) => void>>();
  sent: any[] = [];
  terminated = false;
  constructor(private script: ((message: any, worker: ScriptedWorker) => void)[] = []) {}
  addEventListener(type: string, listener: (event: any) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: any) => void) { this.listeners.get(type)?.delete(listener); }
  postMessage(message: any) {
    this.sent.push(message);
    const next = this.script.shift();
    queueMicrotask(() => next?.(message, this));
  }
  emit(data: RuntimeEvent) { this.listeners.get("message")?.forEach(listener => listener({ data })); }
  boundary(id: string, kind: "command" | "direction" | "more") { this.emit({ type: "input_required", requestId: id, prompt: { kind, label: kind } }); }
  status(fieldIndex: number, value: string) { this.emit({ type: "event", sequence: 1, name: "status", data: { fieldIndex, value } }); }
  terminate() { this.terminated = true; }
}

function ready(worker: ScriptedWorker) {
  worker.status(16, "1"); worker.status(18, "12"); worker.status(19, "15"); worker.status(20, "Dlvl:1");
  worker.emit({ type: "event", sequence: 2, name: "player_position", data: { x: 4, y: 5 } });
  worker.boundary("command-1", "command");
}

test("observations publish only at boundaries and preserve uncertainty", async () => {
  const worker = new ScriptedWorker([(_, w) => ready(w), (_, w) => { w.status(16, "2"); w.boundary("command-2", "command"); }]);
  const adapter = new RealWasmAdapter(() => worker);
  await adapter.start("session");
  const first = adapter.snapshot();
  first.player.hp = 999;
  worker.status(18, "9");
  assert.equal(adapter.snapshot().player.hp, 12, "partial callbacks must not leak into observations");
  assert.equal(adapter.snapshot().state_version, 1);
  const result = await adapter.deliver({ action: "wait" });
  assert.equal(result.observation.turn, 2);
  assert.equal(result.observation.player.hp, 9);
  assert.equal(result.observation.state_version, 2);
  assert.deepEqual(result.observation.entities, []);
  assert.equal(result.observation.capabilities.supports_navigation, false);
  adapter.terminate();
});

test("wait forces NetHack's no-op prefix so resting consumes a turn", async () => {
  const worker = new ScriptedWorker([(_, w) => ready(w), (message, w) => {
    assert.equal(message.value, "m.");
    w.boundary("command-after-rest", "command");
  }]);
  const adapter = new RealWasmAdapter(() => worker);
  await adapter.start("session");
  const result = await adapter.deliver({ action: "wait" });
  assert.equal(result.committed, true);
  assert.equal(result.outcome, "settled");
  assert.equal(result.observation.input.kind, "command");
  adapter.terminate();
});

test("terrain uses pinned symbols, excludes unexplored cells, and clears maps", () => {
  const caps = new RealWasmAdapter(() => new ScriptedWorker()).capabilities;
  const builder = new ObservationBuilder("session", caps);
  const glyph = (x: number, symbolIndex: number, glyphFlags = 0) => builder.accept({ type: "event", sequence: 1, name: "glyph", data: { x, y: 1, glyph: { symbolIndex, glyphFlags, ttychar: 64 } } });
  glyph(1, 19); glyph(2, 15); glyph(3, 99); glyph(4, 19, 0x800);
  builder.accept({ type: "event", sequence: 1, name: "glyph", data: { x: 5, y: 1,
    glyph: { symbolIndex: 99, glyphFlags: 0, ttychar: 64 }, background: { symbolIndex: 19, glyphFlags: 0, ttychar: 46 } } });
  builder.accept({ type: "input_required", requestId: "1", prompt: { kind: "command", label: "command" } });
  assert.deepEqual(builder.snapshot().tiles.map(tile => tile.terrain), ["floor", "door_closed", "unknown", "unknown"]);
  assert.equal(builder.snapshot().tiles[0].display_char, "@");
  assert.ok(builder.snapshot().tiles.every(tile => tile.visibility === "remembered"));
  builder.accept({ type: "event", sequence: 2, name: "map_cleared", data: {} });
  builder.accept({ type: "input_required", requestId: "2", prompt: { kind: "command", label: "command" } });
  assert.deepEqual(builder.snapshot().tiles, []);
  assert.match(builder.snapshot().level_id, /map-1$/);
  assert.equal(terrainFromSymbol(17), "unknown", "bars must not be confused with corridors");
});

test("inventory is built only from the pinned read-only inventory menu and invalidated on change", () => {
  const caps = new RealWasmAdapter(() => new ScriptedWorker()).capabilities;
  const builder = new ObservationBuilder("session", caps);
  const boundary = (id: string) => builder.accept({ type: "input_required", requestId: id, prompt: { kind: "command", label: "command" } });
  const item = { identifier: 97, accelerator: 97, text: "a blessed potion of healing" };
  const heading = (text: string) => ({ identifier: 0, accelerator: 0, text });
  boundary("before-inventory");
  assert.equal(builder.snapshot().inventory_current, false);

  builder.accept({ type: "event", sequence: 1, name: "menu", data: { how: 0, title: "", items: [heading("Weapons"), item, heading("Potions")] } });
  builder.accept({ type: "event", sequence: 2, name: "menu", data: { how: 1, title: "Choose", items: [item] } });
  boundary("inventory-observed");
  assert.equal(builder.snapshot().inventory_current, true);
  assert.deepEqual(builder.snapshot().inventory.map(entry => [entry.slot, entry.display_name, entry.known_properties]), [
    ["a", "a blessed potion of healing", null],
  ]);

  builder.accept({ type: "event", sequence: 3, name: "inventory_changed", data: {} });
  boundary("inventory-invalidated");
  assert.equal(builder.snapshot().inventory_current, false);
  assert.equal(builder.snapshot().inventory.length, 1, "retain the last known list but mark it stale");
});

test("open stops at direction; stale and wrong-kind responses commit no input", async () => {
  const worker = new ScriptedWorker([(_, w) => ready(w), (message, w) => { assert.equal(message.value, "o"); w.boundary("direction-1", "direction"); },
    (message, w) => { assert.equal(message.value, "6"); w.boundary("command-2", "command"); }]);
  const adapter = new RealWasmAdapter(() => worker);
  await adapter.start("session");
  const result = await adapter.deliver({ action: "open", direction: "east" });
  assert.equal(result.outcome, "needs_input");
  assert.equal(result.observation.input.kind, "direction");
  const currentPrompt = (result.observation.input as { promptId: string }).promptId;
  assert.equal(worker.sent.length, 2);
  const bad = await adapter.deliver({ action: "respond", promptId: "old", response: { kind: "direction", direction: "east" } });
  assert.equal(bad.committed, false);
  const wrongKind = await adapter.deliver({ action: "respond", promptId: currentPrompt, response: { kind: "more" } });
  assert.equal(wrongKind.committed, false);
  assert.equal(worker.sent.length, 2);
  await adapter.deliver({ action: "respond", promptId: currentPrompt, response: { kind: "direction", direction: "east" } });
  assert.equal(worker.sent.length, 3);
  adapter.terminate();
});

test("menus validate option IDs and cardinality, and never alias numeric accelerators", async () => {
  const worker = new ScriptedWorker([(_, w) => w.emit({ type: "input_required", requestId: "menu", prompt: { kind: "menu", label: "Choose", allowMulti: false,
    items: [{ index: 1, accelerator: "2", label: "first" }, { index: 2, accelerator: "1", label: "second" }] } }),
    (message, w) => { assert.equal(message.value, "index:2"); ready(w); }]);
  const adapter = new RealWasmAdapter(() => worker);
  await adapter.start("session");
  const menuPrompt = (adapter.snapshot().input as { promptId: string }).promptId;
  for (const optionIds of [["3"], ["1", "2"]]) {
    assert.equal((await adapter.deliver({ action: "respond", promptId: menuPrompt, response: { kind: "menu", optionIds } })).committed, false);
  }
  assert.equal(worker.sent.length, 1);
  await adapter.deliver({ action: "respond", promptId: menuPrompt, response: { kind: "menu", optionIds: ["2"] } });
  assert.equal(adapter.snapshot().input.kind, "command");
  adapter.terminate();
});

test("unexpected more prompt stops movement rather than automatically continuing", async () => {
  const worker = new ScriptedWorker([(_, w) => ready(w), (message, w) => { assert.equal(message.value, "8"); w.boundary("more", "more"); }]);
  const adapter = new RealWasmAdapter(() => worker);
  await adapter.start("session");
  const result = await adapter.deliver({ action: "move", direction: "north" });
  assert.equal(result.outcome, "needs_input");
  assert.equal(worker.sent.length, 2);
  assert.equal((await adapter.deliver({ action: "wait" })).committed, false);
  adapter.terminate();
});

test("timeout poisons delivery; late replies do not permit replay", async () => {
  const worker = new ScriptedWorker([(_, w) => ready(w), () => {}]);
  const adapter = new RealWasmAdapter(() => worker, { timeoutMs: 20 });
  await adapter.start("session");
  await assert.rejects(adapter.deliver({ action: "wait" }), /timeout/);
  worker.boundary("late", "command");
  assert.equal((await adapter.deliver({ action: "wait" })).committed, false);
  assert.equal(worker.sent.length, 2);
  assert.equal(adapter.snapshot().state_version, 1);
  adapter.terminate();
});

test("termination rejects pending requests and detaches listeners", async () => {
  const worker = new ScriptedWorker();
  const client = new RuntimeWorkerClient(worker, () => {});
  const started = client.start();
  client.terminate();
  await assert.rejects(started, /terminated/);
  assert.equal(worker.terminated, true);
  assert.equal(worker.listeners.get("message")!.size, 0);
  assert.equal(worker.listeners.get("error")!.size, 0);
});

test("a restarted adapter cannot reuse prompt IDs from the prior generation", async () => {
  const workers = [new ScriptedWorker([(_, w) => w.boundary("more", "more")]), new ScriptedWorker([(_, w) => w.boundary("more", "more")])];
  const first = new RealWasmAdapter(() => workers[0]);
  const second = new RealWasmAdapter(() => workers[1]);
  await first.start("same-session");
  const oldId = (first.snapshot().input as { promptId: string }).promptId;
  first.terminate();
  await second.start("same-session");
  assert.notEqual((second.snapshot().input as { promptId: string }).promptId, oldId);
  assert.equal((await second.deliver({ action: "respond", promptId: oldId, response: { kind: "more" } })).committed, false);
  assert.equal(workers[1].sent.length, 1);
  second.terminate();
});

test("concurrent adapter calls cannot commit a second input", async () => {
  const worker = new ScriptedWorker([(_, w) => ready(w), () => {}]);
  const adapter = new RealWasmAdapter(() => worker);
  await adapter.start("session");
  const inFlight = adapter.deliver({ action: "wait" });
  assert.equal((await adapter.deliver({ action: "move", direction: "east" })).reason, "runtime_busy");
  assert.equal(worker.sent.length, 2);
  worker.boundary("command-2", "command");
  assert.equal((await inFlight).outcome, "settled");
  adapter.terminate();
});

test("navigation cannot run on incomplete real observations", async () => {
  const worker = new ScriptedWorker([(_, w) => ready(w)]);
  const adapter = new RealWasmAdapter(() => worker);
  await adapter.start("session");
  const result = await walkToExecutor.run({ task_id: "task", session_id: "session", control_epoch: 1,
    spec: { skill: "walk_to", parameters: { level_id: "Dlvl:1", target: { x: 5, y: 5 } }, constraints: {} } },
    async () => { throw new Error("must not issue a step"); }, async () => adapter.snapshot(), { epoch: 1, isCancelled: () => false });
  assert.equal(result.outcome, "blocked");
  assert.deepEqual(result.reason, ["walk_to", "navigation_not_supported"]);
  assert.equal(worker.sent.length, 1);
  adapter.terminate();
});
