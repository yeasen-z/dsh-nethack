// Run: node --test plugins/dsh-nethack/tests/direction-engine.mjs
// Starts a standalone WASM worker; never touches the Host's live game slot.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { NetHackGame, DIRECTIONS } from "../lib/game.mjs";

async function settled(game, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = game.observe();
    if (!["starting", "running"].includes(state.waiting_for)) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`engine did not settle: ${JSON.stringify(game.observe().prompt)}`);
}

async function pastPages(game) {
  for (let i = 0; i < 12; i++) {
    const state = await settled(game);
    if (state.waiting_for !== "more") return state;
    assert.equal(game.respond(" ").accepted, true);
  }
  throw new Error("too many pages");
}

async function askDirection(game) {
  let state;
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(game.act({ action: "open" }).accepted, true);
    state = await pastPages(game);
    // A randomly generated start beside exactly one closed door can auto-open
    // it without asking; once open, the next command asks normally.
    if (state.waiting_for !== "command") break;
  }
  assert.equal(state.waiting_for, "direction", JSON.stringify(state.messages));
  assert.deepEqual(state.prompt, {
    kind: "direction", question: "In what direction?", choices: "12346789<>.s",
  });
  return state;
}

test("actual engine: direction classification, numpad replies and no buffered stray commands", { timeout: 25000 }, async (t) => {
  const game = new NetHackGame({ moduleUrl: createRequire(import.meta.url).resolve("@neth4ck/wasm-367"), name: "DirectionTest" });
  // Cleanup on test cancellation too, not only normal return or assertion failure.
  t.after(() => game.stop());
  game.start();
  try {
    assert.equal((await pastPages(game)).waiting_for, "command");
    game.takeNewMessages();

    // Reproduce the reported output through the intentionally raw human-key path.
    await askDirection(game);
    assert.equal(game.sendKeys("h").accepted, true);
    assert.equal((await pastPages(game)).waiting_for, "command");
    const invalid = game.takeNewMessages();
    assert.ok(invalid.includes("cmdassist: Invalid direction key!"));
    assert.ok(invalid.includes("Valid direction keys are:"));
    assert.ok(invalid.some((line) => /7\s+8\s+9/.test(line)));

    // Reject invalid answers WITHOUT sending even the first character. Previously
    // "north" caused two invalid-direction screens, then an unrelated item prompt.
    const before = await askDirection(game);
    for (const reply of ["h", "j", "k", "l", "y", "n", "north", "west", "88", "8\n", "5", "", " "]) {
      assert.deepEqual(game.respond(reply), { accepted: false, reason: "invalid_direction_reply" }, JSON.stringify(reply));
      assert.equal(game.observe().state_version, before.state_version);
      assert.equal(game.observe().waiting_for, "direction");
    }
    assert.equal(game.act({ action: "move", direction: "north" }).accepted, false);
    assert.equal(game.respond("\u001b").accepted, true);
    assert.equal((await pastPages(game)).waiting_for, "command");
    game.takeNewMessages();

    assert.deepEqual(DIRECTIONS, { north: "8", northeast: "9", east: "6", southeast: "3", south: "2", southwest: "1", west: "4", northwest: "7" });
    for (const key of [...Object.values(DIRECTIONS), "<", ">", ".", "s"]) {
      await askDirection(game);
      assert.equal(game.respond(key).accepted, true);
      let after = await pastPages(game);
      // Opening vertically can enter looting, which asks its own getdir question.
      if (after.waiting_for === "direction") {
        assert.match(after.prompt.question, /in what direction\?$/i);
        assert.equal(game.respond("\u001b").accepted, true);
        after = await pastPages(game);
      }
      assert.equal(after.waiting_for, "command", `${key}: ${JSON.stringify(after.prompt)}; ${JSON.stringify(after.messages)}`);
      assert.ok(!game.takeNewMessages().some((line) => line.includes("Invalid direction key")), key);
    }

    // Ordinary yes/no prompts must not be reclassified or have n rejected.
    assert.equal(game.act({ action: "raw_keys", keys: "S" }).accepted, true);
    const save = await pastPages(game);
    assert.equal(save.waiting_for, "yn");
    assert.match(save.prompt.question, /save/i);
    assert.equal(game.respond("n").accepted, true);
    assert.equal((await pastPages(game)).waiting_for, "command");
  } finally {
    await game.stop();
  }
});
