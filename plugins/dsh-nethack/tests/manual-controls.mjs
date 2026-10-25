import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  .replace(/\n    return \{\n      inject: \[[^\]]*\],/, '\n    return {\n      __test: { GameControls },');
function render({ waiting = 'command', expanded = false, confirming = false, busy = false } = {}) {
  let definition, slot = 0;
  const updates = [], calls = [];
  const values = [expanded, confirming, ''];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
    useState: () => { const index = slot++; return [values[index], value => updates.push([index, value])]; },
  };
  new Function('window', source)({ __ModuleLoader__: { load: value => { definition = value; } } });
  const { GameControls } = definition.factory(() => React).__test;
  const tree = GameControls({ t: key => key, state: { waiting_for: waiting }, busy, send: async body => calls.push(body) });
  const nodes = [];
  const walk = node => { if (!node || typeof node !== 'object') return; nodes.push(node); node.children.forEach(walk); };
  walk(tree);
  const button = label => nodes.find(node => node.type === 'button' && node.children.includes(label));
  return { nodes, calls, updates, button };
}

test('lower-left buttons are present and restart requires explicit confirmation', async () => {
  const ui = render();
  assert.ok(ui.button('restart'));
  assert.ok(ui.button('keys'));
  ui.button('restart').props.onClick();
  assert.deepEqual(ui.calls, []);
  assert.equal(ui.updates[0][0], 1);
  const confirm = render({ confirming: true });
  await confirm.button('confirmRestart').props.onClick();
  assert.deepEqual(confirm.calls, [{ action: 'restart' }]);
});

test('direction pad sends one numpad key at command prompt', () => {
  const ui = render({ expanded: true });
  ui.button('↑').props.onClick();
  assert.deepEqual(ui.calls, [{ action: 'raw_keys', keys: '8' }]);
});

test('direction pad answers prompts rather than issuing a command', () => {
  const ui = render({ expanded: true, waiting: 'direction' });
  ui.button('↑').props.onClick();
  assert.deepEqual(ui.calls, [{ kind: 'respond', reply: '8' }]);
  assert.equal(ui.button('searchAction').props.disabled, true);
});

test('local keyboard control ignores editable fields and modifier shortcuts', () => {
  const ui = render({ expanded: true });
  const group = ui.nodes.find(node => node.props.className === 'nhc-manual');
  const key = (target, extra = {}) => group.props.onKeyDown({ key: 'ArrowUp', target, preventDefault() {}, ...extra });
  key({ tagName: 'INPUT' });
  key({ tagName: 'TEXTAREA' });
  key({ tagName: 'DIV' }, { metaKey: true });
  assert.deepEqual(ui.calls, []);
  key({ tagName: 'DIV' });
  assert.deepEqual(ui.calls, [{ action: 'raw_keys', keys: '8' }]);
});
