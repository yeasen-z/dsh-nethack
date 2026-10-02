/**
 * apps/web — first client host. NOTE: this is currently the *wiring* for the
 * web client (session + chat orchestration + demo script). The visual map/chat
 * panels are TODO; per the handoff we do not redesign the NetHack frontend in
 * iteration 1. This file proves "client independence": it imports only public
 * @nhchat/* entry points and never touches the runtime directly.
 *
 * Run with: npm run demo
 */
import { MiddlewareSession } from "@nhchat/core";
import type { Observation, SessionEvent } from "@nhchat/core";
import { FakeWasmAdapter } from "@nhchat/adapter-wasm";
import { walkToExecutor } from "@nhchat/skills";
import { OfflineDemoProvider, Orchestrator } from "@nhchat/agent";

const GLYPHS: Record<string, string> = {
  floor: ".", wall: "#", door_closed: "+", door_open: "'", corridor: "-",
  stairs_down: ">", stairs_up: "<", water: "~", unknown: "?",
};

export function renderMap(obs: Observation): string {
  const W = 16, H = 12;
  const grid: string[][] = Array.from({ length: H }, () => Array(W).fill(" "));
  for (const t of obs.tiles) {
    const g = GLYPHS[t.terrain] ?? "?";
    grid[t.y][t.x] = t.visibility === "remembered" ? g.toLowerCase() : g;
  }
  for (const e of obs.entities) {
    grid[e.position.y][e.position.x] = e.kind === "monster" ? "r" : e.kind === "object" ? "!" : "?";
  }
  grid[obs.player.position.y][obs.player.position.x] = "@";
  const header = `level ${obs.level_id} | turn ${obs.turn} | hp ${obs.player.hp}/${obs.player.max_hp} | input: ${obs.input.kind}`;
  return [header, ...grid.map((row) => row.join(""))].join("\n");
}

async function main() {
  console.log("=".repeat(72));
  console.log("NetHack-Chat vertical slice demo  (FAKE runtime: fake-nh@0.1 — NOT a real game session)");
  console.log("=".repeat(72));

  const session = new MiddlewareSession({
    session_id: "session-demo",
    adapter: new FakeWasmAdapter(),
    skills: { walk_to: walkToExecutor },
  });
  await session.start();

  // Trace logging: every event gets an ordered line (handoff section 13).
  const tracePath = `trace-${session.sessionId}.jsonl`;
  session.subscribe((ev: SessionEvent) => {
    const tag = `[seq ${String(ev.seq).padStart(3, "0")}] epoch=${ev.control_epoch} turn=${ev.turn} v${ev.state_version}`;
    console.log(`  ${tag} ${ev.type}${ev.request_id ? ` req=${ev.request_id}` : ""}${ev.task_id ? ` task=${ev.task_id}` : ""}`);
  });

  const provider = new OfflineDemoProvider();
  const agent = new Orchestrator(session);

  const say = async (text: string) => {
    console.log(`\nuser > ${text}`);
    const out = await agent.handleUserText(text, provider);
    console.log(`bot  [${out.kind}] ${out.text}`);
    return out;
  };

  // 1) Read-only QA: grounded answer, ZERO game input.
  let obsBefore = await session.observe();
  await say("How much health do I have?");
  let obsAfter = await session.observe();
  console.log(assertLine("QA consumed no game time", obsBefore.turn === obsAfter.turn && obsBefore.state_version === obsAfter.state_version));

  // 2) Primitive typed action via language.
  await say("Move one tile east.");

  // 3) Prompt handling: open creates a direction prompt; respond completes it.
  await say("open west"); // direction prompt opens; MVP hands text/prompt UI to human
  await say("wait"); // cannot fire mid-prompt -> needs_input surfaces the prompt
  const st = (await session.observe()).input;
  console.log(`     input state now: ${st.kind}`);

  // 4) Delegation: "Walk to that door" -> grounded target -> walk_to -> steps.
  const del = await say("Walk to that door.");
  console.log(assertLine("delegation reached the door-adjacent tile", del.kind === "delegated" && del.text.includes("completed")));

  console.log("\n--- map after walk_to ---\n" + renderMap(await session.observe()));

  // 5) Human takeover mid-skill: start another walk, stop immediately, verify
  //    no further uncommitted steps execute afterwards.
  const handle = await session.executeSkill({
    task_id: "task-cancel-demo",
    session_id: session.sessionId,
    control_epoch: session.controlStatus.epoch,
    spec: {
      skill: "walk_to",
      parameters: { level_id: "level-1", target: { x: 8, y: 6 } },
      constraints: { max_actions: 30 },
    },
  });
  const stop = await session.takeOver(); // Stop/Take over independent of the model
  const report = await handle.done;
  console.log(`\ncancelled tasks: ${stop.cancelled_tasks.join(", ") || "(none)"}`);
  console.log(`task outcome after takeover: ${report.outcome} (${JSON.stringify(report.reason)})`);
  console.log(`owner: ${session.controlStatus.owner} (epoch ${stop.epoch_after})`);
  console.log(assertLine("takeover returned ownership to human", stop.observation && session.controlStatus.owner === "human"));

  // 6) Stale AI input must never execute after takeover.
  const stale = await session.step({
    request_id: "stale-1",
    session_id: session.sessionId,
    expected_state_version: (await session.observe()).state_version,
    control_epoch: stop.epoch_before, // OLD epoch
    source: "agent",
    action: { action: "wait" },
  });
  console.log(`stale-epoch step -> ${stale.status} (${stale.reason}), committed=${stale.input_committed}`);
  console.log(assertLine("stale epoch rejected without runtime input", stale.status === "rejected" && !stale.input_committed));

  // 7) Duplicate request id returns prior result, no double execution.
  const before = await session.observe();
  const r1 = await session.step({ request_id: "dup-1", session_id: session.sessionId, expected_state_version: before.state_version, control_epoch: stop.epoch_after, source: "human", action: { action: "wait" } });
  const mid = await session.observe();
  const r2 = await session.step({ request_id: "dup-1", session_id: session.sessionId, expected_state_version: mid.state_version, control_epoch: stop.epoch_after, source: "human", action: { action: "wait" } });
  const after = await session.observe();
  console.log(`dup: first=${r1.status}, second=${r2.status} reason=${r2.reason}, extra turns=${after.turn - mid.turn}`);
  console.log(assertLine("duplicate request did not re-execute", r2.status !== "completed" || after.turn === mid.turn));

  // 8) Pickup menu demonstration (needs_input + exact-prompt response).
  // Walk onto the potion tile area first: move toward door/open then east room.
  await humanScripted(session, stop.epoch_after);

  const finalObs = await session.observe();
  console.log("\n--- final map ---\n" + renderMap(finalObs));
  console.log(`turn delta over whole run: ${finalObs.turn} game turns`);

  // Persist trace for inspection (event log replay support).
  const fs = await import("node:fs/promises");
  await fs.writeFile(tracePath, session.eventLog.toTraceJsonl());
  console.log(`trace written: ${tracePath}`);
}

