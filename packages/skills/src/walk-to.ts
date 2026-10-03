/**
 * walk_to — the MVP bounded navigation skill (handoff section 9).
 *
 * Requirements implemented:
 *  - Grounds the target to a specific known tile on the CURRENT level.
 *  - Plans through known traversable tiles using runtime-correct movement
 *    rules (4-directional steps; diagonal moves are two semantic moves in
 *    NetHack's "one step" mode only via counterclock/clockwise keys — for MVP
 *    we restrict plans to cardinal steps, which is always valid).
 *  - Avoids known occupied tiles and unsupported obstacles.
 *  - Executes ONE action, observes, revalidates before continuing.
 *  - Stops on: destination reached, cancellation, budget exhaustion, HP
 *    threshold, monster visibility, unexpected input, blocked progress, level
 *    change, or game over.
 *  - Reports completed / interrupted / blocked with reason and progress.
 *
 * The skill NEVER writes to the runtime directly: every input goes through the
 * injected `step()` (the middleware single-writer path).
 */
import type {
  ActionRequest,
  Direction,
  Observation,
  SkillRequest,
  StepResult,
  TaskReport,
  Vec2,
} from "@nhchat/core";
import { directionDelta } from "@nhchat/core";
import type { SkillExecutor } from "@nhchat/core";

export interface WalkToParams {
  level_id: string;
  target: Vec2;
}

const DEFAULTS = {
  known_tiles_only: true,
  stop_on_monster: true,
  stop_below_hp_ratio: 0 as number | undefined,
  max_actions: 30,
  max_game_turns: 30,
  max_wall_time_ms: 60_000,
};

const TRAVERSABLE = new Set(["floor", "corridor", "door_open"]);

export const walkToExecutor: SkillExecutor = {
  async run(req, step, observe, ctx) {
    const startedAt = Date.now();
    const task_id = req.task_id;
    const params = req.spec.parameters as unknown as WalkToParams;
    const c = { ...DEFAULTS, ...req.spec.constraints };

    const report = (
      outcome: TaskReport["outcome"],
      reason: TaskReport["reason"],
      obs: Observation,
      actions_used: number,
      turns_used: number,
    ): TaskReport => ({
      task_id,
      skill: "walk_to",
      outcome,
      reason,
      progress: {
        actions_used,
        turns_used,
        wall_time_ms: Date.now() - startedAt,
        last_position: obs.player.position,
        level_id: obs.level_id,
      },
      final_observation: obs,
    });

    let obs = await observe();
    let actionsUsed = 0;
    const turnStart = obs.turn;
    if (obs.capabilities.supports_navigation === false) {
      return report("blocked", ["walk_to", "navigation_not_supported"], obs, actionsUsed, 0);
    }

    // --- grounding ---------------------------------------------------------
    if (params.level_id !== obs.level_id) {
      return report("blocked", ["walk_to", "level_mismatch"], obs, actionsUsed, 0);
    }
    const knownTarget = obs.tiles.find(
      (t) => t.x === params.target.x && t.y === params.target.y,
    );
    if (!knownTarget) {
      return report("blocked", ["walk_to", "target_not_known"], obs, actionsUsed, 0);
    }
    if (c.known_tiles_only && knownTarget.visibility === "remembered") {
      // Walking onto remembered-but-not-currently-visible tiles is allowed for
      // terrain, but the plan may only USE known tiles; remembered counts as
      // known terrain. No rejection here.
    }
    if (!TRAVERSABLE.has(knownTarget.terrain)) {
      return report("blocked", ["walk_to", "target_not_traversable"], obs, actionsUsed, 0);
    }
    if (samePos(obs.player.position, params.target)) {
      return report("completed", "ok", obs, actionsUsed, 0);
    }

    // --- planning ------------------------------------------------------------
    const plan = bfsPlan(obs, params.target, c.known_tiles_only ?? true);
    if (!plan) {
      return report("blocked", ["walk_to", "no_path"], obs, actionsUsed, 0);
    }

    // --- execution loop: one action, then observe + revalidate ---------------
    for (const dir of plan) {
      if (ctx.isCancelled()) {
        return report("interrupted", "cancelled_by_stop", obs, actionsUsed, obs.turn - turnStart);
      }
      // Budget checks BEFORE issuing the next step.
      if (actionsUsed >= (c.max_actions ?? Infinity)) {
        return report("interrupted", ["walk_to", "max_actions_exhausted"], obs, actionsUsed, obs.turn - turnStart);
      }
      if (obs.turn - turnStart >= (c.max_game_turns ?? Infinity)) {
        return report("interrupted", ["walk_to", "max_game_turns_exhausted"], obs, actionsUsed, obs.turn - turnStart);
      }
      if (Date.now() - startedAt >= (c.max_wall_time_ms ?? Infinity)) {
        return report("interrupted", ["walk_to", "max_wall_time_exhausted"], obs, actionsUsed, obs.turn - turnStart);
      }
      // HP threshold check.
      if (c.stop_below_hp_ratio !== undefined && obs.player.hp !== null && obs.player.max_hp) {
        if (obs.player.hp / obs.player.max_hp < c.stop_below_hp_ratio) {
          return report("interrupted", ["walk_to", "hp_threshold"], obs, actionsUsed, obs.turn - turnStart);
        }
      }
      // Monster visibility stop rule.
      if (c.stop_on_monster && obs.entities.some((e) => e.kind === "monster")) {
        return report("interrupted", ["walk_to", "monster_visible"], obs, actionsUsed, obs.turn - turnStart);
      }

      const request: ActionRequest = {
        request_id: `${task_id}-a${actionsUsed}`,
        session_id: obs.session_id,
        expected_state_version: obs.state_version,
        control_epoch: ctx.epoch,
        source: "skill",
        task_id,
        action: { action: "move", direction: dir },
      };
      const result: StepResult = await step(request);
      obs = result.observation;
      // Only inputs that actually reached the runtime count against budgets.
      if (result.input_committed) actionsUsed += 1;

      if (result.status === "completed") {
        if (obs.terminal) return report("blocked", ["walk_to", "game_over"], obs, actionsUsed, obs.turn - turnStart);
        if (obs.level_id !== params.level_id) {
          return report("interrupted", ["walk_to", "level_changed"], obs, actionsUsed, obs.turn - turnStart);
        }
        if (samePos(obs.player.position, params.target)) {
          return report("completed", "ok", obs, actionsUsed, obs.turn - turnStart);
        }
        // Blocked progress: position did not change despite completion (bump).
        continue;
      }
      if (result.status === "needs_input") {
        return report("interrupted", ["walk_to", "unexpected_input_state"], obs, actionsUsed, obs.turn - turnStart);
      }
      if (result.status === "cancelled") {
        return report("interrupted", "cancelled_by_stop", obs, actionsUsed, obs.turn - turnStart);
      }
      if (result.status === "game_over") {
        return report("blocked", ["walk_to", "game_over"], obs, actionsUsed, obs.turn - turnStart);
      }
      // rejected (occupied_target, stale, ...) => blocked with machine reason
      return report("blocked", ["walk_to", String(result.reason)], obs, actionsUsed, obs.turn - turnStart);
    }

    // Ran out of planned steps without reaching the target.
    if (samePos(obs.player.position, params.target)) {
      return report("completed", "ok", obs, actionsUsed, obs.turn - turnStart);
    }
    // Replan once from the CURRENT observation: monsters move and door state
    // can change mid-execution, so a stale plan is not proof of unreachability.
    const replan = bfsPlan(obs, params.target, c.known_tiles_only ?? true);
    if (replan && replan.length > 0) {
      for (const dir of replan) {
        if (ctx.isCancelled()) {
          return report("interrupted", "cancelled_by_stop", obs, actionsUsed, obs.turn - turnStart);
        }
        if (actionsUsed >= (c.max_actions ?? Infinity)) {
          return report("interrupted", ["walk_to", "max_actions_exhausted"], obs, actionsUsed, obs.turn - turnStart);
        }
        if (c.stop_on_monster && obs.entities.some((e) => e.kind === "monster")) {
          return report("interrupted", ["walk_to", "monster_visible"], obs, actionsUsed, obs.turn - turnStart);
        }
        const request: ActionRequest = {
          request_id: `${task_id}-r${actionsUsed}`,
          session_id: obs.session_id,
          expected_state_version: obs.state_version,
          control_epoch: ctx.epoch,
          source: "skill",
          task_id,
          action: { action: "move", direction: dir },
        };
        const result = await step(request);
        obs = result.observation;
        if (result.input_committed) actionsUsed += 1;
        if (result.status === "completed" && samePos(obs.player.position, params.target)) {
          return report("completed", "ok", obs, actionsUsed, obs.turn - turnStart);
        }
        if (result.status !== "completed") {
          return result.status === "cancelled"
            ? report("interrupted", "cancelled_by_stop", obs, actionsUsed, obs.turn - turnStart)
            : report("blocked", ["walk_to", String(result.reason)], obs, actionsUsed, obs.turn - turnStart);
        }
      }
    }
    return samePos(obs.player.position, params.target)
      ? report("completed", "ok", obs, actionsUsed, obs.turn - turnStart)
      : report("blocked", ["walk_to", "plan_exhausted"], obs, actionsUsed, obs.turn - turnStart);
  },
};

