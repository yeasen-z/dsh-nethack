# Developer Handoff — NetHack-Chat (Middleware-first architecture)

Updated: 2026-09-30 · Revision: Middleware-first architecture
Status: design & implementation brief (implementation status tracked in README §5).

This is the verbatim-in-substance reference copy of the project brief that this
repository implements. Where this repo deviates or stubs something, the code
comments cite the relevant section number below.

## 1. Project Definition
NetHack-Chat is a middleware and interaction layer exposing NetHack as a
language-controllable environment for humans and LLM agents. Tagline: Play
NetHack with natural language. Core deliverable: reusable, model-independent
interface for observing the game, executing typed actions, running bounded
skills, managing human/AI control. First client: NetHack-Chat Web. Future
evaluation runner uses the same contracts. First version: TypeScript library
beside the browser app, game in a Web Worker; public interface independent of
UI and LLM provider. Human and AI operate the same character in the same
session. Separate NPC/companion control is out of MVP scope.

## 2. Agreed Decisions
Core = middleware; first runtime = NetHack 5.0 WASM + shim/WebUI adapter;
first client = browser view + chat + direct controls; core language TypeScript
(async worker interfaces); LLM interprets language, answers grounded questions,
proposes actions/skills; middleware validates, serializes, executes, observes,
interrupts, logs; skills deterministic/bounded, recheck after each action; MVP
skill walk_to, then explore_room; later clients: eval runner, alt frontends;
deferred: full autonomy, multi-agent, complete command coverage, sophisticated
memory. Milestone 1 = observe() + step() + reliable control ownership BEFORE
significant UI work.

## 3. Runtime and Upstream Grounding
Use existing NetHack WASM/shim ecosystem. References checked 2026-09-30:
NetHack/NetHack (5.0.0), e3sh/Nethack-wasm-webUI (initial candidate), official
Cross-compiling doc, facebookresearch/nle (later experimental adapter only).
All schemas are proposed contracts, not upstream exports. Before the main app:
(1) pin revisions/toolchain; (2) reproduce browser build, record commands;
(3) locate map/status/message/menu callbacks and input delivery points; (4)
verify input requests, turn completion, termination, save/load surfacing; (5)
inventory player-visible observations + minimal adapter changes; (6) record
licenses/notices per codebase and tileset. Keep upstream changes small and
isolated. PTY/NLE fallback requires an explicit architecture decision.

## 4. Architecture and Package Boundaries
Components and ownership: runtime adapter (shim callbacks, input encoding,
input-state normalization, stable observation boundaries; independent of UI and
prompts); middleware core (session state, action schemas, validation,
single-writer scheduling, control leases, cancellation, event log; independent
of providers/renderers); skills (navigation, budgets, progress detection, stop
rules; actions only via core); agent orchestration (intent, provider calls,
concise explanations, structured proposals; no raw engine memory or arbitrary
key injection); web client (map, chat, status, inventory, proposals, control
status, Stop/Take over; no engine-specific execution logic); evaluation client
(task setup, measurements, trace consumption; no browser components). One
write path into the runtime. Optional backend proxies provider calls and holds
credentials; backend response is a proposal until locally validated.

## 5. Observation Contract
observe() returns a stable snapshot without advancing game time; published at
recognized input boundaries. Minimum fields: schema_version, session_id,
state_version, turn; player location/HP/conditions/level id; visible terrain/
entities and separately marked remembered terrain; player-known inventory;
recent messages; current input state and supported actions; terminal status;
adapter capabilities. Rules: (1) player-visible info only; (2) preserve
uncertainty (null/unknown); (3) visible vs remembered distinguished, old
monster positions never presented as current; (4) coordinates origin upper-
left, x east, y south, meaningful only with level id; (5) state_version
increases at relevant state/input-boundary changes (menu transition can change
version without consuming a turn); (6) documented reference lifetimes; (7) no
game inputs hidden inside read operations.

## 6. Typed Actions and Input States
GameAction: move(direction) | wait | open(direction) | pickup |
respond(promptId, response). PromptResponse: direction | menu(optionIds) |
yes_no | more | cancel. Adapter must represent: command, direction prompt,
menu, yes/no, more, text, busy, game over. MVP automatic text entry may remain
unsupported and hand off to human. One semantic action may require several
low-level inputs; encode only the expected action-specific sequence; stop at
unexpected prompts; never blindly inject precomputed key strings. pickup may
return needs_input with menu+promptId; later responses must match the exact
prompt and current state version; invalid/stale responses never reach runtime.
Delegated movement: reject moves into observed occupied squares; stop on newly
observed monsters (cannot guarantee safety under partial observability). Model
may only propose supported typed actions; future keyboard compatibility still
passes through the scheduler with a human source and cannot create a second
writer.

## 7. Middleware Public API
observe(), step(ActionRequest), executeSkill(SkillRequest), stop(reason?),
takeOver(), subscribe(listener). Requests carry request_id, session_id,
expected_state_version, control_epoch, source, action. Core-generated metadata
(source identity, control epoch) comes from orchestration/control, never model
output. Schema validation checks syntax; execution validation separately
checks ownership, state version, input kind, capability, task constraints.
StepResult: status completed|rejected|needs_input|cancelled|game_over; ids;
machine-readable reason; resulting observation; turn delta; whether low-level
input was committed; remaining prompt info. Invalid requests leave runtime
untouched. Duplicate request IDs return the prior result. Timeout after
uncertain commit requires reconciliation, not re-execution. step() returns at
a stable boundary, not exactly one turn. Delegated navigation uses one-step
commands, never engine run/travel macros.

