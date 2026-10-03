/**
 * Fake NetHack-like runtime + WASM-adapter-shaped bridge.
 *
 * WHY THIS EXISTS: the pinned real NetHack 5.0 WASM shim now has an initial
 * adapter (see docs/real-adapter.md). To keep fast, deterministic middleware
 * contract tests independent of its browser/toolchain dependencies, we ship a
 * small deterministic engine that follows NetHack-ish rules. It is clearly
 * labeled (`runtime_id: "fake-nh@0.1"`) and MUST NOT be presented as a real
 * game session in any delivered MVP demo.
 *
 * Design notes mirroring the handoff:
 *  - Observations are produced only at recognized input boundaries (after each
 *    committed semantic action), never mid-callback (section 5).
 *  - The adapter encodes ONLY the expected action-specific prompt sequence and
 *    stops at unexpected prompts; no blind key injection (section 6).
 *  - Player-visible information only: unseen monsters/terrain are absent;
 *    unidentified items keep null properties (section 5, rules 1-3).
 */
import type {
  AdapterCapabilities,
  AdapterDelivery,
  Direction,
  GameAction,
  GameAdapter,
  InputState,
  InventoryEntry,
  Observation,
  PromptOption,
  TerrainKind,
  TileSnapshot,
  Vec2,
} from "@nhchat/core";
import { directionDelta } from "@nhchat/core";

// ---------------------------------------------------------------------------
// Map model
// ---------------------------------------------------------------------------

interface Cell {
  terrain: TerrainKind; // absolute truth (engine side, never exported raw)
  seen: boolean;        // player has ever seen it -> remembered
  visible_now: boolean; // recomputed per boundary -> visible
}

interface EngineMonster {
  id: string;
  name: string;
  kind: string | null; // null => seen but not identified (uncertainty preserved)
  pos: Vec2;
  hp: number;
}

interface EngineObject {
  id: string;
  name: string;
  pos: Vec2;
  on_floor: boolean;
  carried_slot?: string;
  known_props: Record<string, string | boolean> | null; // null => unidentified
}

const W = 16;
const H = 12;

/**
 * Hand-authored room + corridor map. Door at (9,6) leads east into a room with
 * a potion on the floor and a rat. Coordinates: origin upper-left, x east, y south.
 */
function buildMap(): Cell[][] {
  const grid: Cell[][] = [];
  for (let y = 0; y < H; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < W; x++) row.push({ terrain: "wall", seen: false, visible_now: false });
    grid.push(row);
  }
  const carve = (x0: number, y0: number, x1: number, y1: number, t: TerrainKind = "floor") => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid[y][x].terrain = t;
  };
  carve(2, 2, 8, 8);          // west room
  carve(4, 6, 8, 6, "corridor");
  grid[6][9].terrain = "door_closed";      // the door
  carve(10, 3, 13, 9);        // east room
  return grid;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

class FakeNetHackEngine {
  private grid = buildMap();
  private pos: Vec2 = { x: 5, y: 5 };
  private hp = 31;
  private maxHp = 37;
  private turn = 0;
  private stateVersion = 1;
  private messages: string[] = ["Welcome to NetHack! (FAKE runtime — not a real game session.)"];
  private monsters: EngineMonster[] = [
    { id: "m1", name: "rat", kind: "rat", pos: { x: 12, y: 6 }, hp: 4 },
  ];
  private objects: EngineObject[] = [
    { id: "o1", name: "potion", pos: { x: 12, y: 5 }, on_floor: true, known_props: null },
  ];
  private invSeq = 0;
  /** Pending prompt opened by the last action, or null when at command. */
  pendingPrompt: Extract<InputState, { kind: "direction" | "menu" | "yes_no" }> | null = null;
  private promptSeq = 0;
  terminal = false;
  gameOverReason = "";

  constructor(private session_id: string) {}

  private bumpState() {
    this.stateVersion += 1;
  }

  private pushMsg(m: string) {
    this.messages.push(m);
    if (this.messages.length > 20) this.messages.shift();
  }

  private inBounds(p: Vec2) {
    return p.x >= 0 && p.y >= 0 && p.x < W && p.y < H;
  }

  private cellAt(p: Vec2): Cell | null {
    return this.inBounds(p) ? this.grid[p.y][p.x] : null;
  }

  private monsterAt(p: Vec2): EngineMonster | undefined {
    return this.monsters.find((m) => m.pos.x === p.x && m.pos.y === p.y);
  }

