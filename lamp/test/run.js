// Unit tests for the pure parts: engagement state machine, action validation, memory, geometry.
import assert from 'node:assert/strict';
import { Engagement } from '../server/engagement.js';
import { validatePlan, imageToAim, aimToImage } from '../server/actions.js';
import { Memory } from '../server/memory.js';

let n = 0; const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

// Drive the state machine with a simulated clock at 10 Hz.
function sim(script) {
  let t = 0; const e = new Engagement({}, () => t); const ev = [];
  for (const [dur, present, attn] of script) for (let i = 0; i < dur * 10; i++) { t += 100; ev.push(...e.update({ present, attn }).map((x) => [t, x.type])); }
  return { e, ev, types: ev.map((x) => x[1]) };
}
test('engages after dwell when person looks at lamp', () => {
  const { types, e } = sim([[3, true, 0.9]]);
  assert.deepEqual(types, ['aware', 'engaged']); assert.equal(e.state, 'ENGAGED');
});
test('does NOT engage for a glance shorter than the dwell', () => {
  const { types } = sim([[1, true, 0.1], [0.3, true, 0.9], [2, true, 0.1]]);
  assert.ok(!types.includes('engaged'));
});
test('does not engage for a face that is present but looking away', () => {
  const { types, e } = sim([[10, true, 0.15]]);
  assert.deepEqual(types, ['aware']); assert.equal(e.state, 'AWARE');
});
test('looking away -> drifting -> disengaged; looking back during grace re-engages without a fresh greeting', () => {
  const a = sim([[3, true, 0.9], [4, true, 0.05]]);
  assert.deepEqual(a.types, ['aware', 'engaged', 'drifting']);
  const b = sim([[3, true, 0.9], [2, true, 0.05], [2, true, 0.9]]);
  assert.deepEqual(b.types, ['aware', 'engaged', 'drifting', 'engaged']); assert.equal(b.ev.at(-1)[1], 'engaged');
  const c = sim([[3, true, 0.9], [8, true, 0.05]]);
  assert.ok(c.types.includes('disengaged'));
});
test('hysteresis: attention between exit and enter does not flap', () => {
  const { types } = sim([[3, true, 0.9], [10, true, 0.48]]);
  assert.deepEqual(types, ['aware', 'engaged']);
});
test('person leaving the frame disengages and goes ABSENT', () => {
  const { types, e } = sim([[3, true, 0.9], [12, false, 0]]);
  assert.ok(types.includes('disengaged')); assert.equal(e.state, 'ABSENT');
});
test('stale perception (camera stalls) is treated as no-face', () => {
  let t = 0; const e = new Engagement({}, () => t);
  for (let i = 0; i < 30; i++) { t += 100; e.update({ present: true, attn: 0.9 }); }
  assert.equal(e.state, 'ENGAGED');
  const evs = []; for (let i = 0; i < 150; i++) { t += 100; evs.push(...e.tick(t)); }
  assert.ok(evs.some((x) => x.type === 'disengaged'));
});
test('re-engagement soon after disengaging is not "fresh" (no repeated greeting)', () => {
  const { ev } = sim([[3, true, 0.9], [9, true, 0.05], [3, true, 0.9]]);
  const last = ev.filter((x) => x[1] === 'engaged');
  assert.equal(last.length, 2);
});

test('plan validation clamps, drops unknown actions and bounds length', () => {
  const { steps, rejected } = validatePlan([
    { action: 'aim', x: 1.7, y: -3 }, { action: 'gesture', name: 'backflip' }, { action: 'set_joint', q: 9 },
    { action: 'light', color: 'nope', intensity: 5, pattern: 'strobe' }, { action: 'say', text: 'x'.repeat(500) }, { action: 'hold', ms: 99999 },
    ...Array(10).fill({ action: 'sfx', name: 'blip' }),
  ]);
  assert.deepEqual(steps[0], { action: 'aim', x: 1, y: 0 });
  assert.equal(steps[1].intensity, 1); assert.equal(steps[1].pattern, 'solid'); assert.match(steps[1].color, /^#/);
  assert.equal(steps[2].text.length, 220); assert.equal(steps[3].ms, 3000);
  assert.ok(steps.length <= 8); assert.ok(rejected.some((r) => /backflip/.test(r)) && rejected.some((r) => /set_joint/.test(r)));
});
test('image<->aim geometry round-trips and has the right signs', () => {
  const a = imageToAim(0.8, 0.3); assert.ok(a.yaw < 0 && a.pitch > 0); // right of centre => turn right; above centre => look up
  const b = aimToImage(a.yaw, a.pitch); assert.ok(Math.abs(b.x - 0.8) < 1e-9 && Math.abs(b.y - 0.3) < 1e-9);
});
test('memory merges re-observations and flags objects that left the view', () => {
  const m = new Memory(null);
  m.observe([{ label: 'mug', color: 'red', box: [0.1, 0.5, 0.2, 0.2], description: 'a mug' }, { label: 'book', color: 'blue', box: [0.6, 0.6, 0.2, 0.2] }]);
  m.observe([{ label: 'mug', color: 'red', box: [0.4, 0.5, 0.2, 0.2] }]);
  assert.equal(Object.keys(m.objects).length, 2);
  const mug = Object.values(m.objects).find((o) => o.label === 'mug'); const book = Object.values(m.objects).find((o) => o.label === 'book');
  assert.equal(mug.sightings, 2); assert.ok(Math.abs(mug.center.x - 0.5) < 1e-9); assert.equal(book.present, false);
  assert.match(m.summary(), /NOT in view/);
});
console.log(`\n${n} tests passed`);
