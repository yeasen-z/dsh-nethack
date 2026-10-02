/**
 * Middleware session core — the ONLY write path into the runtime adapter.
 * Implements handoff sections 6-8: validation ladder, dedup, staleness,
 * needs_input prompt handling, single-writer scheduling, Stop/Take over.
 */
import { ControlManager } from "./control.js";
import { EventLog, observationChanged } from "./events.js";
import { Scheduler } from "./scheduler.js";
import { validateActionRequestShape } from "./validate.js";
import { directionDelta } from "./types.js";
import type {
  ActionRequest,
  AdapterDelivery,
  ControlStatus,
  GameAdapter,
  NetHackSession,
  Observation,
  SkillRequest,
  StepReason,
  StepResult,
  StopResult,
  TaskHandle,
} from "./types.js";

export interface SkillExecutor {
  /** Run a bounded task exclusively through the given step() function. */
  run(
    req: SkillRequest,
    step: (req: ActionRequest) => Promise<StepResult>,
    observe: () => Promise<Observation>,
    ctx: { epoch: number; isCancelled: () => boolean },
  ): Promise<import("./types.js").TaskReport>;
}

export interface SessionOptions {
  session_id: string;
  adapter: GameAdapter;
  skills: Record<string, SkillExecutor>;
}

interface PendingSkill {
  handle_promise: Promise<TaskHandle>;
  resolve_handle: (h: TaskHandle) => void;
  start?: () => void;
  cancel?: () => void;
  cancelled: boolean;
  reason?: string;
  task_id: string;
  epoch: number;
}

export class MiddlewareSession implements NetHackSession {
  readonly sessionId: string;
  private adapter: GameAdapter;
  private skills: Record<string, SkillExecutor>;
  private control = new ControlManager();
  private scheduler = new Scheduler();
  private events: EventLog;
  private lastObservation: Observation | null = null;
  private seenRequests = new Map<string, StepResult>(); // request_id -> prior result
  private started = false;
  private activeSkill: PendingSkill | null = null;

  constructor(opts: SessionOptions) {
    this.sessionId = opts.session_id;
    this.adapter = opts.adapter;
    this.skills = opts.skills;
    this.events = new EventLog(opts.session_id);
  }

