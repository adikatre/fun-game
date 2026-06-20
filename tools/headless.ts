// Headless sim harness — runs sim.ts (no DOM) with a crude auto-controller so we
// can measure the tension curve, determinism, and per-step timing without a
// browser. Run via: npm run sim:test
//
// The auto-controller is NOT skilled play. It clears one plane to final per
// runway at a time, holds the overflow, and breaks conflicts by sending a plane
// into a hold. It exists to keep traffic flowing so the loop can be observed.

import { CONFIG } from '../src/config';
import { commandToRunway, createGame, toggleHold, update } from '../src/sim';
import type { GameState } from '../src/types';

const STEP = 1 / CONFIG.simStepHz;

function dist(ax: number, ay: number, bx: number, by: number) {
  return Math.hypot(ax - bx, ay - by);
}
function nearestEnd(ac: { x: number; y: number }, rw: GameState['runways'][number]): 0 | 1 {
  const d0 = dist(ac.x, ac.y, rw.ends[0].finalEntry.x, rw.ends[0].finalEntry.y);
  const d1 = dist(ac.x, ac.y, rw.ends[1].finalEntry.x, rw.ends[1].finalEntry.y);
  return d0 <= d1 ? 0 : 1;
}

function plan(state: GameState): void {
  // 1) break conflicts: send a conflicting plane into a hold (unless near touchdown)
  for (const ac of state.aircraft) {
    if (!ac.conflict) continue;
    const rw = ac.assignedRunwayId != null ? state.runways.find((r) => r.id === ac.assignedRunwayId) : undefined;
    const th = rw && ac.assignedEnd != null ? rw.ends[ac.assignedEnd].threshold : null;
    const nearTouchdown = th && dist(ac.x, ac.y, th.x, th.y) < 110;
    if (ac.phase !== 'holding' && !nearTouchdown) toggleHold(state, ac.id);
  }

  // 2) one operation per runway at a time (the strip is shared by both ends and
  //    by takeoffs). Prefer arrivals (emergency, then low fuel); if none waiting,
  //    launch a ready departure to free a gate.
  for (const rw of state.runways) {
    const inUse = state.aircraft.some(
      (a) =>
        a.assignedRunwayId === rw.id &&
        (a.phase === 'approach' || a.phase === 'taxiOut' || a.phase === 'holdShort' || a.phase === 'takeoff'),
    );
    if (inUse || state.time < rw.occupiedUntil) continue;

    const arr = state.aircraft
      .filter((a) => a.assignedRunwayId == null && (a.phase === 'inbound' || a.phase === 'holding') && !a.conflict)
      .sort((a, b) => {
        const ea = a.emergency !== 'none' ? 0 : 1;
        const eb = b.emergency !== 'none' ? 0 : 1;
        if (ea !== eb) return ea - eb;
        return a.fuelSeconds - b.fuelSeconds;
      })[0];
    if (arr) {
      commandToRunway(state, arr.id, rw.id, nearestEnd(arr, rw));
      continue;
    }
    const dep = state.aircraft.find((a) => a.phase === 'readyDep');
    if (dep) commandToRunway(state, dep.id, rw.id, nearestEnd(dep, rw));
  }

  // 3) park anything still loose so it doesn't fly off and divert
  for (const ac of state.aircraft) {
    if (ac.phase !== 'inbound') continue;
    if (ac.assignedRunwayId != null || ac.conflict) continue;
    toggleHold(state, ac.id);
  }
}

interface Result {
  handled: number;
  departed: number;
  incidents: number;
  nearMisses: number;
  goArounds: number;
  diversions: number;
  cash: number;
  timeEnded: number;
  totalSpawned: number;
  rngState: number;
  gameOver: boolean;
  samples: { t: number; handled: number; departed: number; incidents: number; airborne: number; cash: number }[];
}

