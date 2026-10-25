/**
 * Map reasoning for `nethack_act {action:"explore"}`.
 *
 * Deliberately pure: it takes the tile list `observe()` reports and returns a
 * plan, touching no engine. That keeps the interesting part (which tile is worth
 * walking to, and how to get there) testable without spinning up NetHack.
 *
 * The tile set accumulates every cell the engine has drawn for this level, so
 * "seen" is simply "present in the grid" — there is no separate memory to keep,
 * and `map_clear` (a new level) resets it along with the map.
 */

/**
 * The eight directions, in the engine's `number_pad:1` keymap.
 *
 * Diagonals matter: without them a room is crossed with two steps per diagonal,
 * and a corridor's turns are awkward. The engine refuses a diagonal that would
 * squeeze between two blocked cells, which `diagonalAllowed` mirrors.
 */
export const STEPS = [
  { name: "north", dx: 0, dy: -1 },
  { name: "south", dx: 0, dy: 1 },
  { name: "east", dx: 1, dy: 0 },
  { name: "west", dx: -1, dy: 0 },
  { name: "northeast", dx: 1, dy: -1 },
  { name: "northwest", dx: -1, dy: -1 },
  { name: "southeast", dx: 1, dy: 1 },
  { name: "southwest", dx: -1, dy: 1 },
];

/** Terrain the character can never enter. */
const IMPASSABLE = new Set(["wall", "water", "unknown"]);

export function posKey(x, y) {
  return `${x},${y}`;
}

export function buildGrid(tiles) {
  const grid = new Map();
  for (const tile of tiles ?? []) grid.set(posKey(tile.x, tile.y), tile);
  return grid;
}

/**
 * Whether the character may stand on this cell.
 *
 * A closed door is not passable — walking into one only reports that it is
 * closed, and the door must be opened first — but it is *interesting*, so
 * `isClosedDoor` lets a caller report it as the reason exploration stopped.
 * Monsters and items sit on ordinary floor, so their glyphs are passable; a
 * monster is dealt with by stopping when one comes near, not by the pathfinder.
 */
export function isPassable(tile) {
  if (!tile) return false;
  if (tile.terrain === "door_closed") return false;
  return !IMPASSABLE.has(tile.terrain);
}

/**
 * Whether a route should cross this cell.
 *
 * A creature standing on floor leaves the floor passable but is not something to
 * walk through: stepping onto it attacks instead of moving, which spends a turn
 * and leaves the character where it was — measured, and it also means the pet
 * gets hit. Routing around creatures keeps `explore` from wasting turns on
 * accidental attacks and lets the caller's adjacency check decide when a fight is
 * worth stopping for. Floor items are fine to walk over.
 *
 * The glyphs: `a-z`/`A-Z` monsters (pets included), `@` humans, `&` demons,
 * `;` sea monsters, `:` lizards, `'` golems, `"` shades. `"` is also the amulet
 * symbol on the floor, so this may route around a dropped amulet: harmless, and
 * better than swinging at an unknown creature.
 */
