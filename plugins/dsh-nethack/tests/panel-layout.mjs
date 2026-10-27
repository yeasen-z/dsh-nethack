// The panel assembled from a real state payload.
//
// The unit tests around this one drive single components with hand-built props;
// this one renders the WHOLE panel against a state shaped like the Host's state
// route, with a React double that actually calls function components and runs
// hooks. It exists because a redesign can leave a component wired to a prop that
// nobody passes (or to one that no longer exists) and every per-component test
// still passes while the panel renders blank or throws on the first poll.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  .replace(/\n    return \{\n      inject: \[[^\]]*\],/, '\n    return {\n      __test: { NetHackPanel },');
const GLYPH_CLASS_SOURCE = /const GLYPH_CLASS = \{([\s\S]*?)\};/.exec(source)[1];

/** A React stand-in that renders components and keeps hook state between passes. */
function makeReact() {
  const cells = [];
  let cursor = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const React = {
    createElement(type, props, ...children) {
      const kids = children.flat(Infinity).filter(Boolean);
      if (typeof type === 'function') return type(props ?? {}, ...kids);
      return { type, props: props ?? {}, children: kids };
    },
    useState(init) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = typeof init === 'function' ? init() : init;
      return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value; }];
    },
    useRef(value) { const index = cursor++; return cells[index] ??= { current: value }; },
    useCallback(fn, deps) {
      const index = cursor++;
      if (!cells[index] || !same(cells[index].deps, deps)) cells[index] = { fn, deps };
      return cells[index].fn;
    },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!cells[index] || !same(cells[index].deps, deps)) { cells[index] = { deps }; fn(); }
    },
    Fragment: 'Fragment',
  };
  return { React, reset: () => { cursor = 0; } };
}

/** The tiles and status of a real early game, trimmed to a small map. */
function gameState(overrides = {}) {
  const tiles = [];
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 40; x++) {
      const text = x === 0 || x === 39 || y === 0 || y === 11 ? '|'
        : (x === 5 && y === 5 ? '@'
          : (x === 6 && y === 5 ? 'd'
            : (x === 10 && y === 5 ? '#'
              : (x === 20 && y === 6 ? '░'
                : (x === 22 && y === 6 ? '+' : '.')))));
      tiles.push({ x, y, text });
    }
  }
  return {
    game_id: 'game-1', waiting_for: 'command', alive: true, ended: false, turn: 1284,
    status: {
      BL_HP: '14', BL_HPMAX: '27', BL_PW: '3', BL_PWMAX: '5', BL_AC: '6', BL_GOLD: '47',
      BL_STR: '18/03', BL_TITLE: 'Agnes the Valkyrie', BL_LEVEL: '3', BL_LEVELDESC: 'Dlvl:2',
    },
    conditions: ['hunger'],
    player: { x: 5, y: 5 },
    tiles,
    messages: ['You hear noises.', 'You see here a food ration.', 'The jackal bites!'],
    inventory: [
      { header: 'Weapons' },
      { letter: 'a', text: 'a +1 long sword (weapon in hand)' },
      { letter: 'b', text: 'a +0 dagger' },
    ],
    prompt: null,
    ...overrides,
  };
}

/** Render the panel twice: first paint (fetch in flight), then with the state. */
async function renderPanel(state) {
  const runner = makeReact();
  let definition;
  const document = {
    visibilityState: 'visible', addEventListener() {}, removeEventListener() {},
    querySelector: () => null, createElement: () => ({ dataset: {}, style: {} }),
    head: { appendChild() {} },
  };
  new Function('window', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'ResizeObserver', source)(
    { __ModuleLoader__: { load: value => { definition = value; } } }, document,
    async () => ({ ok: true, status: 200, json: async () => state }),
    () => 0, () => {}, undefined,
  );
  const { NetHackPanel } = definition.factory(() => runner.React).__test;
  const props = {
    t: key => `<${key}>`,
    subscribeLocale: () => {},
    sessions: undefined,
    SessionProvider: p => p.children,
    renderSlot: () => null,
    renderFactorySlot: () => null,
    placement: 'main',
  };
  runner.reset();
  NetHackPanel(props);
  // The poll effect kicked off load(); let its promise chain settle before the
  // second pass, which is the one that renders real state.
  await new Promise(resolve => setTimeout(resolve, 0));
  runner.reset();
  return NetHackPanel(props);
}

