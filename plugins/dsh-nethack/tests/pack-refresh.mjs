// Standalone workers only; never touches the Host's live game.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { NetHackGame } from "../lib/game.mjs";

const require = createRequire(import.meta.url);
const moduleUrl = require.resolve("@neth4ck/wasm-367");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(game, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = game.observe();
    if (!["starting", "running"].includes(state.waiting_for)) return state;
    await pause(20);
  }
  assert.fail(`engine did not settle: ${JSON.stringify(game.observe())}`);
}

async function start(game) {
  game.start();
  for (let i = 0; i < 15; i++) {
    const state = await settle(game);
    if (state.waiting_for !== "more") {
      assert.equal(state.waiting_for, "command");
      return;
    }
    assert.equal(game.respond(" ").accepted, true);
  }
  assert.fail("too many startup pages");
}

const items = (game) => game.observe().inventory.filter((item) => !item.header);

async function refresh(game) {
  // Await the actual inventory event, not a guessed sleep or another attempt.
  let unsubscribe;
  let timer;
  const updated = new Promise((resolve, reject) => {
    unsubscribe = game.subscribe((event) => {
      if (event.type === "inventory") resolve();
    });
    timer = setTimeout(() => reject(new Error(`inventory update timed out: ${JSON.stringify(game.observe())}`)), 8000);
  });
  try {
    assert.equal(game.refreshInventory(), true);
    await updated;
    assert.equal((await settle(game)).waiting_for, "command");
  } finally {
    unsubscribe();
    clearTimeout(timer);
  }
}

// NetHack accepts a role suffix in the character name. Wizard has unequipped
// starting supplies, unlike selecting arbitrary equipment from a random role.
function fixture(t, name) {
  const game = new NetHackGame({ moduleUrl, name: `${name}-Wiz` });
  t.after(() => game.stop());
  return game;
}

test("a refresh fills the pack without spending a turn", { timeout: 40000 }, async (t) => {
  const game = fixture(t, "Refresh");
  await start(game);
  assert.equal(items(game).length, 0, "the pack starts unknown");
  const before = game.observe().turn;
  await refresh(game);
  assert.ok(items(game).length > 0, "Wizard starts with equipment and supplies");
  assert.equal(game.observe().turn, before);
});

test("the next key still works after a refresh", { timeout: 40000 }, async (t) => {
  const game = fixture(t, "NextKey");
  await start(game);
  const turn = game.observe().turn;
  await refresh(game);
  assert.equal(game.act({ action: "wait" }).accepted, true);
  await settle(game);
  assert.equal(game.observe().turn, turn + 1, "wait was delivered, not swallowed");
});

test("dropping an unequipped supply removes exactly that item from the pack", { timeout: 40000 }, async (t) => {
  const game = fixture(t, "Drop");
  await start(game);
  await refresh(game);
  const before = items(game);
  const dropped = before.find((item) => /^[a-zA-Z]$/.test(item.letter) && !/\((?:being worn|weapon in hands?|wielded|alternate weapon|in quiver)/i.test(item.text));
  assert.ok(dropped, `need an unequipped item: ${JSON.stringify(before)}`);
  const turn = game.observe().turn;
  const messageCount = game.messages.length;
  assert.equal(game.act({ action: "raw_keys", keys: "d" }).accepted, true);
  const question = await settle(game);
  assert.equal(question.waiting_for, "yn", "drop asks which item");
  assert.match(question.prompt.question, /^What do you want to drop/);
  assert.equal(game.respond(dropped.letter).accepted, true);
  const state = await settle(game);
  // Do not answer arbitrary follow-up questions with 'y': that hid invalid
  // fixtures and could operate a different prompt.
  assert.equal(state.waiting_for, "command", JSON.stringify(state));
  assert.ok(game.messages.slice(messageCount).some((text) => /You drop /i.test(text)), JSON.stringify(state.messages));
  assert.equal(state.turn, turn + 1, "the drop actually consumed a turn");
  await refresh(game);
  const remaining = items(game);
  assert.deepEqual(remaining, before.filter((item) => item.letter !== dropped.letter));
  assert.ok(remaining.length > 0, "a bogus empty pack must not pass");
  assert.equal(game.observe().turn, turn + 1, "inventory refresh spends no turn");
});

test("a genuinely empty inventory clears the last cached item", { timeout: 40000 }, async (t) => {
  const game = fixture(t, "Empty");
  await start(game);
  await refresh(game);
  // Wizard starts with one worn cloak. Remove it so every item is droppable.
  const worn = items(game).filter((item) => /\(being worn\)/.test(item.text));
  assert.equal(worn.length, 1, JSON.stringify(items(game)));
  assert.match(worn[0].text, /cloak/);
  assert.equal(game.act({ action: "raw_keys", keys: "T" }).accepted, true);
  let state = await settle(game);
  if (state.waiting_for === "yn") {
    assert.match(state.prompt.question, /take off/i);
    assert.equal(game.respond(worn[0].letter).accepted, true);
    state = await settle(game);
  }
  assert.equal(state.waiting_for, "command", JSON.stringify(state));
  await refresh(game);
  assert.ok(!items(game).some((item) => /\(being worn\)/.test(item.text)));
  const initial = items(game);
  for (const item of initial) {
    assert.equal(game.act({ action: "raw_keys", keys: "d" }).accepted, true);
    assert.equal((await settle(game)).waiting_for, "yn");
    assert.equal(game.respond(item.letter).accepted, true);
    assert.equal((await settle(game)).waiting_for, "command");
    await refresh(game);
  }
  assert.deepEqual(game.observe().inventory, [], "empty inventory must replace the cached last item");
  assert.ok(game.messages.some((message) => message.trim() === "Not carrying anything."));
});
