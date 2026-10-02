# Contracts Reference (authoritative type locations)

All types live in `packages/core/src/types.ts`; this doc explains intent.
These are PROPOSED contracts, not NetHack exports.

## Observation (§5)
Stable snapshot at an input boundary. Player-visible only. Rules: uncertainty
as `null`; visible vs remembered; coordinates need `level_id`; `state_version`
bumps on relevant changes including no-turn menu transitions; references are
snapshot-scoped; reads never inject inputs.

## Actions & input states (§6)
`move|wait|open|pickup|respond` + `PromptResponse` variants. Adapter normalizes
engine prompts into `InputState` (command/direction/menu/yes_no/more/text/
game_over). Semantic actions may span several low-level inputs but stop at any
unexpected prompt. Stale responses (wrong promptId/state version) never reach
the runtime. Delegated movement rejects observed-occupied targets and stops on
newly seen monsters.

## Requests/results (§7)
`ActionRequest{request_id, session_id, expected_state_version, control_epoch,
source, task_id?, action}`. Validation ladder in `session.ts`:
schema → session id → dedup → capability → lease → epoch → state version →
terminal → occupancy → prompt match → enqueue → re-check epoch/version right
before commit. `StepResult` reports status/reason/observation/turn_delta/
input_committed/pending_prompt. Uncertain commits reconcile, never retry.

## Control (§8)
Modes: human/suggest/approval/delegated/agent. Epoch bumps on ownership change
or stop; captured per request/task/provider-call; late work from old epochs is
rejected pre-commit. Stop settles committed work to the next boundary and
exposes the current prompt.

## Skills (§9)
`walk_to` executes exclusively via `step()`, revalidating after each action;
budgets enforced before issuing the next step; outcomes completed/interrupted/
blocked with machine reasons like ["walk_to","monster_visible"].

## Agent (§10)
`AgentDecision` union; provider results are proposals. The orchestrator stamps
core-generated metadata (source, epoch, fresh state version) itself. Malformed
output ⇒ explanation, zero runtime input.

## Events (§13)
See `SessionEventType`. Trace JSONL via `session.eventLog.toTraceJsonl()`.
Playback reconstructs recorded state; deterministic re-execution requires
pinned builds/RNG/seeds and is a separate feature.
