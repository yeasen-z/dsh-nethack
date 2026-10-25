// Run: node --test plugins/dsh-nethack/tests/pack-refresh.mjs
// Starts a standalone WASM worker; never touches the Host's live game slot.
//
// The panel's pack is not live data: it is the rows of the last inventory screen
// the engine rendered. These tests pin the two failures that caused a stale pack
// (nothing refreshed it) and that a naive fix would cause (a queued inventory
// display answered a later prompt, or a refresh swallowed the next key).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { NetHackGame } from "../lib/game.mjs";

const require = createRequire(import.meta.url);
const moduleUrl = require.resolve("@neth4ck/wasm-367");

async function settle(game, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = game.observe();
    if (!["starting", "running"].includes(state.waiting_for)) return state;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return game.observe();
}

async function pastPages(game) {
  for (let i = 0; i < 15; i++) {
    const state = await settle(game);
    if (state.waiting_for !== "more") return state;
    game.respond(" ");
  }
  throw new Error("too many pages");
}

const items = (game) => game.observe().inventory.filter((item) => !item.header);
const letters = (game) => items(game).map((item) => item.letter).join("");

/**
 * Start a game whose character carries something.
 *
 * A few random starts really are empty ("Not carrying anything.", measured once
 * in ~25 runs), and such a run cannot show that a refresh filled the pack or that
 * an item action changed it. Retrying the start keeps the assertions about the
 * refresh instead of about the dice.
 */
async function startWithItems(name, minimum = 2) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const game = new NetHackGame({ moduleUrl, name: `${name}${attempt}` });
    game.start();
    await pastPages(game);
    game.refreshInventory();
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (items(game).length >= minimum) return game;
    await game.stop();
  }
  throw new Error(`could not start a ${name} character with ${minimum} items`);
}

test("a refresh fills the pack without spending a turn", { timeout: 40000 }, async (t) => {
  const game = new NetHackGame({ moduleUrl, name: "PackRefresh" });
  t.after(() => game.stop());
  game.start();
  await pastPages(game);
  assert.equal(items(game).length, 0, "the pack starts unknown");

  const before = game.observe();
  assert.equal(game.refreshInventory(), true);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = game.observe();
  assert.ok(items(game).length > 0, "the pack is filled from the inventory screen");
  assert.equal(after.waiting_for, "command", "the display must not become a question");
  assert.equal(after.turn, before.turn, "'i' displays without advancing a turn");
});

test("the next key still works after a refresh", { timeout: 40000 }, async (t) => {
  const game = new NetHackGame({ moduleUrl, name: "PackKey" });
  t.after(() => game.stop());
  game.start();
  await pastPages(game);
  const turn = game.observe().turn;
  game.refreshInventory();
  // The display briefly parks the engine; a caller waits, as the panel does, and
  // the key must then be accepted. A request taken away from the engine left it
  // unable to ask again, so this key used to be refused forever.
  await settle(game);
  assert.equal(game.observe().waiting_for, "command");
  assert.equal(game.act({ action: "wait" }).accepted, true);
  await settle(game);
  assert.equal(game.observe().turn, turn + 1, "the key was delivered, not swallowed by the display");
});

test("an item action visibly changes the pack", { timeout: 90000 }, async (t) => {
  const game = await startWithItems("PackDrop");
  t.after(() => game.stop());
  const before = letters(game);
  assert.ok(before.length >= 2, `need two items to drop one: ${before}`);

  assert.equal(game.act({ action: "raw_keys", keys: "d" }).accepted, true);
  await settle(game);
  const question = game.observe();
  assert.equal(question.waiting_for, "yn", "dropping asks which item");
  assert.equal(game.respond(before.at(-1)).accepted, true);
  await settle(game);
  if (game.observe().waiting_for === "yn") {
    game.respond("y");
    await settle(game);
  }

  game.refreshInventory();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.notEqual(letters(game), before, "the dropped item is gone from the pack");
});
