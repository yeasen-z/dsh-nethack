import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { MiddlewareSession } from "@nhchat/core";
import { RealWasmAdapter } from "@nhchat/adapter-wasm";

test("pinned NetHack WASM runs through the middleware in a Node Worker", async () => {
  let runtimeWorker;
  const adapter = new RealWasmAdapter(() => runtimeWorker = new NodeRuntimeWorker(new Worker(new URL("./real-worker-bootstrap.mjs", import.meta.url), {
    type: "module", workerData: { workerModuleUrl: new URL("../apps/web/public/runtime-probe.worker.js", import.meta.url).href },
  })));
  const session = new MiddlewareSession({ session_id: `node-real-${Date.now()}`, adapter, skills: {} });

  try {
    await session.start();
    for (let attempt = 0; attempt < 12; attempt++) {
      const observation = await session.observe();
      if (observation.input.kind === "command") break;
      let response;
      if (observation.input.kind === "more") response = { kind: "more" };
      else if (observation.input.kind === "menu" && observation.input.options.some(option => option.letter === "n")) {
        response = { kind: "menu", optionIds: [observation.input.options.find(option => option.letter === "n").optionId] };
      } else throw new Error(`Unexpected startup prompt: ${JSON.stringify(observation.input)}`);
      await step(session, observation, { action: "respond", promptId: observation.input.promptId, response }, `startup-${attempt}`);
    }
    const initial = await session.observe();
    assert.equal(initial.input.kind, "command");
    assert.match(initial.capabilities.runtime_id, /^nh5\.0-wasm/);
    assert.ok(initial.player.hp > 0 && initial.player.max_hp >= initial.player.hp);
    assert.ok(initial.player.position.x > 0 && initial.turn >= 1);
    assert.ok(initial.tiles.length > 0);
    assert.equal(initial.inventory_current, true);
    assert.ok(initial.inventory.length > 0);
    assert.ok(runtimeWorker.events.some(event => event.type === "event" && event.name === "menu" && event.data.how === 0));
    assert.deepEqual(await session.observe(), initial, "observe must not advance the live runtime");

    const stale = await session.step({
      request_id: `stale-${Date.now()}`,
      session_id: session.sessionId,
      expected_state_version: initial.state_version - 1,
      control_epoch: session.controlStatus.epoch,
      source: "human",
      action: { action: "wait" },
    });
    assert.equal(stale.status, "rejected");
    assert.equal(stale.reason, "stale_state_version");
    assert.equal(stale.input_committed, false);
    assert.deepEqual(await session.observe(), initial, "a stale real request must not touch the runtime");

    const waitRequestId = `wait-${Date.now()}`;
    const waited = await step(session, initial, { action: "wait" }, waitRequestId);
    assert.equal(waited.status, "completed");
    assert.equal(waited.turn_delta, 1, JSON.stringify(waited));
    assert.deepEqual(waited.observation.player.position, initial.player.position);

    const duplicate = await session.step({
      request_id: waitRequestId,
      session_id: session.sessionId,
      expected_state_version: initial.state_version,
      control_epoch: session.controlStatus.epoch,
      source: "human",
      action: { action: "wait" },
    });
    assert.equal(duplicate.status, "completed");
    assert.equal(duplicate.observation.turn, waited.observation.turn);
    assert.deepEqual(await session.observe(), waited.observation, "a duplicate real request must not advance a second turn");
  } finally {
    adapter.terminate();
    await runtimeWorker?.terminate();
  }
});

async function step(session, observation, action, id) {
  return session.step({
    request_id: id,
    session_id: session.sessionId,
    expected_state_version: observation.state_version,
    control_epoch: session.controlStatus.epoch,
    source: "human",
    action,
  });
}

class NodeRuntimeWorker {
  listeners = new Map();
  events = [];
  constructor(worker) { this.worker = worker; }
  postMessage(message) { this.worker.postMessage(message); }
  addEventListener(type, listener) {
    const nodeListener = type === "message" ? data => { this.events.push(data); listener({ data }); } : error => listener(error);
    this.listeners.set(listener, { type, nodeListener });
    this.worker.on(type, nodeListener);
  }
  removeEventListener(type, listener) {
    const entry = this.listeners.get(listener);
    if (entry?.type === type) this.worker.off(type, entry.nodeListener);
    this.listeners.delete(listener);
  }
  terminate() { return this.worker.terminate(); }
}