## 8. Control Ownership and Interruption
Interaction mode vs execution ownership. Modes: human (answer only), suggest
(offer, no execute), approval (execute explicitly approved proposal after
revalidation), delegated (one task within declared constraints/budgets), agent
(future autonomous; cancellable, budgeted). One controller writes at a time;
all inputs pass through a serialized scheduler. control_epoch changes on
ownership transitions/cancellation; captured per task/provider request/queued
action; rechecked before committing any runtime input; late responses from
older epochs never execute. Stop/Take over: revoke AI permission immediately +
increment epoch; cancel tasks, discard uncommitted inputs/proposals; abort
provider requests when possible and ignore results regardless; let already-
committed engine processing settle to next stable boundary (no undo claims);
return ownership to human and surface the exact current prompt. Stop must be
responsive without waiting for the LLM ("Stopping" UI while runtime settles).
Movement keys must not accidentally answer pending menus during takeover.
Control transfer is reversible; game consequences generally are not.

## 9. Skill Layer
walk_to first; explore_room only when execution/interruption contract is
stable. Request shape: skill, parameters {level_id,target}, constraints
{known_tiles_only, stop_on_monster, stop_below_hp_ratio, max_actions,
max_game_turns, max_wall_time_ms}. Budget defaults are product defaults, not
proven safe. User can tighten; model cannot relax. Read-only questions never
grant a lease. walk_to: ground target to a specific known tile on current
level; plan through known traversable tiles with runtime-correct rules; avoid
known occupied tiles and unsupported obstacles; execute one action, observe,
revalidate; stop on destination/cancel/budget/HP threshold/monster visibility/
unexpected input/blocked progress/level change/game over; report completed|
interrupted|blocked with reason and progress. "Walk to the door" targets an
adjacent reachable tile unless crossing/opening is requested; ambiguous doors
=> ask or offer selection. explore_room MVP: visit reachable known room tiles,
report unexamined boundaries; no silent secret-door searching or exhaustive
exploration. Do not ask an LLM to pick every deterministic step.

## 10. LLM Contract
AgentDecision: message | clarify | action(GameAction, explanation?) |
skill(SkillSpec, explanation?). Agent receives current player-visible
snapshot, capabilities, user request, recent messages, effective constraints.
Must not manufacture engine functions/unsupported actions. Approval mode binds
approval to the specific proposal + observed version; world changes invalidate
or regenerate the proposal. Delegated mode grants only the bounded task.
Malformed output/provider failure/unknown actions => explanation, no runtime
input. Concise user-facing reasons; no hidden chain-of-thought exposure. QA
uses the snapshot and distinguishes observed state from general game advice.

## 11. MVP and Acceptance Criteria
Vertical slice: "Walk to that door" -> grounded target -> walk_to -> validated
single steps -> updated view -> human takeover. Table: real runtime (actual
WASM session, no mock in delivered demo); observation; primitive control
(move/wait/open specified adjacent door/initiate pickup); QA grounded with
zero game input; prompt handling (pickup menu + direction prompt represented,
stale responses rejected); delegation (walk_to reaches target or explicit stop
reason); single writer (no interleaving inside one action/prompt transaction);
interrupt (stop during delayed provider response prevents it acting later);
handoff (stop mid-skill prevents further uncommitted steps, exposes current
boundary); validation (unsupported/stale/duplicate cause no additional input);
logging (trace links request, state version, source, result, handoff); client
independence (non-visual harness without UI imports). Harness != promise of
Node headless WASM support. Exclusions: ascension, all item actions, inventory
optimization, multi-character, long-term memory, multiplayer, multiple
adapters, 3D polish.

## 12. Web Client
Two panels: map left; chat/task/status right; HP/status/inventory near map;
reuse existing renderer. Controls: language input + direct gameplay controls;
visible owner and task; explicit approval UI; Stop/Take over independent of
model; prompt/menu display and human response; action history distinguishing
human vs AI. UI consumes observations/events only; state questions usable with
no AI execution permission.

## 13. Logging and Later Evaluation
Ordered events with session_id, seq, timestamp, turn, state_version,
control_epoch, request/task ID, source. Event types: observation changes, user
instructions, model proposals, accepted/rejected actions, committed inputs,
prompts, skill progress, cancellation, ownership transfer, provider failures,
termination. Record concise explanations and provider usage/latency; exclude
credentials and hidden reasoning. Trace playback reconstructs recorded
observations/decisions; deterministic re-execution is separate (pinned builds,
options, RNG seeds, all inputs). Later experiments: human-only, agent-only,
advice, approval, bounded delegation; metrics: task success, turns/actions,
invalid actions, deaths, intervention/override rates, stop latency, advice
accuracy, cost. Research positioning: language-mediated human-agent shared
control in a complex game environment.

## 14. Implementation Order
1 runtime spike; 2 contracts+adapter; 3 execution core; 4 walk_to; 5 agent
integration; 6 web integration; 7 MVP validation on real sessions; 8 extensions
(explore_room, item commands, renderer, eval adapter, models). Do not redesign
the frontend in iteration 1.

## 15. Repository Layout
packages/core, packages/adapter-wasm, packages/skills, packages/agent,
apps/web, apps/model-gateway, eval/, vendor/, docs/.

## 16. Instructions
Start with the runtime spike and report actual integration points. Treat
example APIs as design requirements, not assumed exports. Keep unsupported
features explicit; preserve WASM-first route unless a documented blocker
requires discussion. First milestone: observe real session, execute typed
action, run one bounded skill, reclaim control with no stale AI inputs.