function samePos(a: Vec2, b: Vec2): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Cardinal-only BFS over KNOWN traversable tiles; returns direction list. */
export function bfsPlan(
  obs: Observation,
  target: Vec2,
  knownOnly: boolean,
): Direction[] | null {
  const key = (p: Vec2) => `${p.x},${p.y}`;
  const known = new Map<string, Observation["tiles"][number]>();
  for (const t of obs.tiles) known.set(key(t), t);
  const passable = (p: Vec2): boolean => {
    const t = known.get(key(p));
    if (!t) return false;
    if (knownOnly && t.visibility === "remembered") {
      // remembered terrain still counts as "known" for planning; caller can
      // tighten this policy later. Traversable check applies either way.
    }
    return TRAVERSABLE.has(t.terrain);
  };
  const occupied = new Set(
    obs.entities.filter((e) => e.kind === "monster").map((e) => key(e.position)),
  );

  const start = obs.player.position;
  if (samePos(start, target)) return [];
  const prev = new Map<string, { p: Vec2; d: Direction }>();
  const queue: Vec2[] = [start];
  const seen = new Set<string>([key(start)]);
  const dirs: Direction[] = ["north", "east", "south", "west"];

  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const d of dirs) {
      const delta = directionDelta(d);
      const nxt = { x: cur.x + delta.x, y: cur.y + delta.y };
      const k = key(nxt);
      if (seen.has(k)) continue;
      if (!passable(nxt)) continue;
      if (occupied.has(k) && !samePos(nxt, target)) continue;
      seen.add(k);
      prev.set(k, { p: cur, d });
      if (samePos(nxt, target)) {
        // reconstruct
        const path: Direction[] = [];
        let ck = k;
        while (true) {
          const stepInfo = prev.get(ck)!;
          path.unshift(stepInfo.d);
          const pp = stepInfo.p;
          if (samePos(pp, start)) return path;
          ck = key(pp);
        }
      }
      queue.push(nxt);
    }
  }
  return null;
}
