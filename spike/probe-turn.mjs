process.on('unhandledRejection', e => { console.log('[UNHANDLED]', e?.message, e?.stack?.split('\n')[1]); fin(); });
const { startEngine } = await import('./nethack367-bridge.mjs');
const { default: createModule } = await import('../plugins/dsh-nethack/engine/build/nethack.js');
const status = {}; const tiles = new Map(); let pos = null; const msgs = [];
let pending = null; const log = []; const errs = [];
let delivered = 0;
const fp = () => `pos=${pos?pos.x+','+pos.y:'-'} T=${status.BL_TIME} HP=${status.BL_HP}/${status.BL_HPMAX} tiles=${tiles.size}`;
await startEngine({
  createModule, name: 'Tester',
  onEvent: (e) => {
    if (e.type === 'glyph') tiles.set(`${e.x},${e.y}`, e.tty);
    else if (e.type === 'message') msgs.push(e.text);
    else if (e.type === 'status') status[e.field] = e.value;
    else if (e.type === 'player') pos = { x: e.x, y: e.y };
    else if (e.type === 'stderr') errs.push(e.text);
  },
  requestInput: (p) => {
    if (p.kind === 'command') { log.push('PARK @ ' + fp()); return new Promise(r => { pending = { p, r }; }); }
    if (p.kind === 'yn') return Promise.resolve('y');
    if (p.kind === 'line') return Promise.resolve('Tester');
    return Promise.resolve(' ');     // more / key / etc.
  },
});
// Each time the engine parks at a command prompt, deliver one keystroke.
const timer = setInterval(() => {
  if (!pending) return;
  if (delivered >= 4) { clearInterval(timer); setTimeout(fin, 1200); return; }
  const key = ['h', 'h', 'l', '.'][delivered];
  const { r } = pending; pending = null; delivered++;
  log.push(`SEND ${JSON.stringify(key)} (before ${fp()})`);
  r(key);
}, 250);
function fin() {
  console.log(log.join('\n'));
  console.log('RESULT ' + fp() + ' | msgs:', JSON.stringify(msgs.slice(18, 24)));
  console.log('errs:', JSON.stringify(errs.slice(0, 3)));
  process.exit(0);
}
setTimeout(fin, 20000);