const CREATURE = /^[A-Za-z@&;:'"]$/;

export function isWalkThrough(tile) {
  if (!isPassable(tile)) return false;
  return !CREATURE.test(tile.text ?? "");
}

export function isClosedDoor(tile) {
  return tile?.terrain === "door_closed";
}

export function isStairs(tile) {
  return tile?.terrain === "stairs_down" || tile?.terrain === "stairs_up";
}

/**
 * Mirror the engine's diagonal rule: a diagonal step is legal only when at least
 * one of the two orthogonal cells beside it can be entered, otherwise the
 * character would be squeezing through a corner between two walls.
 */
export function diagonalAllowed(grid, from, step, passable = isPassable) {
  if (step.dx === 0 || step.dy === 0) return true;
  const side = grid.get(posKey(from.x + step.dx, from.y));
  const other = grid.get(posKey(from.x, from.y + step.dy));
  return passable(side) || passable(other);
}

/**
 * Every legal one-step move from a cell.
 *
 * `passable` decides the diagonal rule (a question of geometry — walls beside the
 * step), while `enterable` decides whether the destination is somewhere we want
 * to go. Keeping them apart matters: a creature next to a diagonal does not make
 * the diagonal geometrically illegal, so using one predicate for both would
 * refuse moves the engine would accept and can make a corridor look impassable.
 */
export function movesFrom(grid, from, passable = isPassable, enterable = null) {
  const mayEnter = enterable ?? passable;
  const out = [];
  for (const step of STEPS) {
    const to = { x: from.x + step.dx, y: from.y + step.dy };
    const tile = grid.get(posKey(to.x, to.y));
    if (!mayEnter(tile)) continue;
    if (!diagonalAllowed(grid, from, step, passable)) continue;
    out.push({ name: step.name, to, tile });
  }
  return out;
}

/**
 * Shortest path from `from` to `goal`, or null when there is none.
 *
 * Breadth-first, so the result is the fewest steps; diagonal moves are allowed,
 * which makes "fewest steps" the true distance under the engine's rules.
 * Returns the steps to take, each `{name, x, y}` — the start cell is not included.
 */
export function findPath(grid, from, goal, passable = isPassable, enterable = null) {
  const startKey = posKey(from.x, from.y);
  const goalKey = posKey(goal.x, goal.y);
  if (startKey === goalKey) return [];
  const cameFrom = new Map([[startKey, null]]);
  const queue = [from];
  while (queue.length) {
    const current = queue.shift();
    for (const move of movesFrom(grid, current, passable, enterable)) {
      const key = posKey(move.to.x, move.to.y);
      if (cameFrom.has(key)) continue;
      cameFrom.set(key, { from: current, name: move.name });
      if (key === goalKey) return rebuild(cameFrom, startKey, key);
      queue.push(move.to);
    }
  }
  return null;
}

function rebuild(cameFrom, startKey, goalKey) {
  const path = [];
  let cursor = goalKey;
  while (cursor !== startKey) {
    const back = cameFrom.get(cursor);
    if (!back) return null;
    const [x, y] = cursor.split(",").map(Number);
    path.push({ name: back.name, x, y });
    cursor = posKey(back.from.x, back.from.y);
  }
  return path.reverse();
}

/**
 * Cells that touch somewhere never seen — the places worth walking to.
 *
 * A cell is frontier when it can be entered and at least one of its eight
 * neighbours is absent from the grid. Since the engine draws every visible cell,
 * an absent neighbour is genuinely unexplored rather than merely off-screen.
 * `exhausted` holds cells already tried that revealed nothing, which stops a
 * level's outer border from being walked to forever.
 */
export function frontierTargets(grid, { exhausted = new Set() } = {}) {
  const out = [];
  for (const tile of grid.values()) {
    if (!isPassable(tile)) continue;
    if (exhausted.has(posKey(tile.x, tile.y))) continue;
    for (const step of STEPS) {
      if (!grid.has(posKey(tile.x + step.dx, tile.y + step.dy))) {
        out.push(tile);
        break;
      }
    }
  }
  return out;
}

/**
 * Nearest frontier cell reachable from `from`, with the path to it.
 *
 * One breadth-first sweep finds whichever frontier cell is closest, so this
 * costs the same as a path to a single goal no matter how many candidates there
 * are. The character's own cell is never a destination: it would give an empty
 * path and look like there was nothing to do.
 */
export function nearestFrontier(grid, from, { exhausted = new Set(), passable = isPassable, enterable = isWalkThrough } = {}) {
  const frontier = new Set();
  for (const tile of frontierTargets(grid, { exhausted })) {
    frontier.add(posKey(tile.x, tile.y));
  }
  const startKey = posKey(from.x, from.y);
  frontier.delete(startKey);
  if (frontier.size === 0) return null;

  const cameFrom = new Map([[startKey, null]]);
  const queue = [from];
  while (queue.length) {
    const current = queue.shift();
    for (const move of movesFrom(grid, current, passable, enterable)) {
      const key = posKey(move.to.x, move.to.y);
      if (cameFrom.has(key)) continue;
      cameFrom.set(key, { from: current, name: move.name });
      if (frontier.has(key)) {
        const [x, y] = key.split(",").map(Number);
        return { target: { x, y }, path: rebuild(cameFrom, startKey, key) ?? [] };
      }
      queue.push(move.to);
    }
  }
  return null;
}

/**
 * The cells next to the character that have never been seen.
 *
 * In an unlit corridor the engine draws only where the character has been, so
 * the frontier can be the character's *own* cell with unexplored ground beside
 * it. `nearestFrontier` cannot help there — there is no known cell to walk to —
 * so the caller tries a step into the dark and learns what is there.
 */
export function unseenNeighbours(grid, from) {
  const out = [];
  for (const step of STEPS) {
    const to = { x: from.x + step.dx, y: from.y + step.dy };
    if (!grid.has(posKey(to.x, to.y))) out.push({ name: step.name, x: to.x, y: to.y });
  }
  return out;
}

/**
 * Closed doors next to a cell the character can already reach.
 *
 * Reported when exploration stalls: a door is not a reason to give up, but it
 * does need a decision (open it, or leave it), so the model is told where it is.
 */
export function reachableClosedDoors(grid, from) {
  const seen = new Set([posKey(from.x, from.y)]);
  const queue = [from];
  const doors = [];
  while (queue.length) {
    const current = queue.shift();
    for (const step of STEPS) {
      const key = posKey(current.x + step.dx, current.y + step.dy);
      if (seen.has(key)) continue;
      const tile = grid.get(key);
      if (isClosedDoor(tile)) {
        seen.add(key);
        doors.push(tile);
        continue;
      }
      if (!isPassable(tile)) continue;
      seen.add(key);
      queue.push({ x: tile.x, y: tile.y });
    }
  }
  return doors;
}