function run(seed: number, maxSeconds: number, withPlanner: boolean): Result {
  const state = createGame(seed);
  const samples: Result['samples'] = [];
  let step = 0;
  const planEvery = Math.round(0.5 / STEP);
  const sampleEvery = Math.round(10 / STEP);

  while (state.time < maxSeconds && state.status === 'playing') {
    if (withPlanner && step % planEvery === 0) plan(state);
    update(state, STEP);
    if (step % sampleEvery === 0) {
      samples.push({
        t: Math.round(state.time),
        handled: state.handled,
        departed: state.departed,
        incidents: state.incidents,
        airborne: state.aircraft.length,
        cash: state.cash,
      });
    }
    step++;
  }
  return {
    handled: state.handled,
    departed: state.departed,
    incidents: state.incidents,
    nearMisses: state.nearMisses,
    goArounds: state.goArounds,
    diversions: state.diversions,
    cash: state.cash,
    timeEnded: state.time,
    totalSpawned: state.totalSpawned,
    rngState: state.rng.state,
    gameOver: state.status === 'gameover',
    samples,
  };
}

console.log('=== Final Approach — headless sim harness ===\n');

// 1) No-input baseline: how fast does it fall apart if the controller does nothing?
const idle = run(CONFIG.defaultSeed, 600, false);
console.log(
  `No-input baseline: ${idle.gameOver ? `FIRED at t=${idle.timeEnded.toFixed(1)}s` : `survived ${idle.timeEnded}s`}` +
    `  (handled=${idle.handled}, spawned=${idle.totalSpawned}, incidents=${idle.incidents})`,
);

// 2) Auto-controller run, full tension curve.
const play = run(CONFIG.defaultSeed, 600, true);
console.log(
  `\nAuto-controller (seed=${CONFIG.defaultSeed}): ${
    play.gameOver ? `FIRED at t=${play.timeEnded.toFixed(1)}s` : `survived ${play.timeEnded.toFixed(0)}s`
  }`,
);
console.log(
  `  landed=${play.handled}  departed=${play.departed}  cash=$${play.cash}  spawned=${play.totalSpawned}  ` +
    `incidents=${play.incidents}  near-miss=${play.nearMisses}  go-around=${play.goArounds}  diverted=${play.diversions}`,
);
console.log('  tension curve:');
console.log('    t(s)  landed  departed  incidents  aircraft   cash');
for (const s of play.samples) {
  if (s.t % 20 !== 0) continue;
  console.log(
    `    ${s.t.toString().padStart(4)}  ${s.handled.toString().padStart(6)}  ${s.departed
      .toString()
      .padStart(8)}  ${s.incidents.toString().padStart(9)}  ${s.airborne.toString().padStart(8)}  ${(
      '$' + s.cash
    ).padStart(6)}`,
  );
}

// 3) Determinism.
const a = run(CONFIG.defaultSeed, 220, true);
const b = run(CONFIG.defaultSeed, 220, true);
const deterministic =
  a.handled === b.handled &&
  a.incidents === b.incidents &&
  a.cash === b.cash &&
  a.rngState === b.rngState &&
  a.totalSpawned === b.totalSpawned;
console.log(
  `\nDeterminism (two identical 220s runs): ${deterministic ? 'PASS' : 'FAIL'}  ` +
    `[handled ${a.handled}/${b.handled}, cash ${a.cash}/${b.cash}, rngState ${a.rngState}/${b.rngState}]`,
);
const c = run(CONFIG.defaultSeed + 1, 220, true);
console.log(`  different seed differs: ${c.handled !== a.handled || c.rngState !== a.rngState ? 'yes' : 'no'}`);

// 4) Performance under load.
const perf = createGame(CONFIG.defaultSeed);
for (let i = 0; i < 60 * 200; i++) {
  if (i % 30 === 0) plan(perf);
  if (perf.status !== 'playing') break;
  update(perf, STEP);
}
perf.status = 'playing';
perf.incidents = 0;
const N = 60 * 60 * 5;
const t0 = performance.now();
for (let i = 0; i < N; i++) update(perf, STEP);
const t1 = performance.now();
const ms = t1 - t0;
console.log(
  `\nPerformance: ${N} steps in ${ms.toFixed(1)}ms => ${(ms / N).toFixed(4)}ms/step ` +
    `(loaded: ${perf.aircraft.length} aircraft)`,
);
console.log(
  `  a 16.6ms frame fits ~${Math.floor(16.6 / (ms / N))} sim steps; sim uses ${((ms / N) * CONFIG.simStepHz).toFixed(
    3,
  )}ms CPU per real second.`,
);

console.log('\n=== done ===');
