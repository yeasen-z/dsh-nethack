// Run: node --test plugins/dsh-nethack/tests/observe-neighbours.mjs
// The map draws the player's pet as an ordinary letter, so the model could not
// tell its own follower from a hostile monster and reported "blocked by my cat".
// `nethack_observe` must name the pet outright.
import assert from "node:assert/strict";
import test from "node:test";

import { neighboursLine } from "../lib/index.mjs";

const player = { x: 10, y: 10 };
const tile = (x, y, text, pet = false) => ({ x, y, text, pet });

test("the pet is named as the pet, with its direction", () => {
  const line = neighboursLine({ player, tiles: [tile(9, 11, "d", true)] });
  assert.equal(line, 'next to you: your pet "d" (southwest)');
});

test("the pet is listed before a hostile creature", () => {
  const line = neighboursLine({ player, tiles: [tile(11, 10, "r"), tile(10, 9, "d", true)] });
  assert.equal(line, 'next to you: your pet "d" (north), a creature "r" (east)');
});

test("floor, walls and items are not neighbours", () => {
  const tiles = [tile(10, 9, "."), tile(10, 11, "#"), tile(9, 10, "$"), tile(11, 11, " ")];
  assert.equal(neighboursLine({ player, tiles }), null);
});

test("nothing beside you is not an empty line", () => {
  assert.equal(neighboursLine({ player, tiles: [] }), null);
  assert.equal(neighboursLine({ tiles: [] }), null);
});