/** Drive a few direct human inputs through the SAME scheduler path. */
async function humanScripted(session: MiddlewareSession, epoch: number) {
  // Open the door properly: 'open east' from corridor -> respond direction east.
  let obs = await session.observe();
  // Navigate human-style to just west of the door if not there.
  while (!(obs.player.position.x === 8 && obs.player.position.y === 6)) {
    const dir = obs.player.position.x < 8 ? "east" : obs.player.position.y < 6 ? "south" : obs.player.position.y > 6 ? "north" : "west";
    const r = await session.step({
      request_id: `hum-${obs.state_version}`,
      session_id: session.sessionId,
      expected_state_version: obs.state_version,
      control_epoch: epoch,
      source: "human",
      action: { action: "move", direction: dir },
    });
    if (r.status !== "completed") break;
    obs = r.observation;
  }
  const openRes = await session.step({
    request_id: `hum-open-${obs.state_version}`,
    session_id: session.sessionId,
    expected_state_version: obs.state_version,
    control_epoch: epoch,
    source: "human",
    action: { action: "open", direction: "east" },
  });
  console.log(`\nhuman open -> ${openRes.status} (prompt: ${openRes.pending_prompt?.kind ?? "none"})`);
  const p = openRes.observation.input;
  if (p.kind === "direction") {
    const ans = await session.step({
      request_id: `hum-answer-${p.promptId}`,
      session_id: session.sessionId,
      expected_state_version: openRes.observation.state_version,
      control_epoch: epoch,
      source: "human",
      action: { action: "respond", promptId: p.promptId, response: { kind: "direction", direction: "east" } },
    });
    console.log(`human answered direction prompt -> ${ans.status}`);
  }
  // Walk through the opened door into the east room (two steps east).
  let o2 = (await session.observe());
  for (let i = 0; i < 3 && o2.player.position.x < 11; i++) {
    const r = await session.step({
      request_id: `hum-e${i}-${o2.state_version}`,
      session_id: session.sessionId,
      expected_state_version: o2.state_version,
      control_epoch: epoch,
      source: "human",
      action: { action: "move", direction: "east" },
    });
    o2 = r.observation;
    if (r.status !== "completed") break;
  }
  // Pickup on the potion tile -> auto (single item) completes.
  const pk = await session.step({
    request_id: `hum-pickup-${o2.state_version}`,
    session_id: session.sessionId,
    expected_state_version: o2.state_version,
    control_epoch: epoch,
    source: "human",
    action: { action: "pickup" },
  });
  console.log(`human pickup -> ${pk.status}: ${pk.observation.messages.at(-1) ?? ""}`);
  // Stale response attempt against a resolved prompt:
  const staleResp = await session.step({
    request_id: `hum-stale-resp`,
    session_id: session.sessionId,
    expected_state_version: (await session.observe()).state_version,
    control_epoch: epoch,
    source: "human",
    action: { action: "respond", promptId: "prompt-does-not-exist", response: { kind: "cancel" } },
  });
  console.log(`stale prompt response -> ${staleResp.status} (${staleResp.reason})`);
}

function assertLine(label: string, cond: boolean): string {
  return `     [${cond ? "PASS" : "FAIL"}] ${label}`;
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
