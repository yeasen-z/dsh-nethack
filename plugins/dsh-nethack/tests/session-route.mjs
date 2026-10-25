// Run: node --test plugins/dsh-nethack/tests/session-route.mjs
// The `/api/dsh-nethack.session` contract, driven through the real route table
// with a fake connection and a fake tool registry. This is what the panel posts
// to, so its accept/reject behaviour is asserted rather than assumed.
import assert from "node:assert/strict";
import test from "node:test";

import { registerRoutes } from "../lib/index.mjs";
import { GameSession, GAME_TOOLS } from "../lib/session.mjs";

const SESSION_ROUTE = "/api/dsh-nethack.session";

function fakeRegistry() {
  const scopes = new WeakMap();
  const layerOf = (ctx) => {
    let layer = scopes.get(ctx);
    if (layer === undefined) scopes.set(ctx, layer = { own: new Map(), allow: undefined });
    return layer;
  };
  return {
    registerFrom(ctx, definition) { layerOf(ctx).own.set(definition.name, definition); },
    restrictFrom(ctx, { allow }) { layerOf(ctx).allow = new Set(allow); },
    schemas(scope) {
      const own = scope?.ctx === undefined ? undefined : scopes.get(scope.ctx);
      return own === undefined ? [] : [...own.own.values()];
    },
  };
}

function harness() {
  const routes = new Map();
  const registry = fakeRegistry();
  const agent = {
    id: "game-session",
    cancel(options) { this.cancelled = options; },
    ctx: {
      on: () => () => {},
      tools: {
        guard: () => () => {},
        presentAs: () => () => {},
        register: (definition) => registry.registerFrom(agent.ctx, definition),
        restrict: (options) => registry.restrictFrom(agent.ctx, options),
      },
    },
  };
  const agents = new Map([[agent.id, agent]]);
  const host = {
    agents: { get: (id) => agents.get(id) },
    tools: registry,
    logger: { warn() {} },
    connection: {
      fetch: {
        register(route) {
          assert.ok(!routes.has(route.path), `duplicate route ${route.path}`);
          routes.set(route.path, route);
        },
      },
    },
    get(name) {
      if (name === "agents") return this.agents;
      if (name === "tools") return this.tools;
      return undefined;
    },
  };
  const sessions = new GameSession(host, { definitions: GAME_TOOLS.map((name) => ({ name })) });
  registerRoutes(host, GAME_TOOLS.map((name) => ({ name })), sessions);

  const post = (body) => routes.get(SESSION_ROUTE).fetch(new Request(`http://host${SESSION_ROUTE}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
  return { agent, agents, routes, post, sessions };
}

test("the session route is registered and accepts POST", () => {
  const { routes } = harness();
  const route = routes.get(SESSION_ROUTE);
  assert.ok(route, "the panel has nothing to post to without this route");
  assert.deepEqual(route.methods, ["GET", "POST"]);
});

test("attaching returns the tools the session actually sees", async () => {
  const { post } = harness();
  const response = await post({ session_id: "game-session", game_id: "game-1" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.session_id, "game-session");
  assert.equal(body.game_id, "game-1");
  assert.deepEqual(body.tools.slice().sort(), [...GAME_TOOLS].sort());
});

test("same game can recover its session identity after panel or plugin remount", async () => {
  const { post } = harness();
  await post({ session_id: "game-session", game_id: "resume-game" });
  // New route/binder simulates a plugin reload; the process-owned binding stays.
  const fresh = harness();
  const get = gameId => fresh.routes.get(SESSION_ROUTE).fetch(new Request(`http://host${SESSION_ROUTE}?game_id=${gameId}`));
  assert.deepEqual(await (await get("resume-game")).json(), { session_id: "game-session" });
  assert.deepEqual(await (await get("different-game")).json(), { session_id: null });
});

test("a malformed or incomplete request is refused, not guessed at", async () => {
  const { post } = harness();
  assert.equal((await post("not json")).status, 400);
  assert.deepEqual(await (await post("not json")).json().catch(() => ({ error: "invalid_json" })), { error: "invalid_json" });
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ session_id: "   " })).status, 400);
});

test("attaching a session the Host does not know is a 409, not a silent success", async () => {
  const { post } = harness();
  const response = await post({ session_id: "nope", game_id: "game-1" });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "session_not_live");
});

test("cancel stops only the attached session", async () => {
  const { post, agent } = harness();
  await post({ session_id: "game-session", game_id: "game-1" });

  const refused = await post({ type: "cancel", session_id: "another-session" });
  assert.deepEqual(await refused.json(), { cancelled: false });
  assert.equal(agent.cancelled, undefined, "another session must never be interrupted");

  const accepted = await post({ type: "cancel", session_id: "game-session" });
  assert.deepEqual(await accepted.json(), { cancelled: true });
  assert.deepEqual(agent.cancelled, { kind: "user" });
});

test("detach forgets the session without stopping it", async () => {
  const { post, sessions, agent } = harness();
  await post({ session_id: "game-session", game_id: "game-1" });
  assert.equal(sessions.sessionId, "game-session");
  await post({ type: "detach", session_id: "game-session" });
  assert.equal(sessions.sessionId, undefined);
  assert.equal(agent.cancelled, undefined);
});
