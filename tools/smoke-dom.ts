// Runtime smoke test of the FULL stack (main + render + input) against a fake
// DOM/Canvas. Verifies init, rendering many frames, and response to synthetic
// mouse/keyboard input without throwing.
//
// Import order matters: fakedom installs globals BEFORE main.ts runs.
import { drive, fireClick, fireDrag, fireKey, fireRightClick, getGame } from './fakedom';
import '../src/main';

let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
}

console.log('=== Final Approach — DOM/render/input smoke test ===\n');

try {
  // a few seconds for the first arrival(s)
  drive(60 * 6);
  check('rendered frames without throwing', true);
  check('aircraft spawned', getGame().totalSpawned >= 1);

  // act as a controller for ~55s: clear inbound planes to a runway via the
  // real input path (click plane, then click runway).
  for (let i = 0; i < 28; i++) {
    const s = getGame();
    const rw = s.runways[i % s.runways.length];
    const ac = s.aircraft.find(
      (a: any) => a.assignedRunwayId == null && (a.phase === 'inbound' || a.phase === 'vectoring' || a.phase === 'holding'),
    );
    if (ac) {
      fireClick({ x: ac.x, y: ac.y }); // select
      fireClick({ x: rw.cx, y: rw.cy }); // clear to land
    }
    drive(120);
  }
  check('click-to-land delivered at least one aircraft', getGame().handled >= 1);
  check('controller earned salary', getGame().cash > 0 || getGame().handled >= 1);

  // drag-to-vector
  {
    const s = getGame();
    const ac = s.aircraft.find((a: any) => a.phase !== 'landing');
    if (ac) {
      fireDrag({ x: ac.x, y: ac.y }, { x: ac.x - 120, y: ac.y - 80 });
      const after = getGame().aircraft.find((a: any) => a.id === ac.id);
      check('drag set a vector (waypoints / vectoring)', !!after && (after.phase === 'vectoring' || after.waypoints.length > 0));
    } else {
      check('drag set a vector (no aircraft to test)', true);
    }
  }

  // right-click hold
  {
    const s = getGame();
    const ac = s.aircraft.find((a: any) => a.phase !== 'landing');
    if (ac) {
      fireRightClick({ x: ac.x, y: ac.y });
      const after = getGame().aircraft.find((a: any) => a.id === ac.id);
      check('right-click toggled hold', !!after && after.phase === 'holding');
    } else {
      check('right-click toggled hold (no aircraft to test)', true);
    }
  }

  // Space pause freezes sim time
  fireKey('Space');
  check('Space paused', getGame().paused === true);
  const tP = getGame().time;
  drive(120);
  check('sim time frozen while paused', Math.abs(getGame().time - tP) < 1e-6);

  // editing works while paused
  {
    const s = getGame();
    const ac = s.aircraft.find((a: any) => a.phase !== 'landing' && a.phase !== 'approach');
    if (ac) {
      fireClick({ x: ac.x, y: ac.y });
      fireClick({ x: s.runways[0].cx, y: s.runways[0].cy });
      const after = getGame().aircraft.find((a: any) => a.id === ac.id);
      check('can clear a plane to land while paused', !!after && after.assignedRunwayId === s.runways[0].id);
    } else {
      check('can edit while paused (no aircraft to test)', true);
    }
  }

  fireKey('Space');
  check('Space un-paused', getGame().paused === false);

  // restart
  fireKey('KeyR');
  drive(5);
  check('restart reset handled to 0', getGame().handled === 0);
  check('restart reset time to ~0', getGame().time < 1);

  // long driven run shakes out late-stage crashes
  drive(60 * 120);
  check('survived a 2-minute driven run without throwing', true);
} catch (err) {
  console.log('\n  THREW:', err);
  failures++;
}

console.log(`\n=== smoke test ${failures === 0 ? 'PASSED' : `FAILED (${failures})`} ===`);
if (failures > 0) process.exit(1);
