/**
 * explore_room — STUB (handoff section 9: "add explore_room only when the
 * execution and interruption contract is stable", i.e. after MVP validation on
 * a real runtime).
 *
 * Planned observable completion condition (MVP proposal):
 *   visiting all reachable KNOWN room tiles and reporting unexamined
 *   boundaries; NOT repeated secret-door searching; NOT exhaustive dungeon
 *   exploration.
 *
 * Explicit gaps before this can be enabled:
 *   1. The real WASM adapter must expose reliable room/area membership per
 *      tile (runtime-spike inventory item #5). The fake map has no room ids.
 *   2. "Unexamined boundary" needs a definition against real vision rules.
 *   3. Stop-rule behavior around doors/closed gates must be validated on the
 *      pinned engine build, not the fake runtime.
 */
import type { SkillExecutor } from "@nhchat/core";

export const exploreRoomExecutor: SkillExecutor = {
  async run() {
    throw new Error(
      "explore_room is not implemented yet: gated on milestone 7 (MVP validation on a real runtime). See docs/runtime-spike.md.",
    );
  },
};
