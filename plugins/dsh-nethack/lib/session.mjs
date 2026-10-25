// dsh-nethack — the game's own DSH session.
//
// The panel's conversation is NOT a private chat loop. It is an ordinary DSH
// Session, so everything the harness already knows how to do applies to it for
// free: the native transcript and composer in the panel, streaming, per-session
// model selection, compaction, turn cancellation, persistence.
//
// What makes it a *NetHack* session is not its type but its scope:
//
//   - the three game tools are registered into the agent's own scope
//     (`ctx.tools.register` on `agent.ctx`), never globally, and that agent is
//     restricted to exactly those names, so no other conversation can see or
//     call them and this one cannot call anything else;
//   - the agent preset `nethack` (this package's `cordis.patch.yml`) supplies
//     the persona that describes the game loop.
//
// One game, one session. A restart (`nethack_restart`) mints a new game id and
// therefore a new session, which is what gives a new game an empty transcript.
//
// The SESSION IS CREATED BY THE PANEL, not here. The client's session catalog
// learns an identity when the client creates it; a Host-created session the
// page has never heard of cannot be retained or bound by the panel's slots.
// So the panel calls `sessions.create({agentPreset:'nethack'})`, posts the id
// here, and this module attaches the game to it.

/** The agent preset this plugin declares for its own session. */
export const GAME_PRESET = "nethack";

/** Tools the game session may call: the game, and nothing else. */
export const GAME_TOOLS = ["nethack_observe", "nethack_act", "nethack_respond"];

export class GameSession {
  /**
   * @param ctx - Host context of this plugin.
   * @param options.definitions - the model-facing game tools, built once per load.
   */
  constructor(ctx, options) {
    this.ctx = ctx;
    this.definitions = options.definitions;
    this.installations = new Map();
    /** @type {string | undefined} session currently attached to the game */
    this.sessionId = undefined;
    /** @type {string | undefined} game the session belongs to */
    this.gameId = undefined;
  }

  /**
   * Adopt a session for the given game.
   *
   * Idempotent across plugin reloads: the agent outlives this module, so the
   * scope is inspected before anything is registered into it again.
   *
   * @returns `{session_id, attached, tools}`; `tools` is the visible tool names
   *   the game session ended up with, which is how the panel can prove the
   *   isolation instead of trusting it.
   */
  attach(sessionId, gameId) {
    const agents = this.ctx.get("agents");
    const agent = agents?.get(sessionId);
    if (agent === undefined) return { error: "session_not_live", session_id: sessionId };
    const presets = this.ctx.get("agentPresets");
    if (presets && presets.composedPreset(agent.ctx) !== GAME_PRESET) {
      return { error: "wrong_session_preset", session_id: sessionId };
    }
    let tools;
    try {
      tools = this.install(agent);
    } catch (cause) {
      const detail = String(cause?.message ?? cause);
      this.lastFailure = { session_id: sessionId, detail };
      this.ctx.logger?.warn?.(`dsh-nethack: tool isolation failed: ${detail}`);
      return { error: "tool_isolation_failed", detail, session_id: sessionId };
    }
    if (this.sessionId !== sessionId) this.detach();
    this.sessionId = sessionId;
    this.gameId = gameId;
    return { session_id: sessionId, game_id: gameId, tools };
  }

  /** Drop the association; the session itself is left alone. */
  detach() {
    const installation = this.installations.get(this.sessionId);
    installation?.dispose();
    this.sessionId = undefined;
    this.gameId = undefined;
  }

  dispose() {
    for (const installation of [...this.installations.values()]) installation.dispose();
    this.sessionId = undefined;
    this.gameId = undefined;
  }

  /** Whether the attached session is still live. */
  live() {
    if (this.sessionId === undefined) return undefined;
    return this.ctx.get("agents")?.get(this.sessionId);
  }

  /** Tool names the attached session can currently see. */
  tools() {
    const agent = this.live();
    if (agent === undefined) return [];
    const registry = this.ctx.get("tools");
    if (typeof registry?.schemas !== "function") return [];
    return (registry.schemas(agent) ?? []).map((schema) => schema.name).filter(name => GAME_TOOLS.includes(name));
  }

  /**
   * Bind the game's tools and prompt to one agent scope, once.
   *
   * The names are read back out of the registry afterwards rather than assumed:
   * a reload re-runs this against an agent that already has the tools, and
   * registering the same name twice in one layer is an error, so the check has
   * to be observable state and not a flag on this module.
   *
   * @returns the tool names visible to that agent.
   */
  install(agent) {
    const registry = this.ctx.get("tools");
    if (typeof registry?.schemas !== "function" || typeof agent.ctx?.tools?.register !== "function") {
      throw new Error("tool registry unavailable");
    }
    const visible = () => (registry.schemas(agent) ?? []).map((schema) => schema.name);
    const exact = names => names.length === GAME_TOOLS.length && GAME_TOOLS.every(name => names.includes(name));
    const installed = this.installations.get(agent.id);
    if (installed?.agent === agent && exact(visible())) return visible();
    installed?.dispose();

    const disposers = [];
    const dispose = () => {
      for (const undo of disposers.splice(0).reverse()) undo?.();
      if (this.installations.get(agent.id)?.dispose === dispose) this.installations.delete(agent.id);
    };
    try {
      // Inherited PTC presentation adds reserved `run_code` AFTER restrictions.
      // The game speaks native three-tool calling, so pin presentation on THIS
      // agent scope; do not change the deployment or another session's mode.
      disposers.push(agent.ctx.tools.presentAs("native"));
      // `allow` names INHERITED tools, not local names. Empty allow is the
      // supported deny-all inherited mask; our own three registrations survive.
      disposers.push(agent.ctx.tools.restrict({ allow: [] }));
      for (const definition of this.definitions.filter(item => GAME_TOOLS.includes(item.name))) {
        disposers.push(agent.ctx.tools.register(definition));
      }
      // Host Agent Teams installs tools directly in EVERY root Agent's own
      // layer. Registry restrictions intentionally cannot remove own-layer
      // contributions. Use the documented scoped assembly waterfall to expose
      // only game schemas, AND a monotonic execution guard to deny all others.
      // Both are exact-agent scoped: other conversations keep their Team tools.
      disposers.push(agent.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
        const assembled = await next();
        const tools = assembled.tools.filter(tool => GAME_TOOLS.includes(tool.name));
        if (!exact(tools.map(tool => tool.name))) throw new Error("game prompt tool surface is incomplete");
        return { ...assembled, tools };
      }));
      disposers.push(agent.ctx.tools.guard(exec => GAME_TOOLS.includes(exec.name)
        ? undefined : "NetHack session permits only game tools"));
      const names = visible().filter(name => GAME_TOOLS.includes(name));
      if (!exact(names)) throw new Error(`missing game tools: ${names.join(", ") || "(none)"}`);
      this.installations.set(agent.id, { agent, dispose });
      return names;
    } catch (cause) {
      dispose();
      throw cause;
    }
  }

  /**
   * Abort whatever one session is doing right now.
   *
   * Only this plugin's own agent is interrupted: a cancel aimed at a session
   * that is not the game's is refused rather than forwarded, so a stray request
   * can never stop the conversation the user is working in.
   */
  cancel(sessionId) {
    if (sessionId !== this.sessionId) return false;
    const agent = this.live();
    if (agent === undefined) return false;
    agent.cancel({ kind: "user" });
    return true;
  }
}
