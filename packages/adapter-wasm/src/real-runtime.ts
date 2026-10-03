import type { AdapterCapabilities, AdapterDelivery, Direction, GameAction, GameAdapter } from "@nhchat/core";
import { ObservationBuilder } from "./observation-builder.js";
import type { RuntimeBoundary, RuntimeWorker } from "./protocol.js";
import { RuntimeWorkerClient } from "./worker-client.js";

const KEYS: Record<Direction, string> = { north: "8", northeast: "9", east: "6", southeast: "3", south: "2", southwest: "1", west: "4", northwest: "7" };

/** Real shim bridge. Each action commits at most ONE input before returning. */
export class RealWasmAdapter implements GameAdapter {
  readonly capabilities: AdapterCapabilities = {
    runtime_id: "nh5.0-wasm-shim@9c3a54d", supports_automatic_text_entry: false,
    supports_save_load: false, supports_navigation: false, supported_actions: ["move", "wait", "open", "pickup", "respond"],
  };
  private builder: ObservationBuilder | null = null;
  private client: RuntimeWorkerClient | null = null;
  private boundary: RuntimeBoundary | null = null;
  private busy = false;
  private failed = false;

  constructor(private createWorker: () => RuntimeWorker, private options: { playerName?: string; timeoutMs?: number } = {}) {}

  async start(sessionId: string): Promise<void> {
    if (this.client) throw new Error("Adapter already started");
    this.builder = new ObservationBuilder(sessionId, this.capabilities);
    this.client = new RuntimeWorkerClient(this.createWorker(), event => this.builder!.accept(event), this.options.timeoutMs);
    try { this.boundary = await this.client.start(this.options.playerName); }
    catch (error) { this.failed = true; this.client.terminate(); throw error; }
  }

  snapshot() {
    if (!this.builder) throw new Error("Adapter not started");
    return this.builder.snapshot();
  }

  async deliver(action: GameAction): Promise<AdapterDelivery> {
    const before = this.snapshot();
    const reject = (reason: string): AdapterDelivery => ({ committed: false, outcome: "failed", reason, observation: before });
    if (this.failed) return reject("runtime_requires_restart");
    if (this.busy) return reject("runtime_busy");
    if (before.terminal || !this.boundary) return reject("runtime_ended");
    let value: string;
    if (action.action !== "respond") {
      if (before.input.kind !== "command") return reject("wrong_input_state");
    // NetHack may reject a bare `.` as pointless when no threat is nearby.
    // `m.` forces the no-op/rest command and reliably consumes exactly one turn.
    value = action.action === "move" ? KEYS[action.direction] : action.action === "wait" ? "m." : action.action === "open" ? "o" : ",";
    } else {
      if (!("promptId" in before.input) || action.promptId !== before.input.promptId) return reject("prompt_mismatch");
      const response = action.response;
      const input = before.input;
      if (response.kind === "cancel") value = input.kind === "menu" ? "cancel" : "\u001b";
      else if (input.kind === "direction" && response.kind === "direction") value = KEYS[response.direction];
      else if (input.kind === "more" && response.kind === "more") value = " ";
      else if (input.kind === "yes_no" && response.kind === "yes_no") value = response.value ? "y" : "n";
      else if (input.kind === "menu" && response.kind === "menu") {
        if ((!input.allowMulti && response.optionIds.length > 1) || response.optionIds.some(id => !input.options.some(option => option.optionId === id))) return reject("invalid_menu_selection");
        // The Worker accepts numeric menu indices, avoiding accelerator aliases.
        value = [...new Set(response.optionIds)].map(id => `index:${id}`).join(",");
      } else return reject("wrong_response_kind");
    }
    if (typeof value !== "string") return reject("invalid_direction");
    this.busy = true;
    try {
      this.boundary = await this.client!.respond(this.boundary.requestId, value);
      const observation = this.snapshot();
      return { committed: true, outcome: observation.terminal ? "terminal" : observation.input.kind === "command" ? "settled" : "needs_input", observation };
    } catch (error) {
      // Delivery may already have reached C; retain the last stable snapshot,
      // poison the client and require explicit restart rather than replaying.
      this.failed = true;
      throw error;
    } finally { this.busy = false; }
  }

  terminate(): void {
    this.failed = true;
    this.client?.terminate();
  }
}