  private objectAt(p: Vec2): EngineObject | undefined {
    return this.objects.find((o) => o.on_floor && o.pos.x === p.x && o.pos.y === p.y);
  }

  private passableFor(p: Vec2): boolean {
    const c = this.cellAt(p);
    if (!c) return false;
    return c.terrain === "floor" || c.terrain === "corridor" || c.terrain === "door_open"
      || c.terrain === "stairs_down" || c.terrain === "stairs_up";
  }

  /** Simple radius-4 light cone; marks cells visible & seen. */
  private recomputeVision() {
    for (const row of this.grid) for (const c of row) c.visible_now = false;
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > 4) continue;
        const p = { x: this.pos.x + dx, y: this.pos.y + dy };
        const c = this.cellAt(p);
        if (!c) continue;
        c.visible_now = true;
        c.seen = true;
      }
    }
  }

  // --- actions -------------------------------------------------------------

  move(dir: Direction): void {
    if (this.pendingPrompt) throw new Error("engine busy: direction prompt pending");
    const d = directionDelta(dir);
    const target = { x: this.pos.x + d.x, y: this.pos.y + d.y };
    const c = this.cellAt(target);
    if (!c) { this.turn += 1; this.bumpState(); return; }
    if (c.terrain === "door_closed") {
      this.pushMsg(`It's closed.`);
      // NetHack bumps without consuming a turn here in the fake engine.
      this.bumpState();
      return;
    }
    if (!this.passableFor(target)) {
      this.pushMsg(`You can't walk through that.`);
      this.bumpState();
      return;
    }
    const mon = this.monsterAt(target);
    if (mon) {
      // Melee instead of moving (movement can have combat side effects).
      mon.hp -= 4;
      this.turn += 1;
      if (mon.hp <= 0) {
        this.monsters = this.monsters.filter((m) => m !== mon);
        this.pushMsg(`You kill the ${mon.name}!`);
      } else {
        this.pushMsg(`Whack!`);
        // monster retaliates
        this.hp -= 2;
        if (this.hp <= 0) this.die("killed by a rat");
      }
      this.bumpState();
      return;
    }
    this.pos = target;
    this.turn += 1;
    const obj = this.objectAt(target);
    if (obj && c.visible_now) this.pushMsg(`You see here ${describe(obj)}.`);
    // Basic monster movement toward player if adjacent-visible (deterministic)
    this.stepMonsters();
    this.recomputeVision();
    this.bumpState();
  }

  wait(): void {
    if (this.pendingPrompt) throw new Error("engine busy");
    this.turn += 1;
    this.pushMsg(`You wait.`);
    this.stepMonsters();
    this.bumpState();
  }

  open(dir: Direction): void {
    if (this.pendingPrompt) throw new Error("engine busy");
    this.pushMsg(`In what direction? `);
    this.pendingPrompt = { kind: "direction", promptId: `prompt-${++this.promptSeq}` };
    this.pendingDirectionAfterOpen = dir;
    this.bumpState();
  }
  private pendingDirectionAfterOpen: Direction | null = null;

  answerDirection(dir: Direction): void {
    if (!this.pendingPrompt || this.pendingPrompt.kind !== "direction")
      throw new Error("no direction prompt pending");
    const promptId = this.pendingPrompt.promptId;
    this.pendingPrompt = null;
    const afterOpen = this.pendingDirectionAfterOpen;
    this.pendingDirectionAfterOpen = null;
    const d = directionDelta(dir);
    const target = { x: this.pos.x + d.x, y: this.pos.y + d.y };
    const c = this.cellAt(target);
    if (afterOpen) {
      if (c && c.terrain === "door_closed") {
        c.terrain = "door_open";
        this.turn += 1;
        this.pushMsg(`The door opens.`);
      } else {
        this.pushMsg(`There is no door there.`);
      }
    } else {
      this.pushMsg(`You head off in some direction (ignored).`);
    }
    void promptId;
    this.recomputeVision();
    this.bumpState();
  }

  pickup(): void {
    if (this.pendingPrompt) throw new Error("engine busy");
    const here = this.objects.filter((o) => o.on_floor && o.pos.x === this.pos.x && o.pos.y === this.pos.y);
    if (here.length === 0) {
      this.pushMsg(`There is nothing there to pick up.`);
      this.bumpState();
      return;
    }
    if (here.length === 1) {
      this.pickupOne(here[0]);
      this.bumpState();
      return;
    }
    // Multi-item tile -> selection menu (handoff section 6 example).
    const options: PromptOption[] = here.map((o, i) => ({
      optionId: `opt-${i}`,
      label: describe(o),
      letter: String.fromCharCode(97 + i),
    }));
    this.pendingPrompt = {
      kind: "menu",
      promptId: `prompt-${++this.promptSeq}`,
      title: "Pick things up:",
      allowMulti: true,
      options,
    };
    this.pickupMenuObjects = here;
    this.bumpState();
  }
  private pickupMenuObjects: EngineObject[] = [];

  private pickupOne(o: EngineObject) {
    o.on_floor = false;
    o.carried_slot = String.fromCharCode(97 + this.invSeq++);
    this.turn += 1;
    this.pushMsg(`You pick up ${describe(o)}.`);
  }

  answerMenu(optionIds: string[]): void {
    if (!this.pendingPrompt || this.pendingPrompt.kind !== "menu")
      throw new Error("no menu prompt pending");
    const chosen = optionIds
      .map((id) => this.pickupMenuObjects[Number(id.split("-")[1])])
      .filter(Boolean);
    this.pendingPrompt = null;
    this.pickupMenuObjects = [];
    for (const o of chosen) this.pickupOne(o);
    if (chosen.length === 0) this.pushMsg(`Never mind.`);
    this.bumpState();
  }

  cancelPrompt(): void {
    if (!this.pendingPrompt) throw new Error("no prompt pending");
    this.pendingPrompt = null;
    this.pendingDirectionAfterOpen = null;
    this.pickupMenuObjects = [];
    this.pushMsg(`Never mind.`);
    this.bumpState();
  }

  private stepMonsters() {
    for (const m of this.monsters) {
      const dist = Math.abs(m.pos.x - this.pos.x) + Math.abs(m.pos.y - this.pos.y);
      const c = this.cellAt(m.pos);
      const wasVisible = c?.visible_now ?? false;
      // Keep the fake scenario deterministic and tactically observable: a
      // monster starts chasing only after the player has actually seen it.
      // Hidden monsters still exist engine-side but cannot affect planning
      // before they enter the player-visible observation.
      if (wasVisible && dist <= 6) {
        // deterministic single-step chase using cardinal preference
        const dx = Math.sign(this.pos.x - m.pos.x);
        const dy = Math.sign(this.pos.y - m.pos.y);
        const trySteps: Vec2[] = dx !== 0 ? [{ x: m.pos.x + dx, y: m.pos.y }] : [{ x: m.pos.x, y: m.pos.y + dy }];
        const t = trySteps[0];
        const tc = this.cellAt(t);
        if (tc && (tc.terrain === "floor" || tc.terrain === "corridor" || tc.terrain === "door_open") &&
            !(t.x === this.pos.x && t.y === this.pos.y)) {
          m.pos = t;
        } else if (t.x === this.pos.x && t.y === this.pos.y) {
          this.hp -= 1;
          this.pushMsg(`The ${m.name} bites!`);
          if (this.hp <= 0) this.die(`killed by a ${m.name}`);
        }
      }
    }
  }

  private die(reason: string) {
    this.terminal = true;
    this.gameOverReason = reason;
    this.pushMsg(`You die... Program ended.`);
    this.bumpState();
  }

  // --- observation ---------------------------------------------------------

  snapshot(): Observation {
    this.recomputeVision();
    const tiles: TileSnapshot[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = this.grid[y][x];
        if (c.visible_now) tiles.push({ x, y, terrain: c.terrain, visibility: "visible" });
        else if (c.seen) tiles.push({ x, y, terrain: c.terrain, visibility: "remembered" });
        // unseen cells are simply absent (rule 1: no hidden engine state leaks)
      }
    }
    const entities = [];
    for (const m of this.monsters) {
      const c = this.cellAt(m.pos);
      if (c?.visible_now) {
        entities.push({
          ref: `entity-${m.id}@v${this.stateVersion}`,
          kind: "monster" as const,
          position: { ...m.pos },
          display_name: m.name,
          monster_kind: m.kind, // null stays null: observed != known
        });
      }
    }
    for (const o of this.objects) {
      const c = this.cellAt(o.pos);
      if (o.on_floor && c?.visible_now) {
        entities.push({
          ref: `entity-${o.id}@v${this.stateVersion}`,
          kind: "object" as const,
          position: { ...o.pos },
          display_name: describe(o),
        });
      }
    }
    const inventory: InventoryEntry[] = this.objects
      .filter((o) => !o.on_floor)
      .map((o) => ({
        ref: `inventory-${o.id}@v${this.stateVersion}`,
        slot: o.carried_slot ?? null,
        display_name: describe(o),
        known_properties: o.known_props, // potion remains unidentified: null
      }));

    const input: InputState = this.terminal
      ? { kind: "game_over", reason: this.gameOverReason }
      : this.pendingPrompt
        ? { ...this.pendingPrompt }
        : { kind: "command" };

    return {
      schema_version: "0.1",
      session_id: this.session_id,
      state_version: this.stateVersion,
      turn: this.turn,
      level_id: "level-1",
      player: {
        position: { ...this.pos },
        hp: this.hp,
        max_hp: this.maxHp,
        conditions: [],
      },
      tiles,
      entities,
      inventory,
      messages: [...this.messages],
      input,
      available_actions:
        input.kind === "command" && !this.terminal
          ? ["move", "wait", "open", "pickup"]
          : PROMPT_KINDS.has(input.kind)
            ? ["respond"]
            : [],
      capabilities: FAKE_CAPABILITIES,
      terminal: this.terminal,
    };
  }
}

