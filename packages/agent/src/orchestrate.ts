/**
 * LLM orchestration layer (handoff section 10).
 *
 * One structured decision format; assistant messages stay separate from
 * gameplay actions. The model may only propose supported typed actions;
 * malformed output yields an explanation and NO runtime input. Core-generated
 * metadata (source, control epoch) is stamped by this layer — never taken from
 * model output.
 */
import type {
  ActionRequest,
  ControlStatus,
  Direction,
  GameAction,
  NetHackSession,
  Observation,
  SkillRequest,
  SkillSpec,
  StepResult,
} from "@nhchat/core";
import { parseGameAction } from "@nhchat/core";

export type AgentDecision =
  | { type: "message"; text: string }
  | { type: "clarify"; question: string }
  | { type: "action"; action: GameAction; explanation?: string }
  | { type: "skill"; skill: SkillSpec; explanation?: string };

export interface AgentContext {
  observation: Observation;
  userText: string;
  recentMessages: string[];
  effectiveConstraints: Record<string, unknown>;
  mode: string;
  /**
   * Session handle for prompt-clearing only (e.g. cancelling a live direction
   * prompt before re-grounding). Providers must NOT move the character here;
   * gameplay goes through typed decisions handled by the Orchestrator.
   */
  session?: NetHackSession;
}

export interface ProviderResult {
  ok: boolean;
  decision?: AgentDecision;
  error?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; latency_ms: number };
}

export interface AgentProvider {
  readonly name: string;
  decide(ctx: AgentContext, signal?: AbortSignal): Promise<ProviderResult>;
}

/** Browser-safe client for the same-origin model-gateway proxy. Secrets stay on the gateway. */
export class HttpGatewayProvider implements AgentProvider {
  readonly name = "model-gateway";

  constructor(private endpoint = "/api/decide") {}

