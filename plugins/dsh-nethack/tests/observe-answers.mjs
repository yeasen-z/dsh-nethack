// Run: node --test plugins/dsh-nethack/tests/observe-answers.mjs
// The engine's own choice string ("12346789<>.s") reads as noise, so the model
// guessed at replies. These lines must list the keys that actually work.
import assert from "node:assert/strict";
import test from "node:test";

import { answerLines } from "../lib/index.mjs";
import { NetHackGame } from "../lib/game.mjs";

test("a direction prompt lists the numpad keys and refuses to offer vi keys", () => {
  const text = answerLines({ kind: "direction", question: "In what direction?", choices: "12346789<>.s" }).join("\n");
  for (const key of ["1", "2", "3", "4", "6", "7", "8", "9", "<", ">", "s"]) assert.ok(text.includes(key));
  assert.match(text, /NOT accepted/);
  assert.match(text, /Escape = cancel/);
});

test("other prompt kinds explain how to answer", () => {
  assert.match(answerLines({ kind: "yn", choices: "ynaq" }).join(" "), /y n a q/);
  assert.match(answerLines({ kind: "menu", how: "PICK_ONE" }).join(" "), /letter/);
  assert.match(answerLines({ kind: "line" }).join(" "), /typed text/);
  assert.match(answerLines({ kind: "more" }).join(" "), /space/);
  assert.equal(answerLines(null).length, 0);
});

test("the engine really accepts digits and really refuses vi letters", { timeout: 60000 }, async () => {
  // Guards the claim above: if a future engine build flips this, the listed keys
  // would be wrong and the model would be sent in circles again.
  const moduleUrl = new URL("../node_modules/@neth4ck/wasm-367/src/index.js", import.meta.url).href;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = async (game, t = 8000) => {
    const end = Date.now() + t;
    while (Date.now() < end) {
      const state = game.observe();
      if (!["starting", "running"].includes(state.waiting_for)) return state;
      await sleep(40);
    }
    return game.observe();
  };
  for (const [key, accepted] of [["2", true], ["j", false]]) {
    const game = new NetHackGame({ moduleUrl, name: `Dir-${key}` });
    try {
      game.start();
      let state = await settle(game);
      let pages = 0;
      while (state.waiting_for === "more" && pages++ < 25) { game.respond(" "); state = await settle(game); }
      game.act({ action: "open" });            // "In what direction?"
      state = await settle(game);
      assert.equal(state.waiting_for, "direction");
      assert.equal(game.respond(key).accepted, accepted, `reply ${key}`);
    } finally {
      await game.stop();
    }
  }
});
