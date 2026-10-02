/**
 * NetHack-Chat core contracts.
 *
 * These schemas are OUR PROPOSED CONTRACTS (handoff section 3: "not existing
 * NetHack exports"). The WASM adapter maps real engine data into them; clients
 * and skills consume only these types, never raw engine state.
 */

// ---------------------------------------------------------------------------
// Geometry & primitives
// ---------------------------------------------------------------------------

/**
 * Coordinates are defined ONCE (handoff section 5, rule 4):
 * origin at the upper left; x increases east; y increases south.
 * Coordinates are meaningful only together with a `level_id`.
 */
export interface Vec2 {
  x: number;
  y: number;
}

export const DIRECTIONS = [
  "north",
  "northeast",
  "east",
  "southeast",
  "south",
  "southwest",
  "west",
  "northwest",
] as const;

export type Direction = (typeof DIRECTIONS)[number];

/** Unit vector for a direction in our coordinate system (y grows south). */
export function directionDelta(d: Direction): Vec2 {
  switch (d) {
    case "north": return { x: 0, y: -1 };
    case "northeast": return { x: 1, y: -1 };
    case "east": return { x: 1, y: 0 };
    case "southeast": return { x: 1, y: 1 };
    case "south": return { x: 0, y: 1 };
    case "southwest": return { x: -1, y: 1 };
    case "west": return { x: -1, y: 0 };
    case "northwest": return { x: -1, y: -1 };
  }
}

export const TERRAIN_KINDS = [
  "floor",
  "wall",
  "door_closed",
  "door_open",
  "corridor",
  "stairs_down",
  "stairs_up",
  "water",
  "unknown",
] as const;
export type TerrainKind = (typeof TERRAIN_KINDS)[number];

/** Visible vs remembered must be distinguishable (handoff section 5, rule 3). */
export type TileVisibility = "visible" | "remembered";

export interface TileSnapshot {
  x: number;
  y: number;
  terrain: TerrainKind;
  visibility: TileVisibility;
}

/**
 * Entities are player-visible only. `monster_kind` may be null when the
 * monster is seen but not sufficiently identified — uncertainty is preserved
 * (handoff section 5, rule 2). Remembered entity positions are NOT exported;
 * stale positions must never be presented as current.
 */
export interface EntitySnapshot {
  ref: string; // snapshot-scoped reference; see Observation contract rules
  kind: "monster" | "object" | "invisible_detector" | "other";
  position: Vec2;
  display_name: string;
  monster_kind?: string | null;
}

/**
 * Inventory entries carry player knowledge only. `known_properties === null`
 * means "no reliable identification available to the player".
 */
export interface InventoryEntry {
  ref: string; // documented lifetime: valid until state_version changes
  slot: string | null; // letter inventory; null if not applicable
  display_name: string;
  known_properties: Record<string, string | boolean> | null;
}

// ---------------------------------------------------------------------------
// Input states (handoff section 6)
// ---------------------------------------------------------------------------

export interface PromptOption {
  optionId: string;
  label: string;
  count?: number;
  letter?: string;
}

export type InputState =
  | { kind: "command" }
  | { kind: "direction"; promptId: string }
  | {
      kind: "menu";
      promptId: string;
      title: string;
      allowMulti: boolean;
      options: PromptOption[];
    }
  | { kind: "yes_no"; promptId: string; question: string }
  | { kind: "more"; promptId: string }
  | { kind: "text"; promptId: string; purpose: string } // MVP: hand off to human
  | { kind: "game_over"; reason: string };

export type PromptResponse =
  | { kind: "direction"; direction: Direction }
  | { kind: "menu"; optionIds: string[] }
  | { kind: "yes_no"; value: boolean }
  | { kind: "more" }
  | { kind: "cancel" };

/** A response that matches the CURRENT prompt kind. */
export function responseMatchesPrompt(
  state: InputState,
  response: PromptResponse,
): boolean {
  switch (state.kind) {
    case "direction":
      return response.kind === "direction";
    case "menu":
      return response.kind === "menu";
    case "yes_no":
      return response.kind === "yes_no";
    case "more":
      return response.kind === "more";
    default:
      return false; // text/game_over/command accept no automatic response
  }
}

// ---------------------------------------------------------------------------
// Observation (handoff section 5)
// ---------------------------------------------------------------------------

export interface AdapterCapabilities {
  /** Stable identifier of the runtime build/adapter (e.g. "fake-nh@0.1", "nh5.0-wasm-shim@<pin>"). */
  runtime_id: string;
  supports_automatic_text_entry: boolean;
  supports_save_load: boolean;
  supported_actions: GameActionName[];
}

export interface Observation {
  schema_version: "0.1";
  session_id: string;
  state_version: number; // increases at relevant state/input-boundary changes
  turn: number; // game turns consumed so far
  level_id: string;
  player: {
    position: Vec2;
    hp: number | null;
    max_hp: number | null;
    conditions: string[];
  };
  tiles: TileSnapshot[];
  entities: EntitySnapshot[];
  inventory: InventoryEntry[];
  messages: string[]; // recent game messages, oldest first
  input: InputState;
  available_actions: GameActionName[];
  capabilities: AdapterCapabilities;
  terminal: boolean; // game over / session ended
}

// ---------------------------------------------------------------------------
// Typed actions (handoff section 6)
// ---------------------------------------------------------------------------

export type GameActionName = "move" | "wait" | "open" | "pickup" | "respond";

export type GameAction =
  | { action: "move"; direction: Direction }
  | { action: "wait" }
  | { action: "open"; direction: Direction }
  | { action: "pickup" }
  | { action: "respond"; promptId: string; response: PromptResponse };

