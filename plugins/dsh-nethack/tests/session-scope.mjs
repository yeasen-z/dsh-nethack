// Run: node --test plugins/dsh-nethack/tests/session-scope.mjs
// Exercises the game-session binder against a fake `tools` registry that models
// the real scoping rules (a scope sees its OWN registrations plus inherited ones
// filtered by any restriction). No Host process, Agent loop, or NetHack engine
// is involved: what is under test is the binder's contract, not NetHack.
import assert from "node:assert/strict";
import test from "node:test";

import { GameSession, GAME_TOOLS } from "../lib/session.mjs";

/**
 * A stand-in for `ctx.tools` that reproduces the two rules the binder depends
 * on: `register` is scoped to the calling context, and `restrict` filters only
 * what a scope INHERITS, never what it registered itself.
 */
function fakeRegistry() {
  const global = new Map([["read", { name: "read" }], ["bash", { name: "bash" }]]);
  const scopes = new WeakMap();
  const layerOf = (ctx) => {
    let layer = scopes.get(ctx);
    if (layer === undefined) scopes.set(ctx, layer = { own: new Map(), allow: undefined, mode: "native" });
    return layer;
  };
  return {
    global,
    layerOf,
    registerFrom(ctx, definition) {
      const layer = layerOf(ctx);
      if (layer.own.has(definition.name)) throw new Error(`duplicate tool "${definition.name}"`);
      layer.own.set(definition.name, definition);
      return () => layer.own.delete(definition.name);
    },
    restrictFrom(ctx, { allow }) {
      // Installed DSH accepts allow:[] and rejects local/non-inherited names.
      if (allow.some(name => !global.has(name))) throw new Error("unknown global tool");
      const layer = layerOf(ctx);
      const previous = layer.allow;
      layer.allow = new Set(allow);
      return () => { layer.allow = previous; };
    },
    schemas(scope) {
      const own = scope?.ctx === undefined ? undefined : scopes.get(scope.ctx);
      const visible = [];
      for (const [name, definition] of global) {
        if (own?.allow !== undefined && !own.allow.has(name)) continue;
        visible.push(definition);
      }
      if (own !== undefined) visible.push(...own.own.values());
      if (own?.mode === "ptc") visible.push({ name: "run_code" });
      return visible;
    },
  };
}

/** The minimum of an Agent this binder touches: an id and its own scope. */
function fakeAgent(id, registry) {
  const ctx = { listeners: new Map(), guards: [] };
  ctx.on = (event, fn) => { ctx.listeners.set(event, fn); return () => ctx.listeners.delete(event); };
  ctx.tools = {
    guard: fn => { ctx.guards.push(fn); return () => ctx.guards.splice(ctx.guards.indexOf(fn), 1); },
    presentAs: mode => {
      const layer = registry.layerOf(ctx);
      const previous = layer.mode;
      layer.mode = mode;
      return () => { layer.mode = previous; };
    },
    register: (definition) => registry.registerFrom(ctx, definition),
    restrict: (options) => registry.restrictFrom(ctx, options),
  };
  return { id, ctx };
}

function fakeHost({ agents = new Map(), tools } = {}) {
  return {
    agents: { get: (id) => agents.get(id) },
    tools,
    logger: { warn() {} },
    get(name) {
      if (name === "agents") return this.agents;
      if (name === "tools") return this.tools;
      return undefined;
    },
  };
}

// Production also builds a restart definition. It must NOT be mounted in the
// chat scope, whose isolation contract is exactly these three tools.
const definitions = [...GAME_TOOLS, "nethack_restart"].map((name) => ({ name }));

test("attaching registers the game tools into that agent's scope only", () => {
  const registry = fakeRegistry();
  const game = fakeAgent("game-session", registry);
  const other = fakeAgent("user-session", registry);
  const host = fakeHost({ agents: new Map([[game.id, game]]), tools: registry });
  const sessions = new GameSession(host, { definitions });

  const result = sessions.attach(game.id, "game-1");
  assert.equal(result.session_id, "game-session");
  assert.deepEqual(result.tools.slice().sort(), [...GAME_TOOLS].sort());

  // The other conversation keeps exactly what it had: no game tools, and its
  // inherited tools still visible because nothing restricted it.
  const otherNames = registry.schemas(other).map((schema) => schema.name).sort();
  assert.deepEqual(otherNames, ["bash", "read"]);

  // The global view is untouched too, which is what "no other conversation can
  // see the game tools" means in practice.
  assert.deepEqual([...registry.global.keys()].sort(), ["bash", "read"]);
});

test("inherited PTC transport is replaced by native game tools only", () => {
  const registry = fakeRegistry();
  const game = fakeAgent("game-session", registry);
  registry.layerOf(game.ctx).mode = "ptc";
  const host = fakeHost({ agents: new Map([[game.id, game]]), tools: registry });
  const sessions = new GameSession(host, { definitions });
  assert.deepEqual(sessions.attach(game.id, "game-1").tools.sort(), [...GAME_TOOLS].sort());
  sessions.detach();
  assert.equal(registry.layerOf(game.ctx).mode, "ptc");
});

