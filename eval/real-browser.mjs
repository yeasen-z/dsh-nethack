import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { startRuntimeServer } from "../scripts/serve-runtime.mjs";

const server = await startRuntimeServer(0);
let browser;
let passed = 0;
const pass = name => { console.log(`PASS  RealRuntime/${name}`); passed++; };
try {
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.click("#start");
  await page.waitForFunction(() => window.nhchat || document.querySelector("#error").textContent);
  assert.equal(await page.locator("#error").textContent(), "");

  const observe = () => page.evaluate(() => window.nhchat.session.observe());
  const run = action => page.evaluate(action => window.nhchat.run(action), action);
  const step = request => page.evaluate(request => window.nhchat.session.step(request), request);
  const request = async (action, id, overrides = {}) => {
    const observation = await observe();
    const control = await page.evaluate(() => window.nhchat.session.controlStatus);
    return { request_id: id, session_id: observation.session_id, expected_state_version: observation.state_version,
      control_epoch: control.epoch, source: "human", action, ...overrides };
  };
  // The pin exposes its opening story and tutorial menu. Always decline the
  // tutorial by its actual accelerator; never blindly send startup key strings.
  for (let i = 0; i < 12; i++) {
    const input = (await observe()).input;
    if (input.kind === "command") break;
    let response;
    if (input.kind === "more") response = { kind: "more" };
    else if (input.kind === "menu" && input.options.some(option => option.letter === "n")) response = { kind: "menu", optionIds: [input.options.find(option => option.letter === "n").optionId] };
    else throw new Error(`Unexpected startup prompt: ${JSON.stringify(input)}`);
    assert.equal((await run({ action: "respond", promptId: input.promptId, response })).input_committed, true);
  }
  const initial = await observe();
  assert.equal(initial.input.kind, "command");
  assert.match(initial.capabilities.runtime_id, /^nh5\.0-wasm/);
  assert.ok(initial.player.hp > 0 && initial.player.max_hp >= initial.player.hp);
  assert.ok(initial.player.position.x > 0 && initial.player.position.y >= 0);
  assert.ok(initial.tiles.length > 0 && initial.turn >= 1);
  pass("startup-typed-prompts-and-decoded-observation");

  assert.deepEqual(await observe(), initial);
  assert.deepEqual(await observe(), initial);
  pass("observe-does-not-advance-time");

  const wait = await run({ action: "wait" });
  assert.equal(wait.status, "completed");
  assert.equal(wait.turn_delta, 1);
  assert.deepEqual(wait.observation.player.position, initial.player.position);
  pass("wait-consumes-one-real-turn");

  const duplicateRequest = await request({ action: "wait" }, "duplicate-real");
  const first = await step(duplicateRequest);
  const after = await observe();
  assert.deepEqual(await step(duplicateRequest), first);
  assert.deepEqual(await observe(), after);
  pass("duplicate-request-does-not-execute-twice");

  const stale = await step(await request({ action: "wait" }, "stale-real", { expected_state_version: initial.state_version }));
  assert.equal(stale.reason, "stale_state_version");
  assert.equal(stale.input_committed, false);
  assert.deepEqual(await observe(), after);
  pass("stale-version-commits-no-input");

  const directions = [{ direction: "east", x: 1, y: 0 }, { direction: "west", x: -1, y: 0 }, { direction: "south", x: 0, y: 1 }, { direction: "north", x: 0, y: -1 }];
  const neighbor = directions.find(delta => after.tiles.some(tile => tile.x === after.player.position.x + delta.x && tile.y === after.player.position.y + delta.y && tile.terrain === "floor"));
  assert.ok(neighbor, "The real starting room must expose an adjacent floor tile");
  const move = await run({ action: "move", direction: neighbor.direction });
  assert.equal(move.input_committed, true);
  // An engraving or message may require explicit More acknowledgements.
  for (let i = 0; i < 10 && (await observe()).input.kind === "more"; i++) {
    const input = (await observe()).input;
    await run({ action: "respond", promptId: input.promptId, response: { kind: "more" } });
  }
  const moved = await observe();
  assert.equal(moved.input.kind, "command");
  assert.deepEqual(moved.player.position, { x: after.player.position.x + neighbor.x, y: after.player.position.y + neighbor.y });
  assert.ok(moved.turn > after.turn);
  pass("move-updates-real-position-and-turn");

  const open = await run({ action: "open", direction: "east" });
  assert.equal(open.status, "needs_input");
  assert.equal(open.observation.input.kind, "direction");
  const promptId = open.observation.input.promptId;
  const stalePrompt = await step(await request({ action: "respond", promptId: "expired", response: { kind: "direction", direction: "east" } }, "stale-prompt-real"));
  assert.equal(stalePrompt.reason, "prompt_mismatch");
  assert.equal(stalePrompt.input_committed, false);
  assert.deepEqual(await observe(), open.observation);
  pass("open-stops-at-direction-and-rejects-stale-prompt");
  const response = await run({ action: "respond", promptId, response: { kind: "direction", direction: "east" } });
  assert.equal(response.input_committed, true);
  assert.equal(response.observation.input.kind, "command");
  pass("typed-direction-response-settles");

  const pickup = await run({ action: "pickup" });
  assert.equal(pickup.input_committed, true);
  assert.ok(["completed", "needs_input"].includes(pickup.status));
  pass("pickup-reaches-real-runtime");

  const oldRequest = await request({ action: "wait" }, "old-epoch-real");
  const takeover = await page.evaluate(() => window.nhchat.session.takeOver());
  assert.ok(takeover.epoch_after > takeover.epoch_before);
  assert.equal((await step(oldRequest)).reason, "stale_control_epoch");
  assert.deepEqual(await observe(), takeover.observation);
  pass("takeover-rejects-old-epoch");
  assert.deepEqual(errors, []);
  console.log(`\n${passed} real-browser checks passed, 0 skipped`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