export type ActionSource = "human" | "agent" | "skill" | "system";

export interface ActionRequest {
  request_id: string;
  session_id: string;
  expected_state_version: number;
  /**
   * Core-generated metadata. MUST come from the orchestration/control layer,
   * never from model output (handoff section 7).
   */
  control_epoch: number;
  source: ActionSource;
  task_id?: string; // set when issued by a running skill task
  action: GameAction;
}

export type StepStatus =
  | "completed"
  | "rejected"
  | "needs_input"
  | "cancelled"
  | "game_over";

/** Machine-readable rejection/cancellation reasons. */
export type StepReason =
  | "ok"
  | "invalid_request_schema"
  | "wrong_session"
  | "stale_state_version"
  | "stale_control_epoch"
  | "duplicate_request"
  | "unsupported_action"
  | "mode_denied"
  | "no_lease"
  | "wrong_input_state"
  | "prompt_mismatch"
  | "occupied_target"
  | "runtime_error"
  | "uncertain_commit_needs_reconciliation"
  | "cancelled_by_stop"
  | "task_budget_exhausted"
  | [task: string, reason: string]; // namespaced reason emitted by a skill

export interface StepResult {
  status: StepStatus;
  request_id: string;
  action: GameAction;
  reason: StepReason;
  observation: Observation;
  turn_delta: number;
  /** Whether any low-level input was actually committed to the runtime. */
  input_committed: boolean;
  /** Remaining prompt information when status === "needs_input". */
  pending_prompt?: InputState;
}

// ---------------------------------------------------------------------------
// Skills (handoff section 9)
// ---------------------------------------------------------------------------

export interface SkillConstraints {
  known_tiles_only?: boolean;
  stop_on_monster?: boolean;
  stop_below_hp_ratio?: number;
  max_actions?: number;
  max_game_turns?: number;
  max_wall_time_ms?: number;
}

export interface SkillSpec {
  skill: string;
  parameters: Record<string, unknown>;
  constraints: SkillConstraints;
}

export interface SkillRequest {
  task_id: string;
  session_id: string;
  control_epoch: number;
  spec: SkillSpec;
  explanation?: string;
}

export type TaskOutcome = "completed" | "interrupted" | "blocked";

export interface TaskReport {
  task_id: string;
  skill: string;
  outcome: TaskOutcome;
  reason: StepReason;
  progress: {
    actions_used: number;
    turns_used: number;
    wall_time_ms: number;
    last_position: Vec2 | null;
    level_id: string | null;
  };
  final_observation: Observation;
}

export interface TaskHandle {
  task_id: string;
  done: Promise<TaskReport>;
  cancel(reason?: string): void;
}

// ---------------------------------------------------------------------------
// Control ownership (handoff section 8)
// ---------------------------------------------------------------------------

export type InteractionMode =
  | "human" // AI answers questions; cannot change the game
  | "suggest" // AI offers actions; cannot execute them
  | "approval" // AI executes an explicitly approved proposal after revalidation
  | "delegated" // AI executes one task within declared constraints/budgets
  | "agent"; // future autonomous mode; still cancellable and budgeted

export interface ControlStatus {
  mode: InteractionMode;
  owner: ActionSource; // who currently holds the write path
  epoch: number;
  active_task_id: string | null;
}

export interface StopResult {
  epoch_before: number;
  epoch_after: number;
  cancelled_tasks: string[];
  discarded_requests: string[];
  settled_to_boundary: boolean;
  current_input: InputState;
  observation: Observation;
}

// ---------------------------------------------------------------------------
// Events / logging (handoff section 13)
// ---------------------------------------------------------------------------

export type SessionEventType =
  | "observation_changed"
  | "user_instruction"
  | "model_proposal"
  | "action_accepted"
  | "action_rejected"
  | "input_committed"
  | "prompt_opened"
  | "prompt_resolved"
  | "skill_progress"
  | "task_cancelled"
  | "ownership_transfer"
  | "provider_failure"
  | "game_terminated";

export interface SessionEvent {
  session_id: string;
  seq: number; // strictly increasing per session
  timestamp: number; // unix ms
  turn: number;
  state_version: number;
  control_epoch: number;
  request_id?: string;
  task_id?: string;
  source?: ActionSource;
  type: SessionEventType;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Middleware public API (handoff section 7)
// ---------------------------------------------------------------------------

export interface NetHackSession {
  observe(): Promise<Observation>;
  step(request: ActionRequest): Promise<StepResult>;
  executeSkill(request: SkillRequest): Promise<TaskHandle>;
  stop(reason?: string): Promise<StopResult>;
  takeOver(): Promise<StopResult>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
}

/**
 * Runtime-adapter boundary. Implemented by packages/adapter-wasm (real shim
 * bridge or scripted fake). The middleware core depends ONLY on this
 * interface, never on engine internals.
 */
export interface GameAdapter {
  readonly capabilities: AdapterCapabilities;
  start(session_id: string): Promise<void>;
  /** Stable snapshot at an input boundary. Must NOT advance game time. */
  snapshot(): Observation;
  /**
   * Deliver ONE semantic action's expected low-level input sequence.
   * The adapter encodes only the action-specific expected prompt sequence and
   * stops at any unexpected prompt — never blind key injection.
   */
  deliver(action: GameAction): Promise<AdapterDelivery>;
}

export interface AdapterDelivery {
  /** True iff at least one low-level input actually reached the runtime. */
  committed: boolean;
  outcome: "settled" | "needs_input" | "unexpected_prompt" | "failed" | "terminal";
  reason?: string;
  observation: Observation;
}
