// Execute the client half's real `apply()` against a recording Cordis context.
//
// This is the test whose absence cost the most: the module parsed, the live
// Host showed the slots registered, and every unit test passed -- but a seat
// referenced an identifier that no longer existed, so `apply()` threw at
// REGISTRATION time and its try/catch turned that into a console.warn. The
// panel then mounted with no body at all. Nothing short of running `apply()`
// catches that, so this file runs it.
import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let passed = 0;
const check = (label, fn) => { fn(); console.log('PASS', label); passed++; };

function run() {
  const registered = [];
  const React = {
    createElement: (t, p, ...c) => ({ type: t, props: p, children: c }),
    useState: v => [typeof v === 'function' ? v() : v, () => {}],
    useRef: v => ({ current: v }),
    useCallback: f => f, useEffect: () => {}, useMemo: f => f(), Fragment: 'Fragment',
  };
  const document = {
    querySelector: () => ({}), createElement: () => ({ dataset: {}, style: {} }),
    head: { appendChild() {} }, addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible', hidden: false,
  };
  let module;
  new Function('window', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'ResizeObserver', source)(
    { __ModuleLoader__: { load: m => { module = m; } } }, document,
    async () => ({ ok: true, status: 200, json: async () => ({}) }), () => 0, () => {}, undefined,
  );
  const ctx = {
    get: key => ctx[key],
    sidebarRightTabs: { register: d => { registered.push({ slot: 'sidebarRightTabs.register', id: d.id }); return () => {}; } },
    effect: fn => { fn(); return () => {}; },
    slots: {
      inject: (_key, cb) => { cb(); return () => {}; },
      register: (opts, component) => { registered.push({ slot: opts.name, id: opts.id, key: opts.key, component }); },
      entriesOfSlot: () => [], subscribe: () => () => {},
    },
    locale: { register: () => () => {}, bind: () => k => k, subscribe: () => () => {} },
    inject: (_deps, cb) => cb(ctx),
  };
  const definition = module.factory(name => {
    assert.equal(name, 'react');
    return React;
  });
  assert.equal(typeof definition?.apply, 'function', 'factory result has no apply()');
  definition.apply(ctx);
  return registered;
}

let registered;
check('apply() completes without throwing', () => { registered = run(); });

check('the left-column entry is registered under the id main dispatches', () => {
  const entry = registered.find(r => r.slot === 'sidebar.panellist');
  assert.ok(entry, 'no sidebar.panellist registration: the panel is unreachable');
  assert.equal(entry.id, 'nethack');
  assert.equal(typeof entry.component, 'function', 'icon component is not a function');
  const main = registered.find(r => r.slot === 'main');
  assert.ok(main, 'no main registration');
  assert.equal(main.key, 'nethack', 'sidebar id and main key must match or the click dispatches nowhere');
});

check('both panel slots exist with their components', () => {
  const body = registered.find(r => r.slot === 'nethack.panel.body');
  const conv = registered.find(r => r.slot === 'nethack.panel.conversation');
  assert.ok(body && conv, 'panel slots are missing');
  for (const seat of [body, conv]) {
    assert.equal(typeof seat.component, 'function', `${seat.slot} occupant is not a component`);
  }
});

check('the right-column tab declares both a type and a body', () => {
  const type = registered.find(r => r.slot === 'sidebarRightTabs.register');
  const body = registered.find(r => r.slot === 'sidebar.right.pane.tab');
  assert.ok(type && body, 'tab type or body missing');
  assert.equal(type.id, body.key, 'tab type id and body key must match');
});

check('every SLOT registration carries a callable component', () => {
  // `sidebarRightTabs.register` is a service call describing a tab TYPE, not a
  // slot registration, so it legitimately has no component.
  const seats = registered.filter(r => r.slot !== 'sidebarRightTabs.register');
  assert.ok(seats.length >= 5, `expected at least 5 slot registrations, got ${seats.length}`);
  for (const r of seats) {
    assert.equal(typeof r.component, 'function', `${r.slot} got a non-component`);
  }
});

for (const slot of ['main', 'sidebar.right.pane.tab']) {
  check(`${slot} renders its panel child instead of returning null`, () => {
    const entry = registered.find(r => r.slot === slot);
    const calls = [];
    const panel = { type: 'panel-outlet' };
    const useTabInfo = () => ({ tab: { visible: true } });
    const output = entry.component({
      ...(slot === 'sidebar.right.pane.tab' ? { useTabInfo } : {}),
      renderSlot(name, owner) {
        calls.push({ name, owner });
        return panel;
      },
    });
    assert.equal(output, panel, 'entry discarded its panel outlet');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'nethack.panel.body');
    if (slot === 'sidebar.right.pane.tab') {
      assert.equal(calls[0].owner.useTabInfo, useTabInfo, 'tab visibility hook was lost');
    }
  });
}

console.log(`${passed} passed, 0 failed`);
