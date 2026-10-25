// Run: node --test plugins/dsh-nethack/tests/observe-map.mjs
//
// A cell the engine never drew is BLIND: it is not empty floor waiting to be
// visited and it is not rock. Two observed failures motivate these tests: the
// model read a blank gap as solid rock and announced a dead end, and it later
// treated a blind area outside a room as ground it could search from.
import assert from "node:assert/strict";
import test from "node:test";

import { BLIND_CELL, MAP_KEY, blindDirectionsLine } from "../lib/index.mjs";

test("the map prints a key that explains the blind cell", () => {
  assert.equal(BLIND_CELL, "░");
  assert.ok(MAP_KEY.includes(BLIND_CELL), "the key must name the glyph actually printed");
  assert.match(MAP_KEY, /blind cell/i);
  assert.match(MAP_KEY, /neither floor/i);
});

test("the key calls '#' a corridor, never rock", () => {
  // nethackwiki's Corridor page: "#" is a "passageway connecting rooms", and
  // walls are "|" and "-". An earlier key said "only '#' is rock", which would
  // have taught the model to avoid every corridor on the map.
  assert.match(MAP_KEY, /'#' is a CORRIDOR/, "the key must name '#' as walkable");
  assert.match(MAP_KEY, /walk through it/i);
  assert.match(MAP_KEY, /'\|' and '-' are walls/);
  assert.doesNotMatch(MAP_KEY, /#.*rock/i, "the key must never call a corridor rock");
});

test("the blind glyph is not the engine's scroll glyph", () => {
  // '?' is a scroll on the map (nethackwiki: "A scroll, represented by ?"), so
  // painting blind cells with it made an unknown cell look like an item.
  assert.notEqual(BLIND_CELL, "?");
  assert.match(MAP_KEY, /'\?' is a scroll/, "the key must say what '?' really means");
});

test("the key warns against planning a route through blind cells", () => {
  // A blind area outside a room is exactly the case that produced the wrong plan.
  assert.match(MAP_KEY, /do not plan a route/i);
  assert.match(MAP_KEY, /not.*explored/i);
});

test("the blind glyph occupies one column, so the map stays aligned", () => {
  const wide = (ch) => (ch.codePointAt(0) >= 0x1100 && ch.codePointAt(0) <= 0x115f) || ch.codePointAt(0) >= 0x2e80;
  assert.equal(wide(BLIND_CELL), false, `${BLIND_CELL} must stay a single-column cell`);
});

test("sides the engine never drew are named as blind", () => {
  // Player at (5,5) with only the north and east cells drawn.
  const observation = {
    player: { x: 5, y: 5 },
    tiles: [
      { x: 5, y: 4, text: "#" }, { x: 6, y: 5, text: "." }, { x: 5, y: 5, text: "@" },
    ],
  };
  const line = blindDirectionsLine(observation);
  assert.ok(line, "a blind side must be reported");
  assert.match(line, /^blind beside you:/);
  for (const side of ["southwest", "south", "southeast", "west", "northwest"]) {
    assert.ok(line.includes(side), `${side} should be listed as blind`);
  }
  assert.ok(!line.includes("north,"), "a drawn side is not blind");
  assert.ok(!line.includes(" east"), "a drawn side is not blind");
});

test("nothing is reported as blind once every side is drawn", () => {
  const tiles = [{ x: 5, y: 5, text: "@" }];
  for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
    tiles.push({ x: 5 + dx, y: 5 + dy, text: "#" });
  }
  assert.equal(blindDirectionsLine({ player: { x: 5, y: 5 }, tiles }), null);
});

test("no player means no claim about blind sides", () => {
  assert.equal(blindDirectionsLine({ tiles: [] }), null);
  assert.equal(blindDirectionsLine(null), null);
});