function describe(o: EngineObject): string {
  if (o.known_props === null && o.name === "potion") return "a potion (unidentified)";
  return `a ${o.name}`;
}

const PROMPT_KINDS = new Set(["direction", "menu", "yes_no", "more", "text"]);

const FAKE_CAPABILITIES: AdapterCapabilities = {
  runtime_id: "fake-nh@0.1",
  supports_automatic_text_entry: false, // MVP: text prompts hand off to human
  supports_save_load: false,
  supported_actions: ["move", "wait", "open", "pickup", "respond"],
};

// ---------------------------------------------------------------------------
// Adapter bridge (implements @nhchat/core GameAdapter)
// ---------------------------------------------------------------------------

/**
 * The bridge mirrors what the real WASM adapter will do: translate ONE
 * semantic action into its expected low-level input sequence, stop at any
 * unexpected prompt, and emit observations only at stable input boundaries.
 */
export class FakeWasmAdapter implements GameAdapter {
  readonly capabilities = FAKE_CAPABILITIES;
  private engine: FakeNetHackEngine | null = null;

  async start(session_id: string): Promise<void> {
    this.engine = new FakeNetHackEngine(session_id);
  }

  snapshot(): Observation {
    if (!this.engine) throw new Error("adapter not started");
    return this.engine.snapshot();
  }

