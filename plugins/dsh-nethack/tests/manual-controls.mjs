// The console is the only manual control surface, so these tests pin what a
// hand-play turn needs: the pad is on screen without a toggle, keys are sent as
// commands at the command prompt and as answers at any prompt, keyboard capture
// never steals keys from a field or a shortcut, and the question card offers the
// engine's own menu rows as buttons instead of asking the person to know them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  .replace(/\n    return \{\n      inject: \[[^\]]*\],/,
    '\n    return {\n      __test: { GameControls, AskBar },');
function load() {
  let definition;
  // useState keeps its cell so a controlled input can be typed into and then
  // submitted exactly as the component renders it.
  const cells = [];
  let cursor = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
    useState(init) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = typeof init === 'function' ? init() : init;
      return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value; }];
    },
    useRef(value) { const index = cursor++; return cells[index] ??= { current: value }; },
    useCallback(fn) { return fn; },
    useEffect() {},
    Fragment: 'Fragment',
  };
  new Function('window', source)({ __ModuleLoader__: { load: value => { definition = value; } } });
  return {
    reset() { cursor = 0; },
    api: definition.factory(() => React).__test,
  };
}
/** Walk the element tree, collecting every element node. */
function nodes(tree) {
  const found = [];
  const walk = node => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    found.push(node);
    node.children.forEach(walk);
  };
  walk(tree);
  return found;
}
/** Flatten text of a subtree, so a button is found by anything it shows. */
const text = node => (typeof node === 'string' ? node
  : Array.isArray(node) ? node.map(text).join('')
  : node && typeof node === 'object' ? node.children.map(text).join('') : '');

const runner = load();
const { GameControls, AskBar } = runner.api;

function render({ waiting = 'command', ended = false, busy = false } = {}) {
  runner.reset();
  // `runner.reset` rewinds the hook cursor; a second call re-renders with the
  // state the previous render's handlers wrote, the way React does after a
  // setState.`

  const calls = [];
  const tree = GameControls({
    t: key => key,
    state: { waiting_for: waiting, ended },
    busy,
    send: async body => calls.push(body),
  });
  const all = nodes(tree);
  const button = label => all.find(node => node.type === 'button' && text(node).includes(label));
  const group = all.find(node => node.props.className === 'nhc-console');
  // Re-render with the state the last handlers wrote (what React does after a
  // setState), so a controlled field can be typed into and then submitted.
  const rerender = () => {
    runner.reset();
    const next = GameControls({ t: key => key, state: { waiting_for: waiting, ended }, busy, send: async body => calls.push(body) });
    return nodes(next);
  };
  return { calls, button, group, all, tree, rerender };
}

test('the pad and the verbs are always visible, with no manual to expand', () => {
  const ui = render();
  assert.ok(ui.button('↖'));
  assert.ok(ui.button('↑'));
  // The manual used to be a bordered box under a side column; it is now the
  // console strip and must never need expanding to reach a key.
  assert.equal(ui.button('keys'), undefined);
  assert.ok(ui.button('actPickup'));
  assert.ok(ui.group, 'the console strip renders');
});

test('direction pad sends one numpad key at the command prompt', () => {
  const ui = render();
  ui.button('↑').props.onClick();
  assert.deepEqual(ui.calls, [{ action: 'raw_keys', keys: '8' }]);
});

test('direction pad answers a direction prompt instead of issuing a command', () => {
  const ui = render({ waiting: 'direction' });
  ui.button('↑').props.onClick();
  assert.deepEqual(ui.calls, [{ kind: 'respond', reply: '8' }]);
  // The verbs are commands, so they are refused while a question is pending;
  // the pad, the space/enter/escape keys and the field still answer.
  assert.equal(ui.button('actPickup').props.disabled, true);
  assert.equal(ui.button('␣').props.disabled, false);
});

test('a finished game disables the whole console', () => {
  const ui = render({ ended: true });
  assert.equal(ui.button('↑').props.disabled, true);
  assert.equal(ui.button('␣').props.disabled, true);
});

