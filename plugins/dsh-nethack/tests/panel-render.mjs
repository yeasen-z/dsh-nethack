// Render the panel through the slot contract it actually gets at runtime.
//
// The blank-panel bug this file exists for was invisible to every other test:
// the module parsed, the seats registered, and `main`/`sidebar.panellist` both
// showed up in the live Host -- but the conversation never drew, because the
// component reached for a prop the slot system never injects. So this test
// models the renderer's injection rules (which props a registration RECEIVES)
// and asserts the panel draws its map, and that the conversation path uses only
// props that really exist.
import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  .replace(/\n    return \{\n      inject: \[[^\]]*\],/,
    '\n    return {\n      __test: { NetHackPanel, ConversationBody, FixedChatConversationView, NethackIcon },');
let passed = 0;
const check = (label, fn) => { try { fn(); console.log('PASS', label); passed++; } catch (e) { console.error('FAIL', label, e.message); throw e; } };

function load() {
  let definition;
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children: children.flat(Infinity) }),
    useState(init) { return [typeof init === 'function' ? init() : init, () => {}]; },
    useRef(v) { return { current: v }; },
    useCallback(fn) { return fn; },
    useEffect() {},
    Fragment: 'Fragment',
  };
  const document = { visibilityState: 'visible', hidden: false, addEventListener() {}, removeEventListener() {},
    querySelector: () => ({}), createElement: () => ({ dataset: {}, style: {} }), head: { appendChild() {} } };
  new Function('window', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'ResizeObserver', source)(
    { __ModuleLoader__: { load: m => { definition = m; } } }, document,
    async () => ({ ok: true, status: 200, json: async () => null }), () => 0, () => {}, undefined,
  );
  return definition.factory(() => React).__test;
}

const { NetHackPanel, ConversationBody, FixedChatConversationView } = load();

check('empty native transcript still reserves space above the bottom composer', () => {
  const tree = FixedChatConversationView({ renderSlot: () => null });
  assert.equal(tree.type, 'div');
  assert.equal(tree.props.className, 'nhc-transcript-seat');
  assert.ok(source.includes('.nhc-chat [data-composer-seat] { margin-top: auto;'));
});

check('the pack shows exactly one scrollbar, never nested ones', () => {
  // The narrow side column and the pack element both fill the dock; when both
  // were scroll containers a long pack rendered two scrollbars side by side.
  assert.ok(/\.nhc-side > \.nhc-pack \{[^}]*overflow: hidden;/.test(source));
  assert.ok(/\.nhc-pack \{ flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0;/.test(source));
  assert.ok(/\.nhc-pack-body \{[^}]*overflow-y: auto;/.test(source));
  assert.equal((source.match(/\.nhc-pack-body \{[^}]*overflow: auto;/g) ?? []).length, 0);
  // The list inside the pack body used to carry its own max-height + overflow,
  // which is the second scrollbar that kept appearing beside the pack's one.
  assert.ok(!/\.nhc-inv \{[^}]*overflow:/.test(source));
  assert.ok(!/\.nhc-inv \{[^}]*max-height:/.test(source));
});

// Props the renderer supplies to an entry, transcribed from its injection rule:
// Installed renderer.standardKit supplies renderFactorySlot to EVERY entry;
// renderSlot requires children, SessionProvider requires a non-root child.
const slotProps = children => ({
  renderFactorySlot: () => null,
  ...(children ? { renderSlot: () => null } : {}),
});
const injectedFor = children => ({
  t: k => k,
  subscribeLocale: () => {},
  ...slotProps(children),
  ...(children && Object.values(children).some(s => s.scope !== 'root') ? { SessionProvider: p => p.children } : {}),
});

check('panel renders without any session or conversation props', () => {
  // The state is null on first paint; the panel must still produce its frame
  // rather than throwing, or the whole seat renders blank.
  const tree = NetHackPanel(injectedFor(null));
  assert.ok(tree, 'panel returned nothing');
  assert.ok(JSON.stringify(tree).includes('nhc-root'), 'panel has no root element');
});

check('factory rendering is always supplied, scoped child rendering is conditional', () => {
  const props = injectedFor(null);
  assert.equal(typeof props.renderFactorySlot, 'function');
  assert.equal(props.renderSlot, undefined);
  assert.equal(props.SessionProvider, undefined);
});

check('conversation body only reads props the slot system injects', () => {
  // It is the occupant of a declared child slot, so it receives `renderSlot`
  // and `renderFactorySlot` -- but never `SessionProvider` (it renders INSIDE
  // the provider its parent bound) and never a session of its own.
  const declared = { renderSlot: () => null, renderFactorySlot: () => ({ rendered: true }) };
  let released = 0;
  const tree = ConversationBody({ ...declared, reference: { release: () => { released++; } } });
  assert.deepEqual(tree, { rendered: true }, 'conversation body did not delegate to renderFactorySlot');
});

check('conversation body survives a missing reference', () => {
  // Attach can fail after the seat mounts; rendering must not throw then.
  const declared = { renderSlot: () => null, renderFactorySlot: () => 'ok' };
  assert.equal(ConversationBody({ ...declared, reference: undefined }), 'ok');
});

check('panel never calls renderFactorySlot itself', () => {
  // This is the actual bug: the panel is not a factory occurrence, so it can
  // never render the Conversation directly. Assert it delegates to its child.
  const from = source.indexOf('function NetHackPanel');
  const to = source.indexOf('function MessageTicker');
  assert.ok(from > 0 && to > from, 'could not locate the panel body');
  const body = source.slice(from, to);
  // Strip comments first: the prose explains renderFactorySlot, which is not a
  // call, and matching it would fail on a correct implementation.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!code.includes('renderFactorySlot'), 'panel calls renderFactorySlot, which it is never given');
  // The panel hands the conversation to its child slot, and it is `GameChat`
  // (rendered by the panel) that owns the Conversation seat -- a different
  // registration with a different injected prop set.
  const chat = source.slice(source.indexOf('function GameChat('), source.indexOf('function ConversationBody'));
  const chatCode = chat.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!chatCode.includes('renderFactorySlot'), 'GameChat calls renderFactorySlot, which it is never given');
  assert.ok(chatCode.includes('renderSlot(CONV_SLOT'), 'GameChat does not render the conversation child slot');
  assert.ok(code.includes('h(GameChat'), 'panel does not render GameChat');
});

check('session creation is fresh and never archives a playable session', () => {
  assert.ok(source.includes('await sessions.create({ agentPreset: GAME_PRESET })'));
  assert.ok(source.includes('await reference.ready'));
  assert.ok(!source.includes('connectWorkspace:'));
  assert.ok(!source.includes('archiveSession?.('));
});

console.log(`${passed} passed, 0 failed`);
