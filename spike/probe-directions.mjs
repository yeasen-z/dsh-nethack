process.on('unhandledRejection', e => { console.log('[UNHANDLED]', e?.message); fin(); });
const { startEngine } = await import('./nethack367-bridge.mjs');
const { default: createModule } = await import('../plugins/dsh-nethack/engine/build/nethack.js');
const NAMES = ['N','NE','E','SE','S','SW','W','NW'];
// number_pad:1 => h/j/k/l etc. are the classic vi keys.
// number_pad:1 => digits are directions; vi keys are disabled (verified:
// h/j/k/l produced "cmdassist: Invalid direction key!").
const KEYS = { N:'8', NE:'9', E:'6', SE:'3', S:'2', SW:'1', W:'4', NW:'7' };
const status = {}; let pos = null; const tiles = new Set(); const msgs = [];
let pending = null; let parks = 0;
const fp = () => `${pos?pos.x+','+pos.y:'-'}|T=${status.BL_TIME}|tiles=${tiles.size}`;
await startEngine({
  createModule, name: 'Tester',
  onEvent: (e) => {
    if (e.type === 'status') status[e.field] = e.value;
    else if (e.type === 'player') pos = { x: e.x, y: e.y };
    else if (e.type === 'glyph') tiles.add(`${e.x},${e.y}`);
    else if (e.type === 'message') msgs.push(e.text);
  },
  requestInput: (p) => {
    if (p.kind === 'command') { parks++; return new Promise(r => { pending = { p, r }; }); }
    if (p.kind === 'yn') return Promise.resolve('y');
    if (p.kind === 'line') return Promise.resolve('Tester');
    return Promise.resolve(' ');
  },
});
const results = []; let idx = 0;
const timer = setInterval(() => {
  if (!pending) return;
  if (idx >= NAMES.length) { clearInterval(timer); setTimeout(fin, 900); return; }
  const dir = NAMES[idx], key = KEYS[dir];
  const before = fp(), msgMark = msgs.length;
  const { r } = pending; pending = null;
  r(key);
  setTimeout(() => {
    results.push(`${dir} (key '${key}'): ${before}  ->  ${fp()}  msg=${JSON.stringify(msgs.slice(msgMark, msgMark+1))}`);
    idx++;
  }, 700);
}, 300);
function fin() { console.log(results.join('\n')); process.exit(0); }
setTimeout(fin, 30000);
