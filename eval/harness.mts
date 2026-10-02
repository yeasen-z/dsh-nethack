/**
 * Non-visual scripted harness for the middleware contract.
 * Proves "client independence": imports ONLY @nhchat/* public entry points,
 * no UI components, and drives a real adapter session from a script.
 *
 * NOTE: this harness is not a promise that the chosen WASM runtime already
 * runs in Node; headless execution of the real build is a later integration
 * task (handoff section 11). It runs against the labeled fake runtime today.
 */
import { MiddlewareSession } from "@nhchat/core";
import type { ActionRequest, Observation } from "@nhchat/core";
import { FakeWasmAdapter } from "@nhchat/adapter-wasm";
import { walkToExecutor } from "@nhchat/skills";

export async function createHarnessSession(sessionId = "session-harness") {
  const session = new MiddlewareSession({
    session_id: sessionId,
    adapter: new FakeWasmAdapter(),
    skills: { walk_to: walkToExecutor },
  });
  await session.start();
  return session;
}

let reqCounter = 0;
export function humanStep(
  session: MiddlewareSession,
  obs: Observation,
  action: ActionRequest["action"],
): ActionRequest {
  return {
    request_id: `harness-${++reqCounter}`,
    session_id: obs.session_id,
    expected_state_version: obs.state_version,
    control_epoch: session.controlStatus.epoch,
    source: "human",
    action,
  };
}
