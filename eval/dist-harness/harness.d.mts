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
export declare function createHarnessSession(sessionId?: string): Promise<MiddlewareSession>;
export declare function humanStep(session: MiddlewareSession, obs: Observation, action: ActionRequest["action"]): ActionRequest;
//# sourceMappingURL=harness.d.mts.map