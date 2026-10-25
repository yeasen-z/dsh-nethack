// Run: node --test plugins/dsh-nethack/tests/observe-map.mjs
// A blank cell and a wall cell used to look different only by luck: the model
// read an unexplored gap as rock, announced a dead end and then spent a whole
// reply apologising for it. The map must say which cells are unknown.
import assert from "node:assert/strict";
import test from "node:test";

import { MAP_KEY, unseenDirectionsLine } from "../lib/index.mjs";

test("the map prints a key that separates unseen from rock", () => {
  assert.match(MAP_KEY, /\?/);
  assert.match(MAP_KEY, /not a wall/i);
});

test("sides that were never drawn are named", () => {
  // Player at (5,5) with only the north and east cells drawn.
  const observation = {
    player: { x: 5, y: 5 },
    tiles: [
      { x: 5, y: 4, text: "#" }, { x: 6, y: 5, text: "." }, { x: 5, y: 5, text: "@" },
    ],
  };
  const line = unseenDirectionsLine(observation);
  assert.ok(line, "an unexplored side must be reported");
  for (const side of ["southwest", "south", "southeast", "west", "northwest"]) {
    assert.ok(line.includes(side), `${side} should be listed as unseen`);
  }
  assert.ok(!line.includes("north,"), "a drawn side is not unseen");
  assert.ok(!line.includes(" east"), "a drawn side is not unseen");
});

test("nothing is reported as unseen once every side is drawn", () => {
  const tiles = [{ x: 5, y: 5, text: "@" }];
  for (const [dx, dy] of [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]]) {
    tiles.push({ x: 5 + dx, y: 5 + dy, text: "#" });
  }
  assert.equal(unseenDirectionsLine({ player: { x: 5, y: 5 }, tiles }), null);
});

test("no player means no claim about unseen sides", () => {
  assert.equal(unseenDirectionsLine({ tiles: [] }), null);
  assert.equal(unseenDirectionsLine(null), null);
});