test('every action button names the engine key it sends', () => {
  const ui = render();
  for (const [label, glyph] of [['actPickup', ','], ['actSearch', 's'], ['actOpen', 'o'], ['actDescend', '>'], ['actAscend', '<']]) {
    const node = ui.button(label);
    assert.ok(node, `${label} missing`);
    assert.ok(text(node).includes(glyph), `${label} does not name its key ${glyph}`);
  }
});

test('local keyboard control ignores editable fields and modifier shortcuts', () => {
  const ui = render();
  const key = (target, extra = {}) => ui.group.props.onKeyDown({ key: 'ArrowUp', target, preventDefault() {}, ...extra });
  key({ tagName: 'INPUT' });
  key({ tagName: 'TEXTAREA' });
  key({ tagName: 'BUTTON' });
  key({ tagName: 'DIV' }, { metaKey: true });
  assert.deepEqual(ui.calls, []);
  key({ tagName: 'DIV' });
  assert.deepEqual(ui.calls, [{ action: 'raw_keys', keys: '8' }]);
});

test('the key field sends what was typed, as a command or as an answer', () => {
  const ui = render();
  ui.all.find(node => node.type === 'input').props.onChange({ target: { value: 'w' } });
  ui.rerender().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(ui.calls, [{ action: 'raw_keys', keys: 'w' }]);

  // At a question the same field answers instead of commanding, which is how a
  // free-form reply ("yes", a name, a menu letter) reaches the engine.
  const answering = render({ waiting: 'line' });
  answering.all.find(node => node.type === 'input').props.onChange({ target: { value: 'x' } });
  answering.rerender().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(answering.calls, [{ kind: 'respond', reply: 'x' }]);
});

/** Build an AskBar tree for one prompt shape. */
function ask(question) {
  runner.reset();
  const calls = [];
  // AskBar destructures its props (a real slot component does too), so the
  // prompt is passed as `question` on the props object.
  const tree = AskBar({
    t: key => key, question, reply: '', setReply() {}, busy: false,
    onAnswer: answer => calls.push(answer),
  });
  assert.ok(tree, 'AskBar returned nothing');
  return { calls, all: nodes(tree) };
}

test('a menu question offers its own accelerators as buttons', () => {
  const { calls, all } = ask({
    waiting_for: 'menu',
    prompt: { kind: 'menu', title: 'What do you want to eat?', items: [
      { identifier: 0, text: 'Food' },
      { accelerator: 100, text: 'ration' },
      { accelerator: 102, text: 'apple' },
    ] },
  });
  const options = all.filter(node => node.type === 'button' && node.props.className?.includes('nhc-opt'));
  assert.equal(options.length, 2, 'headers are not offered; one button per selectable row');
  assert.ok(text(options[0]).includes('d') && text(options[0]).includes('ration'));
  options[1].props.onClick();
  assert.deepEqual(calls, ['f'], 'the button answers with the accelerator, not with the label');
  assert.equal(all.filter(node => node.type === 'input').length, 0, 'menu answers are not typed');
});

test('yes/no and line prompts get a field, plus y/n shortcuts', () => {
  const { all } = ask({ waiting_for: 'yn', prompt: { kind: 'yn', question: 'Really attack?' } });
  assert.ok(all.some(node => node.type === 'input'), 'a yes/no answer is typed');
  const labels = all.filter(node => node.type === 'button').map(text);
  assert.ok(labels.some(label => label.includes('y')));
  assert.ok(labels.some(label => label.includes('n')));

  const line = ask({ waiting_for: 'line', prompt: { kind: 'line', question: 'What do you want to name it?' } });
  assert.ok(line.all.some(node => node.type === 'input'));
});

test('a --More-- page becomes a single continue button', () => {
  const { calls, all } = ask({ waiting_for: 'more', prompt: { kind: 'more' } });
  const buttons = all.filter(node => node.type === 'button');
  assert.equal(buttons.length, 1);
  assert.ok(text(buttons[0]).includes('continueAction'));
  buttons[0].props.onClick();
  assert.deepEqual(calls, [' ']);
});