  async deliver(action: GameAction): Promise<AdapterDelivery> {
    const e = this.engine;
    if (!e) throw new Error("adapter not started");
    const before = e.snapshot();

    const settled = (committed: boolean): AdapterDelivery => {
      const obs = e.snapshot();
      return { committed, outcome: obs.terminal ? "terminal" : "settled", observation: obs };
    };

    switch (action.action) {
      case "move": {
        e.move(action.direction);
        return settled(true);
      }
      case "wait": {
        e.wait();
        return settled(true);
      }
      case "open": {
        // Expected sequence: 'O' command -> direction prompt. We STOP here and
        // surface needs_input rather than auto-answering, because the answer
        // must come back as an explicit typed response (single write path,
        // stale-response protection).
        e.open(action.direction);
        const obs = e.snapshot();
        return { committed: true, outcome: "needs_input", observation: obs };
      }
      case "pickup": {
        e.pickup();
        const obs = e.snapshot();
        if (obs.input.kind === "menu") {
          return { committed: true, outcome: "needs_input", observation: obs };
        }
        return settled(true);
      }
      case "respond": {
        const cur = before.input as { promptId?: string };
        if (cur.promptId !== action.promptId) {
          // Stale/mismatched response must never reach the runtime.
          return { committed: false, outcome: "failed", reason: "prompt_mismatch", observation: before };
        }
        const r = action.response;
        if (r.kind === "cancel") {
          e.cancelPrompt();
          return settled(true);
        }
        if (before.input.kind === "direction" && r.kind === "direction") {
          e.answerDirection(r.direction);
          return settled(true);
        }
        if (before.input.kind === "menu" && r.kind === "menu") {
          e.answerMenu(r.optionIds);
          return settled(true);
        }
        // Response kind does not match the live prompt: unexpected prompt stop.
        return { committed: false, outcome: "unexpected_prompt", observation: before };
      }
    }
  }
}
