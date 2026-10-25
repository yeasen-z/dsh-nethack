import fs from 'node:fs';
import assert from 'node:assert/strict';

// Execute the actual panel and its effects, with both sets of real slot props.
// No worker or live game is touched. Timers and HTTP are deterministic doubles.
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  .replace(/\n    return \{\n      inject: \[[^\]]*\],/,
    '\n    return {\n      __test: { NetHackPanel },');
let passed = 0;
async function scenario({ selected = 'conversation', tab, hidden = false, fail = false }) {
  let definition, cursor = 0, requests = 0;
  const cells = [], effects = [], timers = new Map();
  const listeners = new Map();
  let timerId = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children: children.flat(Infinity) }),
    useState(init) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = typeof init === 'function' ? init() : init;
      return [cells[i], value => { cells[i] = typeof value === 'function' ? value(cells[i]) : value; }];
    },
    useRef(value) { const i = cursor++; return cells[i] ??= { current: value }; },
    useCallback(fn, deps) {
      const i = cursor++;
      if (!same(cells[i]?.deps, deps)) cells[i] = { value: fn, deps };
      return cells[i].value;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!same(cells[i]?.deps, deps)) effects.push(() => {
        cells[i]?.cleanup?.();
        cells[i] = { deps, cleanup: fn() };
      });
    },
  };
  const document = {
    visibilityState: hidden ? 'hidden' : 'visible',
    addEventListener: (event, fn) => listeners.set(event, fn),
    removeEventListener: event => listeners.delete(event),
  };
  const state = { game_id: 'test', waiting_for: 'command', status: {}, tiles: [], messages: [], inventory: [], conditions: [] };
  new Function('window', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'ResizeObserver', source)(
    { __ModuleLoader__: { load: module => { definition = module; } } }, document,
    async url => { assert.equal(url, '/api/dsh-nethack.state'); requests++; return {
      ok: !fail, status: fail ? 503 : 200, json: async () => state,
    }; },
    fn => { const id = ++timerId; timers.set(id, fn); return id; },
    id => timers.delete(id), undefined,
  );
  const { NetHackPanel } = definition.factory(name => {
    assert.equal(name, 'react'); return React;
  }).__test;
  // The panel is a `session` child slot now, so it is handed the session scope
  // provider; this scenario never reaches the conversation, so a plain double
  // keeps the polling behaviour under test isolated from chat wiring.
  const SessionProvider = props => props.children;
  const props = { t: key => key, SessionProvider, usePanelInfo: selector => selector({ activePanelId: selected }) };
  if (tab !== undefined) props.useTabInfo = () => ({ tab: { visible: tab } });
  // Only the panel body is invoked here, not the view components it returns:
  // those use hooks of their own, and driving them outside a real render pass
  // would corrupt this runner's cell cursor. What this test asserts is POLLING
  // (how many state requests a given visibility produces), not the map markup.
  const render = () => { cursor = 0; return NetHackPanel(props); };
  const flush = async () => { effects.splice(0).forEach(fn => fn()); for (let i = 0; i < 6; i++) await Promise.resolve(); };
  render(); await flush();
  const result = {
    requests: () => requests,
    tree: () => JSON.stringify(render()),
    async reveal() { tab = true; render(); await flush(); },
    async foreground() { document.visibilityState = 'visible'; listeners.get('visibilitychange')?.(); await flush(); },
    cleanup() { cells.forEach(cell => cell?.cleanup?.()); timers.clear(); },
  };
  return result;
}
async function check(label, options, test) {
  const s = await scenario(options);
  try { await test(s); console.log('PASS', label); passed++; } finally { s.cleanup(); }
}
await check('visible right tab fetches while centre shows conversation', { tab: true }, s => {
  assert.equal(s.requests(), 1); assert.ok(s.tree().includes('nhc-canvas'));
});
await check('hidden right tab does not poll', { tab: false }, s => assert.equal(s.requests(), 0));
await check('revealing right tab fetches immediately', { tab: false }, async s => {
  await s.reveal(); assert.equal(s.requests(), 1);
});
await check('hidden right tab ignores browser foreground event', { tab: false }, async s => {
  await s.foreground(); assert.equal(s.requests(), 0);
});
await check('central panel fallback still fetches', { selected: 'nethack' }, s => assert.equal(s.requests(), 1));
await check('unselected central panel does not poll', {}, s => assert.equal(s.requests(), 0));
await check('background browser skips visible tab', { tab: true, hidden: true }, s => assert.equal(s.requests(), 0));
await check('HTTP error replaces startup notice', { tab: true, fail: true }, s => assert.ok(s.tree().includes('HTTP 503')));
console.log(`${passed} passed, 0 failed`);
