import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  .replace(/\n    return \{\n      inject: \[[^\]]*\],/, '\n    return {\n      __test: { GameChat, MapView },');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };

function harness({ gameId = 'game-1', ready = Promise.resolve(), failFetch = false } = {}) {
  const effects = [], states = [], calls = [];
  let releases = 0, definition;
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: value => [typeof value === 'function' ? value() : value, next => states.push(next)],
    useEffect: effect => effects.push(effect),
    useRef: value => ({ current: value }),
  };
  new Function('window', 'fetch', source)(
    { __ModuleLoader__: { load: value => { definition = value; } } },
    async (_url, options) => {
      if (!options) return { ok: true, json: async () => ({ session_id: null }) };
      calls.push(['attach', JSON.parse(options.body)]);
      if (failFetch) throw new Error('connection failed');
      return { ok: true, json: async () => ({ tools: ['nethack_observe', 'nethack_act', 'nethack_respond'] }) };
    },
  );
  const components = definition.factory(() => React).__test;
  const props = {
    gameId, t: key => key,
    sessions: {
      async create(options) { calls.push(['create', options]); return 'fresh-session'; },
      retain(id, options) { calls.push(['retain', id, options.source]); return { ready, release() { releases++; } }; },
    },
    archiveSession() { throw new Error('must never archive'); },
  };
  components.GameChat(props);
  const cleanup = effects.shift()?.();
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const remount = (nextGameId = gameId) => {
    components.GameChat({ ...props, gameId: nextGameId });
    return effects.shift()?.();
  };
  return { calls, states, flush, cleanup, remount, releases: () => releases, components };
}

test('creates a fresh preset session, waits for history, then attaches', async () => {
  const opening = deferred();
  const h = harness({ ready: opening.promise });
  await h.flush();
  assert.deepEqual(h.calls[0], ['create', { agentPreset: 'nethack' }]);
  assert.equal(h.calls.some(([kind]) => kind === 'attach'), false);
  opening.resolve();
  await h.flush();
  assert.equal(h.states.at(-1).phase, 'ready');
  assert.deepEqual(h.calls.at(-1), ['attach', { session_id: 'fresh-session', game_id: 'game-1' }]);
  h.cleanup();
  assert.equal(h.releases(), 1);
});

test('does not create a session before the engine identity arrives', async () => {
  const h = harness({ gameId: undefined });
  await h.flush();
  // Destructuring defaults gameId; explicitly test the loading value instead.
  h.cleanup?.();
  const loading = harness({ gameId: '' });
  await loading.flush();
  assert.deepEqual(loading.calls, []);
});

test('failed attach releases its retained reference exactly once', async () => {
  const h = harness({ failFetch: true });
  await h.flush();
  assert.equal(h.states.at(-1).phase, 'error');
  assert.match(h.states.at(-1).error, /connection failed/);
  assert.equal(h.releases(), 1);
  h.cleanup();
  assert.equal(h.releases(), 1);
});

test('unmount while history opens prevents a late attach', async () => {
  const opening = deferred();
  const h = harness({ ready: opening.promise });
  await h.flush();
  h.cleanup();
  opening.resolve();
  await h.flush();
  assert.equal(h.calls.some(([kind]) => kind === 'attach'), false);
  assert.equal(h.releases(), 1);
});

test('leaving and returning reopens the same session without losing its transcript identity', async () => {
  const h = harness();
  await h.flush();
  const firstId = h.states.at(-1).sessionId;
  h.cleanup();
  const cleanupAgain = h.remount();
  await h.flush();
  assert.equal(h.states.at(-1).sessionId, firstId);
  assert.equal(h.calls.filter(([kind]) => kind === 'create').length, 1);
  assert.equal(h.calls.filter(([kind]) => kind === 'retain').length, 2);
  cleanupAgain();
  assert.equal(h.releases(), 2);
});

test('remount while creation is pending shares the same creation promise', async () => {
  const h = harness();
  h.cleanup();
  const cleanupAgain = h.remount();
  await h.flush();
  assert.equal(h.calls.filter(([kind]) => kind === 'create').length, 1);
  assert.equal(h.states.at(-1).phase, 'ready');
  cleanupAgain();
});

test('new game identity creates a new conversation', async () => {
  const h = harness();
  await h.flush();
  h.cleanup();
  const cleanupAgain = h.remount('game-2');
  await h.flush();
  assert.equal(h.calls.filter(([kind]) => kind === 'create').length, 2);
  cleanupAgain();
});

test('map component renders engine tile glyphs', () => {
  const h = harness({ gameId: '' });
  const tree = h.components.MapView({ t: key => key, map: [{ x: 2, y: 3, text: '@' }] });
  assert.match(JSON.stringify(tree), /@/);
  assert.doesNotMatch(JSON.stringify(tree), /emptyMap/);
});
