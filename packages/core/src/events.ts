/**
 * Ordered session event log (handoff section 13). Events carry session_id,
 * seq, timestamp, turn, state_version, control epoch, request/task IDs and
 * source. Credentials and hidden reasoning are never recorded here; callers
 * pass only concise explanations/summaries.
 */
import type { Observation, SessionEvent, SessionEventType } from "./types.js";

export type EventListener = (event: SessionEvent) => void;

export class EventLog {
  private seq = 0;
  private listeners = new Set<EventListener>();
  private history: SessionEvent[] = [];

  constructor(readonly session_id: string) {}

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(
    type: SessionEventType,
    ctx: { turn: number; state_version: number; control_epoch: number },
    data: Record<string, unknown> & {
      request_id?: string;
      task_id?: string;
      source?: SessionEvent["source"];
    } = {},
  ): SessionEvent {
    const event: SessionEvent = {
      session_id: this.session_id,
      seq: ++this.seq,
      timestamp: Date.now(),
      turn: ctx.turn,
      state_version: ctx.state_version,
      control_epoch: ctx.control_epoch,
      type,
      data,
    };
    if (data.request_id !== undefined) event.request_id = data.request_id;
    if (data.task_id !== undefined) event.task_id = data.task_id;
    if (data.source !== undefined) event.source = data.source;
    this.history.push(event);
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // a broken listener must not break the write path
      }
    }
    return event;
  }

  /** Trace playback support: reconstruct recorded events in order. */
  trace(): SessionEvent[] {
    return [...this.history];
  }

  toTraceJsonl(): string {
    return this.history.map((e) => JSON.stringify(e)).join("\n") + "\n";
  }
}

/** Snapshot diffing helper: did anything player-visible change? */
export function observationChanged(a: Observation | null, b: Observation): boolean {
  if (a === null) return true;
  return (
    a.state_version !== b.state_version ||
    a.input.kind !== b.input.kind ||
    (a.input as { promptId?: string }).promptId !== (b.input as { promptId?: string }).promptId
  );
}