test("own-layer Team tools are hidden from model assembly and denied at execution", async () => {
  const registry = fakeRegistry();
  const game = fakeAgent("game-session", registry);
  const other = fakeAgent("user-session", registry);
  registry.registerFrom(game.ctx, { name: "spawn_teammate" });
  registry.registerFrom(other.ctx, { name: "spawn_teammate" });
  const host = fakeHost({ agents: new Map([[game.id, game]]), tools: registry });
  const sessions = new GameSession(host, { definitions });
  assert.deepEqual(sessions.attach(game.id, "game-1").tools.sort(), [...GAME_TOOLS].sort());
  const surface = { tools: registry.schemas(game), sections: [], contexts: [], variables: {} };
  const assembled = await game.ctx.listeners.get("system-prompt/assemble")(surface, {}, async () => surface);
  assert.deepEqual(assembled.tools.map(t => t.name).sort(), [...GAME_TOOLS].sort());
  assert.match(game.ctx.guards[0]({ name: "spawn_teammate" }), /only game tools/);
  assert.equal(game.ctx.guards[0]({ name: "nethack_act" }), undefined);
  assert.equal(other.ctx.guards.length, 0);
  assert.equal(other.ctx.listeners.size, 0);
  sessions.detach();
  assert.equal(game.ctx.guards.length, 0);
  assert.equal(game.ctx.listeners.size, 0);
  assert.ok(registry.schemas(game).some(tool => tool.name === "spawn_teammate"));
});

test("the game session is restricted to the game tools", () => {
  const registry = fakeRegistry();
  const game = fakeAgent("game-session", registry);
  const host = fakeHost({ agents: new Map([[game.id, game]]), tools: registry });
  const sessions = new GameSession(host, { definitions });
  sessions.attach(game.id, "game-1");

  const names = registry.schemas(game).map((schema) => schema.name).sort();
  assert.deepEqual(names, [...GAME_TOOLS].sort());
  assert.ok(!names.includes("read"), "the game session must not read the workspace");
  assert.ok(!names.includes("bash"), "the game session must not run commands");
});

test("attaching twice (a plugin reload) does not duplicate registrations", () => {
  const registry = fakeRegistry();
  const game = fakeAgent("game-session", registry);
  const host = fakeHost({ agents: new Map([[game.id, game]]), tools: registry });
  const first = new GameSession(host, { definitions });
  first.attach(game.id, "game-1");

  // Plugin unload disposes its own registrations; a new binder can reinstall.
  first.dispose();
  const second = new GameSession(host, { definitions });
  const result = second.attach(game.id, "game-1");
  assert.deepEqual(result.tools.slice().sort(), [...GAME_TOOLS].sort());
});

test("attaching an unknown session reports instead of throwing", () => {
  const registry = fakeRegistry();
  const host = fakeHost({ tools: registry });
  const sessions = new GameSession(host, { definitions });
  assert.deepEqual(sessions.attach("missing", "game-1"), {
    error: "session_not_live",
    session_id: "missing",
  });
  assert.deepEqual(sessions.tools(), []);
});

test("cancel only reaches the game's own session", () => {
  const registry = fakeRegistry();
  const game = fakeAgent("game-session", registry);
  const other = fakeAgent("user-session", registry);
  const cancelled = [];
  game.cancel = (options) => cancelled.push([game.id, options.kind]);
  other.cancel = (options) => cancelled.push([other.id, options.kind]);
  const host = fakeHost({ agents: new Map([[game.id, game], [other.id, other]]), tools: registry });
  const sessions = new GameSession(host, { definitions });
  sessions.attach(game.id, "game-1");

  assert.equal(sessions.cancel(other.id), false, "a cancel aimed elsewhere is refused");
  assert.equal(sessions.cancel(game.id), true);
  assert.deepEqual(cancelled, [[game.id, "user"]]);
});

test("restriction failure refuses attachment instead of exposing inherited tools", () => {
  const registry = fakeRegistry();
  const game = fakeAgent("game-session", registry);
  game.ctx.tools.restrict = () => { throw new Error("restriction failed"); };
  const host = fakeHost({ agents: new Map([[game.id, game]]), tools: registry });
  const sessions = new GameSession(host, { definitions });
  assert.equal(sessions.attach(game.id, "game-1").error, "tool_isolation_failed");
  assert.equal(sessions.sessionId, undefined);
  assert.deepEqual(registry.schemas(game).map(s => s.name).sort(), ["bash", "read"]);
});

test("detach removes only the game's registrations and restores inherited visibility", () => {
  const registry = fakeRegistry();
  const game = fakeAgent("game-session", registry);
  const host = fakeHost({ agents: new Map([[game.id, game]]), tools: registry });
  const sessions = new GameSession(host, { definitions });
  sessions.attach(game.id, "game-1");
  sessions.detach();
  assert.deepEqual(registry.schemas(game).map(s => s.name).sort(), ["bash", "read"]);
  assert.equal(sessions.installations.size, 0);
});

test("a session that is gone cancels nothing", () => {
  const registry = fakeRegistry();
  const game = fakeAgent("game-session", registry);
  const agents = new Map([[game.id, game]]);
  const host = fakeHost({ agents, tools: registry });
  const sessions = new GameSession(host, { definitions });
  sessions.attach(game.id, "game-1");
  agents.clear();
  assert.equal(sessions.cancel(game.id), false);
  assert.deepEqual(sessions.tools(), []);
});