/** Every element and every text node, flattened. */
function walk(tree) {
  const elements = [];
  const texts = [];
  (function visit(node) {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node === 'string') { texts.push(node); return; }
    if (!node || typeof node !== 'object') return;
    elements.push(node);
    node.children.forEach(visit);
  })(tree);
  return { elements, texts };
}

test('the panel renders the HUD, stage, console and side tabs from a live state', async () => {
  const tree = await renderPanel(gameState());
  const { elements, texts } = walk(tree);
  const classes = elements.map(node => node.props?.className ?? '').join(' ');
  for (const part of ['nhc-root', 'nhc-body', 'nhc-hud', 'nhc-play', 'nhc-stage', 'nhc-console', 'nhc-side', 'nhc-tabs']) {
    assert.ok(classes.includes(part), `missing ${part}`);
  }
  // The HUD shows the person's numbers, not the raw field names.
  const all = texts.join(' ');
  for (const value of ['Agnes the Valkyrie', '14/27', '3/5', '47', '1284', 'Dlvl:2', 'hunger']) {
    assert.ok(all.includes(value), `HUD missing ${value}`);
  }
  // The game id reached GameChat, so the conversation is bound to THIS game.
  assert.ok(all.includes('<chatStarting>') || classes.includes('nhc-chat'), 'conversation seat did not render');
});

test('the map classes the hero, its pet, the corridor, the door and the blind cell apart', async () => {
  const tree = await renderPanel(gameState());
  const { elements } = walk(tree);
  const glyphs = elements
    .filter(node => typeof node.props?.className === 'string' && node.props.className.startsWith('nhc-g '))
    .map(node => ({ kind: node.props.className.slice('nhc-g '.length), glyph: node.children[0] }));
  const kindOf = glyph => glyphs.filter(entry => entry.glyph === glyph).map(entry => entry.kind);
  assert.deepEqual(kindOf('@'), ['hero']);
  // The `d` next to the `@` is the pet; a `d` anywhere else would be a monster.
  assert.deepEqual(kindOf('d'), ['pet']);
  assert.deepEqual(kindOf('#'), ['corridor']);
  assert.deepEqual(kindOf('+'), ['door'], 'a closed door must not be coloured as a spellbook');
  assert.deepEqual(kindOf('░'), ['blind'], 'an undrawn cell must not read as an object');
});

test('a game that has ended keeps the frame and offers a new game', async () => {
  const tree = await renderPanel(gameState({ ended: true, alive: false, waiting_for: 'ended' }));
  const { elements, texts } = walk(tree);
  const classes = elements.map(node => node.props?.className ?? '').join(' ');
  assert.ok(classes.includes('nhc-body'));
  assert.ok(texts.join(' ').includes('<gameOver>'));
  // The HUD's restart button stays reachable; the console is locked instead of
  // becoming a second, dead way to play.
  assert.ok(elements.some(node => node.type === 'button' && node.props['aria-label'] === '<restart>'));
});

test('a pending question is raised over the map with its own answer keys', async () => {
  const tree = await renderPanel(gameState({
    waiting_for: 'yn', prompt: { kind: 'yn', question: 'Really attack the shopkeeper?' },
  }));
  const { elements, texts } = walk(tree);
  const classes = elements.map(node => node.props?.className ?? '').join(' ');
  assert.ok(classes.includes('nhc-ask'), 'the question card did not render');
  assert.ok(texts.join(' ').includes('Really attack the shopkeeper?'));
  const options = elements.filter(node => typeof node.props?.className === 'string' && node.props.className.includes('nhc-opt'));
  assert.ok(options.length >= 2, 'yes/no shortcuts missing');
});

test('the glyph table covers the symbols the engine draws', () => {
  const table = new Function(`return {${GLYPH_CLASS_SOURCE}};`)();
  for (const [glyph, kind] of [
    ['@', 'hero'], ['░', 'blind'], ['#', 'corridor'], ['+', 'door'], ['^', 'trap'],
    ['>', 'stairs'], ['%', 'food'], ['!', 'potion'], ['?', 'scroll'], [')', 'weapon'], ['[', 'armor'],
  ]) {
    assert.equal(table[glyph], kind, `${glyph} should be ${kind}`);
  }
  // A lowercase letter is never in the table: monsters are decided by the
  // monster test, so a monster can never be coloured as a text glyph.
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') assert.equal(table[letter], undefined);
});
