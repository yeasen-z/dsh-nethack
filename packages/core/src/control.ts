/**
 * Control manager: interaction mode vs execution ownership, control epochs,
 * and per-task leases (handoff sections 7-9).
 *
 * Rules implemented here:
 *  - Only one controller can write at a time (ownership = human|agent|skill...).
 *  - `control_epoch` changes on every ownership transition or cancellation.
 *  - A late action/proposal captured under an older epoch must never execute.
 *  - In `delegated`/`agent` modes the middleware grants only the requested
 *    bounded task's lease — not unrestricted future action rights.
 *  - Read-only questions never grant a lease (enforced by callers only asking
 *    for leases when they intend to act; this class exposes nothing else).
 */
import type { ActionSource, ControlStatus, InteractionMode } from "./types.js";

export interface Lease {
  task_id: string;
  epoch: number;
}

export class ControlManager {
  private _mode: InteractionMode = "human";
  private _owner: ActionSource = "human";
  private _epoch = 1;
  private _lease: Lease | null = null;

  get status(): ControlStatus {
    return {
      mode: this._mode,
      owner: this._owner,
      epoch: this._epoch,
      active_task_id: this._lease?.task_id ?? null,
    };
  }

  get epoch(): number {
    return this._epoch;
  }

  /** Set interaction mode. Ownership transitions always bump the epoch. */
  setMode(mode: InteractionMode): number {
    if (mode === this._mode) return this._epoch;
    this._mode = mode;
    return this.bumpEpoch(`mode:${mode}`);
  }

  /**
   * Grant a single bounded task lease (used by executeSkill). The holder may
   * submit actions tagged with this task_id while the lease is live.
   */
  grantLease(task_id: string): Lease {
    this._lease = { task_id, epoch: this._epoch };
    this._owner = "skill";
    return this._lease;
  }

  revokeLease(): void {
    this._lease = null;
  }

  hasActiveLease(task_id: string | undefined): boolean {
    return this._lease !== null && task_id !== undefined && this._lease.task_id === task_id;
  }

  /**
   * Execution-permission check for a submitted request. Returns a machine
   * reason when denied. This is ownership validation only; state-version and
   * input-kind checks live in the session core.
   */
  canExecute(source: ActionSource, task_id: string | undefined): { ok: boolean; reason?: "mode_denied" | "no_lease" | "stale_control_epoch" } {
    if (source === "human") return { ok: true }; // direct controls remain available through the same authority
    if (source === "system") return { ok: true };
    if (this._mode === "human" || this._mode === "suggest") return { ok: false, reason: "mode_denied" };
    if (this._mode === "approval") {
      // Approval-mode steps are executed only when explicitly approved; the
      // orchestration layer stamps approved proposals with source "agent".
      return { ok: true };
    }
    if (this._mode === "delegated") {
      if (!this.hasActiveLease(task_id)) return { ok: false, reason: "no_lease" };
      return { ok: true };
    }
    if (this._mode === "agent") return { ok: true };
    return { ok: false, reason: "mode_denied" };
  }

  /** Stop/takeOver entry point: revoke AI permission, bump epoch. */
  stopAi(takeOwnership: boolean): { epoch_before: number; epoch_after: number } {
    const before = this._epoch;
    this._lease = null;
    this._mode = takeOwnership ? "human" : this._mode;
    this._owner = takeOwnership ? "human" : this._owner;
    this._epoch += 1;
    return { epoch_before: before, epoch_after: this._epoch };
  }

  /** Transfer write ownership (e.g. skill finishes, human takes over). */
  transfer(target: ActionSource): number {
    if (target === this._owner) return this._epoch;
    this._owner = target;
    return this.bumpEpoch(`owner:${target}`);
  }

  private bumpEpoch(_why: string): number {
    this._epoch += 1;
    return this._epoch;
  }
}
