/**
 * Runtime validation for core contracts (handoff section 7: "Schema validation
 * checks syntax; execution validation separately checks ownership, state
 * version, input kind, capability, and task constraints" — the latter lives in
 * session.ts / control.ts).
 */
import {
  DIRECTIONS,
  type ActionRequest,
  type Direction,
  type GameAction,
  type PromptResponse,
} from "./types.js";

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function isDirection(v: unknown): v is Direction {
  return isStr(v) && (DIRECTIONS as readonly string[]).includes(v);
}

export function parseGameAction(v: unknown): GameAction | null {
  if (!isObj(v) || !isStr(v.action)) return null;
  switch (v.action) {
    case "move":
    case "open":
      return isDirection(v.direction)
        ? ({ action: v.action, direction: v.direction } as GameAction)
        : null;
    case "wait":
      return { action: "wait" };
    case "pickup":
      return { action: "pickup" };
    case "respond": {
      if (!isStr(v.promptId)) return null;
      const resp = parsePromptResponse(v.response);
      return resp ? { action: "respond", promptId: v.promptId, response: resp } : null;
    }
    default:
      return null; // unknown action names are simply invalid proposals
  }
}

export function parsePromptResponse(v: unknown): PromptResponse | null {
  if (!isObj(v) || !isStr(v.kind)) return null;
  switch (v.kind) {
    case "direction":
      return isDirection(v.direction) ? { kind: "direction", direction: v.direction } : null;
    case "menu":
      return Array.isArray(v.optionIds) && v.optionIds.every(isStr)
        ? { kind: "menu", optionIds: v.optionIds as string[] }
        : null;
    case "yes_no":
      return typeof v.value === "boolean" ? { kind: "yes_no", value: v.value } : null;
    case "more":
      return { kind: "more" };
    case "cancel":
      return { kind: "cancel" };
    default:
      return null;
  }
}

export interface RequestValidation {
  ok: boolean;
  errors: string[];
  /**
   * Set when the envelope is fine but the action NAME is not one of the five
   * typed GameAction variants (e.g. a hallucinated "cast"). Session code uses
   * this to answer `unsupported_action` instead of `invalid_request_schema`,
   * keeping the two rejection reasons distinguishable.
   */
  unknown_action_name?: boolean;
}

const KNOWN_ACTION_NAMES = ["move", "wait", "open", "pickup", "respond"] as const;

export function validateActionRequestShape(v: unknown): RequestValidation {
  const errors: string[] = [];
  if (!isObj(v)) {
    return { ok: false, errors: ["request must be an object"] };
  }
  const r = v as Partial<ActionRequest> & Record<string, unknown>;
  if (!isStr(r.request_id) || r.request_id.length === 0) errors.push("request_id must be a non-empty string");
  if (!isStr(r.session_id) || r.session_id.length === 0) errors.push("session_id must be a non-empty string");
  if (!isNum(r.expected_state_version) || !Number.isInteger(r.expected_state_version) || r.expected_state_version < 0)
    errors.push("expected_state_version must be a non-negative integer");
  if (!isNum(r.control_epoch) || !Number.isInteger(r.control_epoch) || r.control_epoch < 0)
    errors.push("control_epoch must be a non-negative integer");
  if (!["human", "agent", "skill", "system"].includes(String(r.source)))
    errors.push("source must be one of human|agent|skill|system");
  if (r.task_id !== undefined && !isStr(r.task_id)) errors.push("task_id must be a string when present");
  if (parseGameAction(r.action) === null) {
    // Distinguish "unknown action name" from "malformed known action".
    const name = isObj(r.action) && isStr((r.action as Record<string, unknown>).action)
      ? (r.action as Record<string, unknown>).action as string
      : "";
    if (name.length > 0 && !(KNOWN_ACTION_NAMES as readonly string[]).includes(name)) {
      return { ok: false, errors: ["action name is not a typed GameAction variant"], unknown_action_name: true };
    }
    errors.push("action is not a supported typed GameAction");
  }
  return { ok: errors.length === 0, errors };
}
