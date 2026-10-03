import type { AdapterCapabilities, InputState, Observation, TerrainKind, TileSnapshot } from "@nhchat/core";
import type { GlyphInfo, RuntimeEvent, RuntimePrompt } from "./protocol.js";

/** Symbol indices from pinned NetHack include/defsym.h, not display characters. */
export function terrainFromSymbol(index: number): TerrainKind {
  if (index >= 1 && index <= 11) return "wall";
  if (index >= 12 && index <= 14) return "door_open";
  if (index === 15 || index === 16) return "door_closed";
  if (index >= 19 && index <= 21) return "floor";
  if (index >= 22 && index <= 24) return "corridor";
  if ([25, 27, 29, 31].includes(index)) return "stairs_up";
  if ([26, 28, 30, 32].includes(index)) return "stairs_down";
  if (index === 38) return "water";
  return "unknown";
}

export function inputFromPrompt(id: string, prompt: RuntimePrompt): InputState {
  switch (prompt.kind) {
    case "command": return { kind: "command" };
    case "direction": return { kind: "direction", promptId: id };
    case "more": return { kind: "more", promptId: id };
    case "menu": return { kind: "menu", promptId: id, title: prompt.label, allowMulti: prompt.allowMulti ?? false,
      options: (prompt.items ?? []).map(item => ({ optionId: String(item.index), label: item.label, letter: item.accelerator })) };
    case "yes_no_or_key":
      if (prompt.choices?.includes("y") && prompt.choices.includes("n")) return { kind: "yes_no", promptId: id, question: prompt.label };
      return { kind: "text", promptId: id, purpose: prompt.label };
    default: return { kind: "text", promptId: id, purpose: prompt.label };
  }
}

/** Accumulate callbacks, publish only when the engine explicitly waits for input. */
export class ObservationBuilder {
  private tiles = new Map<string, TileSnapshot>();
  private messages: string[] = [];
  private position = { x: 0, y: 0 };
  private hp: number | null = null;
  private maxHp: number | null = null;
  private turn = 0;
  private level = "unknown";
  private mapGeneration = 0;
  private conditions: string[] = [];
  private version = 0;
  private published: Observation | null = null;
  private generation = globalThis.crypto.randomUUID();

  constructor(private sessionId: string, private capabilities: AdapterCapabilities) {}

  accept(event: RuntimeEvent): void {
    if (event.type === "input_required") this.publish(inputFromPrompt(`${this.sessionId}:${this.generation}:${event.requestId}`, event.prompt));
    else if (event.type === "ended") this.publish({ kind: "game_over", reason: `engine_exit_${event.exitCode}` });
    else if (event.type === "event") {
      const data = event.data;
      switch (event.name) {
        case "message": case "raw_message":
          if (typeof data.text === "string") this.messages = [...this.messages, data.text].slice(-40);
          break;
        case "map_cleared": this.tiles.clear(); this.mapGeneration++; break;
        case "player_position":
          if (Number.isInteger(data.x) && Number.isInteger(data.y)) this.position = { x: Number(data.x), y: Number(data.y) };
          break;
        case "glyph": {
          const glyph = data.glyph as GlyphInfo | null;
          if (!glyph || !Number.isInteger(data.x) || !Number.isInteger(data.y)) break;
          const key = `${data.x},${data.y}`;
          // MG_NOTHING / MG_UNEXPL / MG_BADXY are not known terrain.
          if (glyph.glyphFlags & (0x400 | 0x800 | 0x4000)) { this.tiles.delete(key); break; }
          const foreground = terrainFromSymbol(glyph.symbolIndex);
          // Upstream background glyphs can derive from current levl[] rather
          // than remembered terrain (display.c explicitly notes this). Never
          // use them to infer what lies under a monster or object.
          const terrain = foreground === "unknown" ? this.tiles.get(key)?.terrain ?? "unknown" : foreground;
          // Windowport redraws include remembered cells: they do NOT prove line
          // of sight. Conservatively keep terrain remembered and export no
          // current entities until a reliable visibility hook is implemented.
          this.tiles.set(key, { x: Number(data.x), y: Number(data.y), terrain, visibility: "remembered" });
          break;
        }
        case "status": {
          const value = data.value;
          const numeric = typeof value === "string" && /^\s*-?\d+\s*$/.test(value) ? Number(value) : null;
          if (data.fieldIndex === 18) this.hp = numeric;
          else if (data.fieldIndex === 19) this.maxHp = numeric;
          else if (data.fieldIndex === 16 && numeric !== null) this.turn = numeric;
          else if (data.fieldIndex === 20 && typeof value === "string") this.level = value.trim() || "unknown";
          else if (data.fieldIndex === 22 && Array.isArray(data.conditions)) this.conditions = data.conditions.filter((item): item is string => typeof item === "string");
          break;
        }
      }
    }
  }

  private publish(input: InputState) {
    this.published = {
      schema_version: "0.1", session_id: this.sessionId, state_version: ++this.version,
      // Displayed dungeon labels are not globally unique. A cleared map starts
      // a conservative new coordinate namespace, even on a same-level redraw.
      turn: this.turn, level_id: `${this.level}:map-${this.mapGeneration}`, player: { position: { ...this.position }, hp: this.hp, max_hp: this.maxHp, conditions: [...this.conditions] },
      tiles: [...this.tiles.values()], entities: [], inventory: [], messages: [...this.messages], input,
      available_actions: input.kind === "command" ? ["move", "wait", "open", "pickup"] : input.kind === "game_over" ? [] : input.kind === "text" ? [] : ["respond"],
      capabilities: this.capabilities, terminal: input.kind === "game_over",
    };
  }

  snapshot(): Observation {
    if (!this.published) throw new Error("Runtime has not reached an input boundary");
    return structuredClone(this.published);
  }
}
