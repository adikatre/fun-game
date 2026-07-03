// Runtime smoke test of the FULL stack (main + render + input) against a fake
// DOM/Canvas. Verifies init, rendering many frames, and response to synthetic
// mouse/keyboard input without throwing.
//
// Import order matters: fakedom installs globals BEFORE main.ts runs.
import { drive, fireClick, fireDrag, fireKey, fireRightClick, fireScreenClick, getGame } from './fakedom';
import '../src/main';

let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
}
const d = (a: any, b: any) => Math.hypot(a.x - b.x, a.y - b.y);
function nearestEnd(ac: any, rw: any): 0 | 1 {
  return d(ac, rw.ends[0].finalEntry) <= d(ac, rw.ends[1].finalEntry) ? 0 : 1;
}

console.log('=== Final Approach — DOM/render/input smoke test ===\n');

try {
  drive(10);
  check('boots to the briefing screen', getGame().status === 'briefing');
  fireScreenClick({ x: 200, y: 200 }); // any tap starts the shift
  drive(2);
  check('click starts the shift', getGame().status === 'playing');

  drive(60 * 6);
  check('rendered frames without throwing', true);
  check('aircraft spawned', getGame().totalSpawned >= 1);

  // act as a controller for ~80s: drag arrivals to a runway to land them, and
  // drag ready-to-depart planes to a runway to launch them (the full ground loop).
  for (let i = 0; i < 40; i++) {
    const s = getGame();
    const wc = s.aircraft.find((a: any) => a.phase === 'waitCross');
    if (wc) {
      fireClick({ x: wc.x, y: wc.y });
      fireScreenClick({ x: 1280 - 130, y: 800 - 138 }); // click authorize cross
    }

    const rwA = s.runways[i % s.runways.length];
    const arr = s.aircraft.find((a: any) => a.assignedRunwayId == null && (a.phase === 'inbound' || a.phase === 'holding'));
    if (arr) {
      const end = nearestEnd(arr, rwA);
      fireDrag({ x: arr.x, y: arr.y }, { x: rwA.ends[end].threshold.x, y: rwA.ends[end].threshold.y });
    }
    const dep = s.aircraft.find((a: any) => a.phase === 'readyDep');
    if (dep) {
      const rwD = s.runways[(i + 1) % s.runways.length];
      if (rwD !== rwA || !s.aircraft.find((a: any) => a.phase === 'landing' && a.assignedRunwayId === rwD.id)) {
        const end = nearestEnd(dep, rwD);
        fireDrag({ x: dep.x, y: dep.y }, { x: rwD.ends[end].threshold.x, y: rwD.ends[end].threshold.y });
      }
    }
    drive(120);
  }
  check('drag-to-land delivered at least one arrival', getGame().handled >= 1);
  check('arrivals taxi to gates + turn around + depart', getGame().departed >= 1);
  check('controller earned salary', getGame().cash > 0);

  // bidirectional: a plane can be cleared to land on EITHER end of a runway.
  {
    const s = getGame();
    const ac = s.aircraft.find((a: any) => a.phase !== 'landing');
    const rw = s.runways[0];
    if (ac) {
      fireDrag({ x: ac.x, y: ac.y }, { x: rw.ends[0].threshold.x, y: rw.ends[0].threshold.y });
      const e0 = getGame().aircraft.find((a: any) => a.id === ac.id)?.assignedEnd;
      fireDrag({ x: ac.x, y: ac.y }, { x: rw.ends[1].threshold.x, y: rw.ends[1].threshold.y });
      const e1 = getGame().aircraft.find((a: any) => a.id === ac.id)?.assignedEnd;
      check('drag to end 0 assigns end 0', e0 === 0);
      check('drag to the other side assigns end 1 (bidirectional)', e1 === 1);
    } else {
      check('bidirectional landing (no aircraft to test)', true);
    }
  }

  // right-click hold
  {
    const s = getGame();
    const ac = s.aircraft.find((a: any) => a.phase === 'inbound' || a.phase === 'approach');
    if (ac) {
      fireRightClick({ x: ac.x, y: ac.y });
      check('right-click toggled hold', getGame().aircraft.find((a: any) => a.id === ac.id)?.phase === 'holding');
    } else {
      check('right-click hold (no aircraft to test)', true);
    }
  }

  // Space pause freezes sim time
  fireKey('Space');
  check('Space paused', getGame().paused === true);
  const tP = getGame().time;
  drive(120);
  check('sim time frozen while paused', Math.abs(getGame().time - tP) < 1e-6);

  // editing (click an airborne arrival, click a runway side) works while paused
  {
    const s = getGame();
    const ac = s.aircraft.find((a: any) => a.phase === 'inbound' || a.phase === 'holding');
    const rw = s.runways[0];
    if (ac) {
      const end = nearestEnd(ac, rw);
      fireClick({ x: ac.x, y: ac.y });
      // click out on the corridor (finalEntry) — clear of any plane near the strip
      fireClick({ x: rw.ends[end].finalEntry.x, y: rw.ends[end].finalEntry.y });
      const after = getGame().aircraft.find((a: any) => a.id === ac.id);
      check('can clear a plane to land while paused', !!after && after.assignedRunwayId === rw.id);
    } else {
      check('can edit while paused (no airborne arrival to test)', true);
    }
  }

  fireKey('Space');
  check('Space un-paused', getGame().paused === false);

  // restart
  fireKey('KeyR');
  drive(5);
  check('restart reset handled to 0', getGame().handled === 0);
  check('restart reset time to ~0', getGame().time < 1);

  drive(60 * 120);
  check('survived a 2-minute driven run without throwing', true);

  // shift end -> debrief screen with a grade -> NEXT SHIFT button starts a harder day
  {
    const s = getGame();
    if (s.status === 'playing') {
      s.time = s.shiftLength - 0.05;
      drive(10);
    }
    check('shift timer ends in debrief or fired', getGame().status === 'debrief' || getGame().status === 'fired');
    check('a grade was assigned', getGame().grade != null);
    const dayBefore = getGame().day;
    if (getGame().status === 'debrief') {
      // primary "NEXT SHIFT" button center (see ui.endButtons): left of center, cy+132+h/2
      fireScreenClick({ x: 1280 / 2 - 12 - 110, y: 800 / 2 + 132 + 26 });
      drive(5);
      check('NEXT SHIFT advances the day', getGame().day === dayBefore + 1 && getGame().status === 'playing');
    } else {
      // "TRY AGAIN" button (centered)
      fireScreenClick({ x: 1280 / 2, y: 800 / 2 + 132 + 26 });
      drive(5);
      check('TRY AGAIN restarts the day', getGame().day === dayBefore && getGame().status === 'playing');
    }
  }
} catch (err) {
  console.log('\n  THREW:', err);
  failures++;
}

console.log(`\n=== smoke test ${failures === 0 ? 'PASSED' : `FAILED (${failures})`} ===`);
if (failures > 0) process.exit(1);