  async decide(ctx: AgentContext, signal?: AbortSignal): Promise<ProviderResult> {
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        // Never serialize the live session handle into a model request.
        body: JSON.stringify({
          observation: ctx.observation,
          userText: ctx.userText,
          recentMessages: ctx.recentMessages,
          effectiveConstraints: ctx.effectiveConstraints,
          mode: ctx.mode,
        }),
      });
      const result = await response.json() as ProviderResult;
      if (!response.ok) return { ok: false, error: result.error ?? `gateway HTTP ${response.status}` };
      if (!result || typeof result.ok !== "boolean" || (result.ok && !result.decision)) {
        return { ok: false, error: "gateway returned an invalid decision envelope" };
      }
      return result;
    } catch (error) {
      return { ok: false, error: `model gateway unavailable: ${String(error)}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Offline demo provider — deterministic narrow intent parsing so the vertical
// slice runs without any API key. NOT a substitute for LLM interpretation in
// production; it exists to exercise the full pipeline offline.
// ---------------------------------------------------------------------------

export class OfflineDemoProvider implements AgentProvider {
  readonly name = "offline-demo";

  async decide(ctx: AgentContext): Promise<ProviderResult> {
    const t = ctx.userText.toLowerCase().trim();
    const obs = ctx.observation;

    // Read-only QA: grounded answers, zero game input (acceptance criterion).
    if (/health|hp\b|血量|生命值/.test(t)) {
      const { hp, max_hp } = obs.player;
      return ok({
        type: "message",
        text:
          hp === null
            ? "Your health is not currently readable from the snapshot."
            : `当前生命值：${hp}/${max_hp} HP（${obs.level_id}）。`,
      });
    }
    if (/inventory|carry|backpack|背包|携带|物品/.test(t)) {
      if (!obs.inventory_current) {
        return ok({ type: "message", text: "游戏还没有提供最新背包快照，暂时不能可靠判断物品。" });
      }
      const items = obs.inventory.map((i) => `${i.slot ? `(${i.slot}) ` : ""}${i.display_name}`);
      return ok({
        type: "message",
        text: items.length ? `当前携带：${items.join("、")}。` : "当前背包为空。",
      });
    }
    if (/monster|what.*see|怪物|敌人|看到什么/.test(t)) {
      const mons = obs.entities.filter((e) => e.kind === "monster");
      return ok({
        type: "message",
        text: mons.length
          ? `当前可见：${mons.map((m) => `${m.display_name}${m.monster_kind ? `（${m.monster_kind}）` : "（未识别）"}，位置 (${m.position.x},${m.position.y})`).join("；")}。`
          : "当前观察中没有可确认的怪物。",
      });
    }

    // Primitive commands -> typed actions.
    const dirMap: Record<string, Direction> = {
      north: "north", n: "north", up: "north",
      south: "south", s: "south", down: "south",
      east: "east", e: "east", west: "west", w: "west",
      北: "north", 上: "north", 南: "south", 下: "south", 东: "east", 西: "west",
      东北: "northeast", 西北: "northwest", 东南: "southeast", 西南: "southwest",
    };
    const chineseDir = (value: string) => dirMap[value.replace(/(?:边|方)$/, "")];
    const moveMatch = t.match(/^(?:(?:move|walk|go)\s+)?(?:(?:one tile|step)\s+)?(north|south|east|west|n|s|e|w)(?:ward)?[.!]?$/);
    if (moveMatch) {
      const d = dirMap[moveMatch[1]];
      if (d) return ok({ type: "action", action: { action: "move", direction: d }, explanation: "single-step move" });
    }
    const moveZh = t.match(/^(?:请)?(?:往|向)?(东北|东南|西北|西南|北|南|东|西|上|下)(?:边|方)?(?:走|移动|一步)?[。.!！]?$/);
    if (moveZh) {
      const d = chineseDir(moveZh[1]);
      if (d) return ok({ type: "action", action: { action: "move", direction: d }, explanation: "单步移动" });
    }

    if (/^wait[.!]?$|^(?:等一下|等待|原地等待)[。.!！]?$/.test(t)) return ok({ type: "action", action: { action: "wait" } });

    const openMatch = t.match(/^open (?:the )?(.+?)(?: (?:ern)? door)?[.!]?$/);
    if (openMatch) {
      const d = dirMap[openMatch[1].trim().toLowerCase()];
      if (d) return ok({ type: "action", action: { action: "open", direction: d }, explanation: "open adjacent door" });
    }
    const openZh = t.match(/^(?:打开|开(?:一下)?)(?:门)?(?:朝|向|往)?(东北|东南|西北|西南|北|南|东|西)(?:边|方)?(?:的门)?[。.!！]?$/);
    if (openZh) {
      const d = chineseDir(openZh[1]);
      if (d) return ok({ type: "action", action: { action: "open", direction: d }, explanation: "尝试打开相邻方向的门" });
    }

    if (/pick(ing)? ?up|grab|拾取|捡起/.test(t)) return ok({ type: "action", action: { action: "pickup" } });

    // Delegation: "walk to that door" -> ground target via observation.
    // Grounding rule (handoff section 9): target an ADJACENT reachable tile;
    // crossing/opening the door only when the user explicitly asks.
    if (/walk to (the |that )?door/.test(t)) {
      // If a direction prompt is live (e.g. left over from an earlier 'open'
      // or 'zap'), answer THAT prompt first with a cancel — consuming the
      // prompt is not gameplay movement — then re-observe and ground.
      let obs2 = obs;
      if (obs.input.kind === "direction") {
        const cleared = await answerDirectionPrompt(ctx.session, obs);
        if (cleared) obs2 = cleared;
      }
      const door = findKnownDoor(obs2);
      if (!door) {
        return ok({ type: "message", text: "I can't ground 'that door': no door appears in your current view or map memory. Try pointing with 'open north' or walk closer first." });
      }
      const approach = pickApproach(obs2, { x: door.x, y: door.y });
      if (!approach) {
        return ok({ type: "message", text: "The door is known but I found no reachable adjacent tile in your map knowledge." });
      }
      return ok({
        type: "skill",
        skill: {
          skill: "walk_to",
          parameters: { level_id: obs2.level_id, target: approach },
          constraints: {
            known_tiles_only: true,
            stop_on_monster: true,
            max_actions: 30,
            max_game_turns: 30,
            max_wall_time_ms: 60000,
          },
        },
        explanation: `Walk next to the door at (${door.x},${door.y}); stop before entering.`,
      });
    }

    return ok({
      type: "message",
      text: "我目前是离线规则助手（不是大模型），可以尝试回答 HP/背包问题，或识别简单的方向移动、等待、开门和拾取指令。更开放的对话需要配置真实 LLM。",
    });
  }
}

function ok(decision: AgentDecision): ProviderResult {
  return { ok: true, decision, usage: { latency_ms: 0 } };
}

/** Find the nearest known door (visible or remembered) in the snapshot. */
function findKnownDoor(obs: Observation): { x: number; y: number } | null {
  const doors = obs.tiles.filter((t) => t.terrain === "door_closed" || t.terrain === "door_open");
  if (!doors.length) return null;
  const p = obs.player.position;
  doors.sort((a, b) => manhattan(a, p) - manhattan(b, p));
  return { x: doors[0].x, y: doors[0].y };
}

function manhattan(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Cancel a LIVE direction prompt through the typed `respond` action only.
 * This consumes no game turn and never injects raw keys; any other outcome
 * (stale epoch, unexpected prompt id) leaves the game untouched and returns
 * null so the caller can degrade to a clarification message.
 */
async function answerDirectionPrompt(
  session: NetHackSession | undefined,
  obs: Observation,
): Promise<Observation | null> {
  if (!session || obs.input.kind !== "direction") return null;
  // Read the CURRENT epoch from live control status — never a cached value.
  const s = session as NetHackSession & { controlStatus?: ControlStatus };
  const epoch = s.controlStatus?.epoch ?? 0;
  const result = await session.step({
    request_id: `prompt-clear-${obs.input.promptId}`,
    session_id: obs.session_id,
    expected_state_version: obs.state_version,
    control_epoch: epoch,
    source: "agent",
    action: { action: "respond", promptId: obs.input.promptId, response: { kind: "cancel" } },
  });
  if (result.status === "completed" || result.status === "needs_input") return result.observation;
  return null;
}

/** Choose a traversable tile adjacent to the target that is known & unoccupied. */
function pickApproach(obs: Observation, target: { x: number; y: number }): { x: number; y: number } | null {
  const candidates = [
    { x: target.x - 1, y: target.y },
    { x: target.x + 1, y: target.y },
    { x: target.x, y: target.y - 1 },
    { x: target.x, y: target.y + 1 },
  ];
  const known = new Set(
    obs.tiles
      .filter((t) => t.terrain === "floor" || t.terrain === "corridor")
      .map((t) => `${t.x},${t.y}`),
  );
  const occupied = new Set(obs.entities.map((e) => `${e.position.x},${e.position.y}`));
  for (const c of candidates) {
    const k = `${c.x},${c.y}`;
    if (known.has(k) && !occupied.has(k)) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Orchestrator: turns decisions into validated middleware calls.
// ---------------------------------------------------------------------------

export interface OrchestrateOutcome {
  kind: "answered" | "clarify" | "executed" | "delegated" | "denied" | "malformed" | "provider_error";
  text: string;
  result?: StepResult;
}

export class Orchestrator {
  private reqSeq = 0;

  constructor(private session: NetHackSession) {}

  /** Handle a user utterance end-to-end. Returns a concise user-facing line. */
  async handleUserText(userText: string, provider: AgentProvider): Promise<OrchestrateOutcome> {
    const observation = await this.session.observe();
    const res = await provider.decide({
      observation,
      userText,
      recentMessages: observation.messages.slice(-5),
      effectiveConstraints: {},
      mode: "mixed",
      session: this.session,
    });

    if (!res.ok || !res.decision) {
      // Provider failure => explanation, no runtime input.
      return { kind: "provider_error", text: `Model unavailable: ${res.error ?? "unknown error"}. No game input was sent.` };
    }
    const d = res.decision;

    switch (d.type) {
      case "message":
        return { kind: "answered", text: d.text };
      case "clarify":
        return { kind: "clarify", text: d.question };
      case "action": {
        // Re-validate proposal syntax independently of the provider.
        const action = parseGameAction(d.action);
        if (!action) {
          return { kind: "malformed", text: "The model proposed an unsupported action; nothing was sent to the game." };
        }
        // Core-generated metadata: source + epoch come from THIS layer.
        const fresh = await this.session.observe();
        const request: ActionRequest = {
          request_id: `req-${++this.reqSeq}`,
          session_id: fresh.session_id,
          expected_state_version: fresh.state_version,
          control_epoch: this.currentEpoch(),
          source: "agent",
          action,
        };
        const result = await this.session.step(request);
        return {
          kind: result.status === "completed" ? "executed" : "denied",
          text: describeStep(result, d.explanation),
          result,
        };
      }
      case "skill": {
        const fresh = await this.session.observe();
        const taskId = `task-${++this.reqSeq}`;
        // Enforce product default budgets LOCALLY. The user may tighten them;
        // the model cannot relax them (handoff section 9).
        const spec = { ...d.skill, constraints: enforceBudgetDefaults(d.skill.constraints) };
        const skillReq: SkillRequest = {
          task_id: taskId,
          session_id: fresh.session_id,
          control_epoch: this.currentEpoch(),
          spec,
          explanation: d.explanation,
        };
        try {
          const handle = await this.session.executeSkill(skillReq);
          const report = await handle.done;
          return {
            kind: "delegated",
            text: `Task ${report.outcome}: ${JSON.stringify(report.reason)} (actions=${report.progress.actions_used}, turns=${report.progress.turns_used}).`,
          };
        } catch (err) {
          return { kind: "malformed", text: `Skill request rejected locally: ${String(err)}. No blind execution occurred.` };
        }
      }
    }
  }

  private currentEpoch(): number {
    // The session's control status is authoritative; agents must read the
    // CURRENT epoch here rather than trusting anything from model output.
    const s = this.session as NetHackSession & { controlStatus?: ControlStatus };
    return s.controlStatus?.epoch ?? 0;
  }
}

function describeStep(r: StepResult, explanation?: string): string {
  const base =
    r.status === "completed" ? "Done." :
    r.status === "needs_input" ? `The game is asking for input (${r.pending_prompt?.kind ?? "?"}).` :
    r.status === "rejected" ? `Not executed: ${stringifyReason(r.reason)}.` :
    r.status === "cancelled" ? "Cancelled before touching the game." :
    "Game over.";
  return explanation ? `${base} (${explanation})` : base;
}

function stringifyReason(reason: unknown): string {
  return Array.isArray(reason) ? reason.join(":") : String(reason);
}

/** Product defaults for delegated tasks; stricter incoming values are kept. */
export function enforceBudgetDefaults(c: SkillRequest["spec"]["constraints"]): SkillRequest["spec"]["constraints"] {
  return {
    known_tiles_only: c.known_tiles_only ?? true,
    stop_on_monster: c.stop_on_monster ?? true,
    max_actions: Math.min(c.max_actions ?? Infinity, HARD_MAX_ACTIONS),
    max_game_turns: Math.min(c.max_game_turns ?? Infinity, HARD_MAX_GAME_TURNS),
    max_wall_time_ms: Math.min(c.max_wall_time_ms ?? Infinity, HARD_MAX_WALL_MS),
    ...(c.stop_below_hp_ratio !== undefined ? { stop_below_hp_ratio: c.stop_below_hp_ratio } : {}),
  };
}

const HARD_MAX_ACTIONS = 30;
const HARD_MAX_GAME_TURNS = 30;
const HARD_MAX_WALL_MS = 60_000;