  // --- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    await this.adapter.start(this.sessionId);
    this.started = true;
    const obs = this.adapter.snapshot();
    this.lastObservation = obs;
    this.events.emit("observation_changed", this.ctx(obs), { kind: "session_start" });
  }

  get controlStatus(): ControlStatus {
    return this.control.status;
  }

  get eventLog(): EventLog {
    return this.events;
  }

  setMode(mode: import("./types.js").InteractionMode): number {
    const before = this.control.epoch;
    const after = this.control.setMode(mode);
    this.events.emit("ownership_transfer", this.ctxNow(), {
      from_epoch: before,
      to_epoch: after,
      mode,
    });
    return after;
  }

  subscribe(listener: (event: import("./types.js").SessionEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  // --- read path -----------------------------------------------------------

  /** Stable snapshot without advancing game time (handoff section 5). */
  async observe(): Promise<Observation> {
    const snap = this.adapter.snapshot();
    if (observationChanged(this.lastObservation, snap)) {
      this.lastObservation = snap;
      this.events.emit("observation_changed", this.ctx(snap), {
        input_kind: snap.input.kind,
        turn: snap.turn,
      });
    }
    return structuredClone(snap);
  }

  // --- write path ----------------------------------------------------------

  /**
   * Validate + enqueue one semantic action. Returns when the action reaches a
   * stable boundary. Does NOT promise exactly one game turn.
   */
  async step(request: ActionRequest): Promise<StepResult> {
    if (!this.started) throw new Error("session not started");

    // 1. Schema validation (syntax only). An unknown action NAME is reported
    //    as unsupported_action (still zero runtime input); a malformed
    //    envelope or malformed known-action stays invalid_request_schema.
    const shape = validateActionRequestShape(request);
    if (!shape.ok && shape.unknown_action_name) {
      return this.reject(request, "unsupported_action");
    }
    if (!shape.ok) {
      // Invalid requests leave the runtime untouched and are NOT memoized:
      // dedup applies to well-formed request IDs only.
      const obs = this.adapter.snapshot();
      this.events.emit("action_rejected", this.ctx(obs), {
        request_id: request?.request_id,
        reason: "invalid_request_schema",
        detail: shape.errors.join("; "),
        source: request?.source,
      });
      return {
        status: "rejected",
        request_id: String((request as unknown as { request_id?: string })?.request_id ?? ""),
        action: (request as unknown as { action?: import("./types.js").GameAction })?.action ?? { action: "wait" },
        reason: "invalid_request_schema",
        observation: structuredClone(obs),
        turn_delta: 0,
        input_committed: false,
      };
    }

    // 1b. Action syntax is valid but may still be a semantic name the adapter
    //     does not implement (e.g. a hallucinated "cast"). Reject it with an
    //     explicit unsupported_action reason BEFORE session/dedup checks, so
    //     schema-valid-but-unknown actions never occupy a request ID slot.
    if (!this.adapter.capabilities.supported_actions.includes(request.action.action)) {
      return this.reject(request, "unsupported_action");
    }

    // 2. Session identity.
    if (request.session_id !== this.sessionId) {
      return this.reject(request, "wrong_session");
    }

    // 3. Deduplication: duplicate request IDs return the prior result and do
    //    NOT apply the action twice.
    const prior = this.seenRequests.get(request.request_id);
    if (prior) {
      const res: StepResult = { ...structuredClone(prior), request_id: request.request_id };
      this.events.emit("action_rejected", this.ctxNow(), {
        request_id: request.request_id,
        reason: "duplicate_request",
        source: request.source,
      });
      return res;
    }

    // 4. Capability check (defense in depth: same gate as 1b, kept here so the
    //    ordering of validation stages stays explicit).
    const caps = this.adapter.capabilities.supported_actions;
    if (!caps.includes(request.action.action)) {
      return this.reject(request, "unsupported_action");
    }

    // 5. Execution validation: ownership/lease. NOTE: the interaction MODE is
    //    not re-checked here because executeSkill() flips to "delegated" only
    //    after this method has already been entered for its first step; the
    //    authoritative mode gate lives in the orchestration layer (approvals,
    //    UI), while the scheduler enforces single-writer + epoch correctness.
    if (request.source === "skill") {
      if (!this.control.hasActiveLease(request.task_id)) {
        return this.reject(request, "no_lease");
      }
    }

    // 6. Staleness checks against CURRENT state (epoch may have moved since
    //    the caller built the request).
    const now = this.adapter.snapshot();
    if (request.control_epoch !== this.control.epoch) {
      return this.reject(request, "stale_control_epoch");
    }
    if (request.expected_state_version !== now.state_version) {
      return this.reject(request, "stale_state_version");
    }
    if (now.terminal) {
      return this.finish(request, "game_over", "ok", now, 0, false);
    }

    // 7. Occupancy guard for delegated movement (MVP rule, handoff section 6).
    // Human movement must still reach NetHack: moving into a monster is the
    // normal melee command. Skills stop instead of silently starting combat.
    if (request.source === "skill" && request.action.action === "move") {
      const target = adjacent(now.player.position, request.action.direction);
      if (now.entities.some((e) => e.kind === "monster" && e.position.x === target.x && e.position.y === target.y)) {
        return this.reject(request, "occupied_target");
      }
    }

    // 8. respond must match the exact current prompt.
    if (request.action.action === "respond") {
      const st = now.input as { promptId?: string };
      if (st.promptId !== request.action.promptId) {
        return this.reject(request, "prompt_mismatch");
      }
    } else if (now.input.kind !== "command") {
      // Non-respond actions cannot be issued mid-prompt; surface the prompt.
      return this.finish(
        request,
        "needs_input",
        "wrong_input_state",
        now,
        0,
        false,
        now.input,
      );
    }

    // 9. Serialize through the single-writer scheduler.
    this.events.emit("action_accepted", this.ctx(now), {
      request_id: request.request_id,
      source: request.source,
      task_id: request.task_id,
      action: request.action,
    });

    return new Promise<StepResult>((resolve) => {
      this.scheduler.enqueue({
        id: request.request_id,
        epoch: request.control_epoch,
        isCurrent: (ep) => ep === this.control.epoch,
        run: async () => {
          // Re-check immediately before committing runtime input.
          const cur = this.adapter.snapshot();
          if (request.control_epoch !== this.control.epoch) {
            resolve(await this.finish(request, "cancelled", "cancelled_by_stop", cur, 0, false));
            return;
          }
          if (request.expected_state_version !== cur.state_version) {
            resolve(await this.finish(request, "rejected", "stale_state_version", cur, 0, false));
            return;
          }
          let delivery: AdapterDelivery;
          try {
            delivery = await this.adapter.deliver(request.action);
          } catch (err) {
            // Uncertain commit: reconcile by re-observing; never auto-re-execute.
            const rec = this.adapter.snapshot();
            resolve(
              await this.finish(request, "rejected", "uncertain_commit_needs_reconciliation", rec, 0, false),
            );
            return;
          }
          this.lastObservation = delivery.observation;
          const turnDelta = delivery.observation.turn - cur.turn;
          if (delivery.committed) {
            this.events.emit("input_committed", this.ctx(delivery.observation), {
              request_id: request.request_id,
              source: request.source,
              task_id: request.task_id,
              turn_delta: turnDelta,
            });
          }
          if (delivery.outcome === "unexpected_prompt") {
            // Stop at any unexpected prompt; never continue blind.
            this.events.emit("prompt_opened", this.ctx(delivery.observation), {
              request_id: request.request_id,
              unexpected: true,
              input: delivery.observation.input,
            });
            resolve(
              await this.finish(request, "needs_input", "wrong_input_state", delivery.observation, turnDelta, delivery.committed, delivery.observation.input),
            );
            return;
          }
          if (delivery.observation.input.kind !== "command" && delivery.outcome === "needs_input") {
            this.events.emit("prompt_opened", this.ctx(delivery.observation), {
              request_id: request.request_id,
              input: delivery.observation.input,
            });
            resolve(
              await this.finish(request, "needs_input", "ok", delivery.observation, turnDelta, delivery.committed, delivery.observation.input),
            );
            return;
          }
          if (delivery.observation.terminal) {
            this.events.emit("game_terminated", this.ctx(delivery.observation), {
              request_id: request.request_id,
              reason: String((delivery.observation.input as { reason?: string }).reason ?? "unknown"),
            });
            resolve(await this.finish(request, "game_over", "ok", delivery.observation, turnDelta, delivery.committed));
            return;
          }
          if (!delivery.committed && delivery.outcome === "failed") {
            resolve(await this.finish(request, "rejected", "runtime_error", delivery.observation, turnDelta, false));
            return;
          }
          resolve(await this.finish(request, "completed", "ok", delivery.observation, turnDelta, delivery.committed));
        },
      });
    });
  }

  // --- skills --------------------------------------------------------------

  async executeSkill(request: SkillRequest): Promise<TaskHandle> {
    if (!this.started) throw new Error("session not started");
    if (request.session_id !== this.sessionId) throw new Error("wrong session");
    const executor = this.skills[request.spec.skill];
    if (!executor) {
      // Unknown skill: explicit failure, no runtime input.
      throw new Error(`unknown skill: ${request.spec.skill}`);
    }
    if (request.control_epoch !== this.control.epoch) {
      throw new Error("stale control epoch for skill request");
    }

    // Delegated mode grants exactly this task's lease, nothing more.
    this.setMode("delegated");
    const lease = this.control.grantLease(request.task_id);
    const epochAtGrant = lease.epoch;

    this.events.emit("skill_progress", this.ctxNow(), {
      task_id: request.task_id,
      stage: "started",
      skill: request.spec.skill,
      constraints: request.spec.constraints,
      explanation: request.explanation,
    });

    const pending: PendingSkill = {
      task_id: request.task_id,
      epoch: epochAtGrant,
      cancelled: false,
      resolve_handle: () => {},
      handle_promise: Promise.resolve(null as unknown as TaskHandle),
    };
    let resolveHandle!: (h: TaskHandle) => void;
    pending.handle_promise = new Promise<TaskHandle>((r) => (resolveHandle = r));
    pending.resolve_handle = resolveHandle;
    this.activeSkill = pending;

    const isCancelled = () =>
      pending.cancelled || this.control.epoch !== epochAtGrant || !this.control.hasActiveLease(request.task_id);

    const stepBound = (req: ActionRequest) => this.step(req);
    const observeBound = () => this.observe();

    // Deterministic ordering: the executor body starts as soon as the handle
    // has been delivered to the caller (microtask after executeSkill returns),
    // or immediately if Stop/takeover arrives first and releases the gate.
    // Awaiting handle.done also releases the gate defensively.
    let startResolve!: () => void;
    const startGate = new Promise<void>((r) => (startResolve = r));
    let startedByCaller = false;
    pending.start = () => {
      if (!startedByCaller) { startedByCaller = true; startResolve(); }
    };

    const startedClock = Date.now();
    const donePromise = (async () => {
      await startGate;
      const runPromise = executor.run(request, stepBound, observeBound, { epoch: epochAtGrant, isCancelled });
      // Cooperative cancellation: if cancelled while the skill is between
      // awaits, settle once the queue drains without letting it commit more.
      const cancelWatch = new Promise<"cancelled">((r) => {
        const t = setInterval(() => {
          if (isCancelled()) { clearInterval(t); r("cancelled"); }
        }, 0);
        runPromise.finally(() => clearInterval(t));
      });
      // The losing branch of the race must not produce an unhandled rejection.
      runPromise.catch(() => {});
      let result: import("./types.js").TaskReport | "cancelled";
      try {
        result = await Promise.race([runPromise, cancelWatch]);
      } catch (err) {
        this.events.emit("skill_progress", this.ctxNow(), {
          task_id: request.task_id, stage: "error", error: String(err),
        });
        if (this.control.hasActiveLease(request.task_id)) this.control.revokeLease();
        if (this.activeSkill === pending) this.activeSkill = null;
        throw err;
      }
      if (result === "cancelled") {
        // Build an interrupted report from the latest observation.
        await this.scheduler.idle();
        const obs = this.adapter.snapshot();
        result = {
          task_id: request.task_id,
          skill: request.spec.skill,
          outcome: "interrupted",
          reason: "cancelled_by_stop",
          progress: {
            actions_used: 0, turns_used: 0, wall_time_ms: Date.now() - startedClock,
            last_position: obs.player.position, level_id: obs.level_id,
          },
          final_observation: structuredClone(obs),
        };
        this.events.emit("skill_progress", this.ctxNow(), {
          task_id: request.task_id, stage: "finished", outcome: "interrupted", reason: "cancelled_by_stop",
        });
        if (this.control.hasActiveLease(request.task_id)) this.control.revokeLease();
        if (this.activeSkill === pending) this.activeSkill = null;
        return result;
      }
      this.events.emit("skill_progress", this.ctxNow(), {
        task_id: request.task_id,
        stage: "finished",
        outcome: result.outcome,
        reason: result.reason,
        progress: result.progress,
      });
      if (this.control.hasActiveLease(request.task_id)) {
        this.control.revokeLease();
        this.control.transfer("human");
      }
      if (this.activeSkill === pending) this.activeSkill = null;
      return result;
    })();
    const handle: TaskHandle = {
      task_id: request.task_id,
      get done() {
        // Awaiting completion releases the start gate (defensive; normally the
        // microtask below has already released it).
        pending.start?.();
        return donePromise;
      },
      cancel: (reason?: string) => {
        pending.cancelled = true;
        pending.reason = reason;
      },
    };
    pending.cancel = handle.cancel;
    pending.resolve_handle(handle);
    // Release the start gate on the next microtask: by then executeSkill has
    // returned and the caller holds the handle. If the caller synchronously
    // invokes stop()/takeOver() first (same turn), Stop's synchronous epoch
    // bump + cancellation flag wins and the skill settles as interrupted
    // without committing further inputs — deterministic either way.
    queueMicrotask(() => pending.start?.());
    return handle;
  }

  // --- interruption --------------------------------------------------------

  /**
   * Stop: revoke AI execution permission immediately, bump epoch, cancel the
   * active task, discard uncommitted AI inputs; then allow already-committed
   * engine processing to settle to the next stable input boundary. Responsive
   * without waiting for any LLM response.
   */
  async stop(reason?: string, takeOwnership = false): Promise<StopResult> {
    const { epoch_before, epoch_after } = this.control.stopAi(takeOwnership);
    const discarded = this.scheduler.discardWhere((item) => item.epoch < epoch_after && item.id !== undefined);
    const cancelledTasks: string[] = [];
    if (this.activeSkill) {
      this.activeSkill.cancelled = true;
      this.activeSkill.reason = reason ?? "stopped";
      cancelledTasks.push(this.activeSkill.task_id);
      this.events.emit("task_cancelled", this.ctxNow(), {
        task_id: this.activeSkill.task_id,
        reason: reason ?? "stopped",
        epoch_before,
        epoch_after,
      });
    }
    this.events.emit("ownership_transfer", this.ctxNow(), {
      kind: takeOwnership ? "take_over" : "stop",
      epoch_before,
      epoch_after,
      discarded_requests: discarded,
      reason,
    });
    // If a gated skill never started, release it now so it resolves as
    // interrupted rather than hanging; stale queued items are skipped by the
    // epoch check inside the scheduler loop.
    if (this.activeSkill?.start) this.activeSkill.start();
    // Let in-flight committed work settle.
    await this.scheduler.idle();
    const obs = this.adapter.snapshot();
    this.lastObservation = obs;
    return {
      epoch_before,
      epoch_after,
      cancelled_tasks: cancelledTasks,
      discarded_requests: discarded,
      settled_to_boundary: true, // scheduler drained => runtime rests at a stable input boundary
      current_input: obs.input,
      observation: structuredClone(obs),
    };
  }

  async takeOver(): Promise<StopResult> {
    return this.stop("human_takeover", true);
  }

  // --- helpers -------------------------------------------------------------

  private ctx(obs: Observation) {
    return {
      turn: obs.turn,
      state_version: obs.state_version,
      control_epoch: this.control.epoch,
    };
  }

  private ctxNow() {
    const obs = this.lastObservation ?? this.adapter.snapshot();
    return this.ctx(obs);
  }

  private reject(request: ActionRequest, reason: StepReason, detail?: string): StepResult {
    const obs = this.adapter.snapshot();
    this.events.emit("action_rejected", this.ctx(obs), {
      request_id: request.request_id,
      source: request.source,
      task_id: request.task_id,
      reason,
      detail,
      action: request.action,
    });
    const res: StepResult = {
      status: "rejected",
      request_id: request.request_id,
      action: structuredClone(request.action),
      reason,
      observation: structuredClone(obs),
      turn_delta: 0,
      input_committed: false,
    };
    // Only memoize well-formed, execution-validated requests for dedup
    // semantics. Validation-stage rejections (bad schema, unknown/unsupported
    // action name, wrong session) never occupy a request-ID slot: an
    // unsupported action touched no runtime input, so reusing its ID for a
    // later valid action must not silently replay the rejection.
    if (reason !== "invalid_request_schema" && reason !== "unsupported_action" && reason !== "wrong_session") {
      this.seenRequests.set(request.request_id, res);
    }
    return res;
  }

  private async finish(
    request: ActionRequest,
    status: StepResult["status"],
    reason: StepReason,
    obs: Observation,
    turn_delta: number,
    input_committed: boolean,
    pending_prompt?: Observation["input"],
  ): Promise<StepResult> {
    const res: StepResult = {
      status,
      request_id: request.request_id,
      action: structuredClone(request.action),
      reason,
      observation: structuredClone(obs),
      turn_delta,
      input_committed,
      ...(pending_prompt ? { pending_prompt } : {}),
    };
    this.seenRequests.set(request.request_id, res);
    return res;
  }
}

// Direction math lives in exactly one place: types.ts (handoff section 5, rule 4).
function adjacent(
  pos: { x: number; y: number },
  dir: import("./types.js").Direction,
): { x: number; y: number } {
  const d = directionDelta(dir);
  return { x: pos.x + d.x, y: pos.y + d.y };
}
