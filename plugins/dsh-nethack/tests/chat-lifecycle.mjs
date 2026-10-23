// Run: node --test plugins/dsh-nethack/tests/chat-lifecycle.mjs
// Executes the unchanged browser module and actual NetHackChat effect callbacks.
// This small hook runner models dependency tracking and StrictMode's mount-effect
// setup -> cleanup -> setup replay; it is not a browser/React integration test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";

const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

function hookRunner() {
  let active;
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter((x) => x != null && x !== false) };
    },
    useState(initial) {
      const record = active;
      const index = record.cursor++;
      if (!(index in record.cells)) record.cells[index] = typeof initial === "function" ? initial() : initial;
      return [record.cells[index], (update) => {
        record.cells[index] = typeof update === "function" ? update(record.cells[index]) : update;
      }];
    },
    useRef(initial) {
      const record = active;
      const index = record.cursor++;
      return record.cells[index] ??= { current: initial };
    },
    useEffect(setup, dependencies) {
      const record = active;
      const index = record.cursor++;
      const previous = record.cells[index];
      if (!previous || !dependencies || dependencies.some((value, i) => !Object.is(value, previous.dependencies?.[i]))) {
        const effect = { setup, dependencies, cleanup: previous?.cleanup };
        record.cells[index] = effect;
        record.pending.push(effect);
      }
    },
    useCallback(callback) { return callback; },
  };
  return {
    React,
    mount(Component, props) {
      const record = { cursor: 0, cells: [], pending: [] };
      return {
        render() {
          active = record;
          record.cursor = 0;
          try { return Component(props); } finally { active = undefined; }
        },
        commit({ replay = false } = {}) {
          const effects = record.pending.splice(0);
          for (const effect of effects) {
            effect.cleanup?.();
            effect.cleanup = effect.setup();
          }
          if (replay) {
            for (const effect of effects) effect.cleanup?.();
            for (const effect of effects) effect.cleanup = effect.setup();
          }
        },
      };
    },
  };
}

function byClass(tree, className) {
  if (!tree || typeof tree !== "object") return undefined;
  if (tree.props?.className?.split(" ").includes(className)) return tree;
  for (const child of tree.children ?? []) {
    const found = byClass(child, className);
    if (found) return found;
  }
}

function harness() {
  const runner = hookRunner();
  const storage = new Map();
  let module;
  let Panel;
  let releaseResponse;
  let requests = 0;
  let reads = 0;
  const responseReady = new Promise((resolve) => { releaseResponse = resolve; });
  const reply = "Ready for your next instruction.";
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { module = value; } } },
    styles: { insert() { return () => {}; } },
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, value); },
      removeItem(key) { storage.delete(key); },
    },
    TextDecoder,
    fetch: async (url, options) => {
      assert.equal(url, "/api/dsh-nethack.chat");
      assert.equal(JSON.parse(options.body).message, "play");
      requests++;
      await responseReady;
      return {
        ok: true,
        body: { getReader() {
          return { async read() {
            reads++;
            if (reads > 1) return { done: true };
            return { done: false, value: new TextEncoder().encode(JSON.stringify({
              type: "done", reply, history: [{ role: "user", content: "play" }],
              toolCalls: [], steps: [],
            }) + "\n") };
          } };
        } },
      };
    },
  };
  runInNewContext(source, sandbox, { filename: "client.js" });
  const plugin = module.factory((name) => {
    assert.equal(name, "react");
    return runner.React;
  });
  plugin.apply({
    effect(callback) { return callback(); },
    locale: { bind() { return (key) => key; }, register() { return () => {}; } },
    slots: {
      inject(name, callback) { return callback(); },
      register(options, component) {
        if (options.name === "main") Panel = component;
        return () => {};
      },
    },
  });
  assert.equal(typeof Panel, "function", "actual panel registered");
  // Discover the real chat through the panel's render result, without modifying
  // source, exporting internals, or matching source text. Do not commit the
  // parent's polling effects: this test isolates the chat's lifecycle.
  const panel = runner.mount(Panel, { t: (key) => key });
  const chatElement = byClass(panel.render(), "nhc-dock").children[0];
  const chat = runner.mount(chatElement.type, { ...chatElement.props, gameId: "game-1" });
  return { chat, releaseResponse, reply, requests: () => requests, reads: () => reads };
}

for (const replay of [false, true]) {
  test(`completed chat unlocks composer ${replay ? "after mount-effect replay" : "without effect replay (control)"}`, async () => {
    const fixture = harness();
    const { chat } = fixture;
    let tree = chat.render();
    chat.commit({ replay });
    byClass(tree, "nhc-chat-input").props.onChange({ target: { value: "play" } });
    tree = chat.render();
    chat.commit();
    byClass(tree, "nhc-chat-send").props.onClick();
    tree = chat.render();
    chat.commit();
    assert.equal(fixture.requests(), 1, "send reaches the real fetch call");
    assert.equal(byClass(tree, "nhc-chat-input").props.disabled, true, "composer locks during request");
    fixture.releaseResponse();
    await nextTurn(); // Drain the fake fetch/reader and component promise chain.
    tree = chat.render();
    chat.commit();
    assert.equal(fixture.reads(), 1, "real handler consumes the NDJSON done event");
    assert.equal(byClass(tree, "nhc-chat-input").props.disabled, false,
      "completed request must clear busy and re-enable the composer");
    assert.equal(byClass(tree, "nhc-caret"), undefined, "completed turn no longer streams");
    const log = byClass(tree, "nhc-chat-log");
    assert.ok(JSON.stringify(log).includes(fixture.reply), "final reply is rendered");
    byClass(tree, "nhc-chat-input").props.onChange({ target: { value: "again" } });
    tree = chat.render();
    chat.commit();
    assert.equal(byClass(tree, "nhc-chat-send").props.disabled, false, "another instruction can be sent");
  });
}
