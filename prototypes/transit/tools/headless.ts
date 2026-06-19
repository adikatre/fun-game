// Headless sim harness — runs sim.ts (no DOM) with a greedy auto-player so we
// can measure the tension curve, routing behavior, determinism, and per-step
// timing without a browser. Run via: npm run sim:test
//
// The auto-player is a crude network builder (NOT representative of skilled
// play): it connects unconnected stations to the nearest line endpoint and
// keeps the network spanning. It exists to keep passengers flowing so we can
// observe the mechanics, not to "win".

import { CONFIG } from '../src/config';
import {
  applyDraftOption,
  canCreateLine,
  createGame,
  createLine,
  endpointLinesAt,
  extendLine,
  update,
} from '../src/sim';
import type { GameState, Station } from '../src/types';

const STEP = 1 / CONFIG.simStepHz;

function nearestPair(stations: Station[]): [number, number] {
  let bi = 0;
  let bj = 1;
  let bd = Infinity;
  for (let i = 0; i < stations.length; i++) {
    for (let j = i + 1; j < stations.length; j++) {
      const d = Math.hypot(stations[i].x - stations[j].x, stations[i].y - stations[j].y);
      if (d < bd) {
        bd = d;
        bi = i;
        bj = j;
      }
    }
  }
  return [stations[bi].id, stations[bj].id];
}

function connectedStationIds(state: GameState): Set<number> {
  const set = new Set<number>();
  for (const l of state.lines) for (const id of l.stationIds) set.add(id);
  return set;
}

/** Greedy planner: keep the network connected by attaching loose stations to the nearest endpoint. */
function plan(state: GameState): void {
  if (state.draft) {
    // prefer throughput upgrades
    const pref = ['addTrain', 'speed', 'capacity', 'lineSlot', 'maxStrain'];
    const opt =
      state.draft.options.find((o) => pref.includes(o.id))?.id ?? state.draft.options[0].id;
    applyDraftOption(state, opt);
    return;
  }

  // Seed the first line.
  if (state.lines.length === 0 && state.stations.length >= 2 && canCreateLine(state)) {
    const [a, b] = nearestPair(state.stations);
    createLine(state, a, b);
    return;
  }

  const connected = connectedStationIds(state);
  const loose = state.stations.filter((s) => !connected.has(s.id));
  if (loose.length === 0) return;

  // Attach the loose station nearest to any existing endpoint, to that endpoint.
  const byId = new Map(state.stations.map((s) => [s.id, s]));
  let best: { lineId: number; fromId: number; toId: number; d: number } | null = null;
  for (const line of state.lines) {
    const ends = [line.stationIds[0], line.stationIds[line.stationIds.length - 1]];
    for (const endId of ends) {
      const e = byId.get(endId)!;
      for (const s of loose) {
        const d = Math.hypot(e.x - s.x, e.y - s.y);
        if (!best || d < best.d) best = { lineId: line.id, fromId: endId, toId: s.id, d };
      }
    }
  }

  // If a new line slot is free and a loose station is far from all endpoints,
  // sometimes open a fresh line instead of overextending one.
  if (canCreateLine(state) && best && best.d > 320) {
    const s = loose[0];
    // connect it to the nearest connected station
    let nearId = -1;
    let nd = Infinity;
    for (const cid of connected) {
      const c = byId.get(cid)!;
      const d = Math.hypot(c.x - s.x, c.y - s.y);
      if (d < nd) {
        nd = d;
        nearId = cid;
      }
    }
    if (nearId >= 0) {
      createLine(state, nearId, s.id);
      return;
    }
  }

  if (best) extendLine(state, best.lineId, best.fromId, best.toId);
}

interface RunResult {
  delivered: number;
  strain: number;
  timeEnded: number;
  stations: number;
  totalSpawned: number;
  trains: number;
  rngState: number;
  gameOver: boolean;
  stuckBoardings: number;
  avgLatency: number;
  samples: { t: number; delivered: number; strain: number; waiting: number; maxQueue: number }[];
}

function run(seed: number, maxSeconds: number, withPlanner: boolean): RunResult {
  const state = createGame(seed);
  const samples: RunResult['samples'] = [];
  let stepNo = 0;
  const planEvery = Math.round(0.5 / STEP); // plan twice a second
  const sampleEvery = Math.round(10 / STEP); // sample every 10s

  while (state.time < maxSeconds && state.status === 'playing') {
    if (withPlanner && stepNo % planEvery === 0) plan(state);
    update(state, STEP);
    if (stepNo % sampleEvery === 0) {
      let waiting = 0;
      let maxQueue = 0;
      for (const s of state.stations) {
        waiting += s.queue.length;
        if (s.queue.length > maxQueue) maxQueue = s.queue.length;
      }
      samples.push({ t: Math.round(state.time), delivered: state.delivered, strain: state.strain, waiting, maxQueue });
    }
    stepNo++;
  }

  let trains = 0;
  for (const l of state.lines) trains += l.trains.length;
  return {
    delivered: state.delivered,
    strain: state.strain,
    timeEnded: state.time,
    stations: state.stations.length,
    totalSpawned: state.totalSpawned,
    trains,
    rngState: state.rng.state,
    gameOver: state.status === 'gameover',
    stuckBoardings: state.stuckBoardings,
    avgLatency: state.delivered > 0 ? state.deliveredLatencySum / state.delivered : 0,
    samples,
  };
}

// ---------------------------------------------------------------------------
console.log('=== Headway headless sim harness ===\n');

// 1) No-input baseline: how fast does it fail if the player does nothing?
const idle = run(CONFIG.defaultSeed, 600, false);
console.log(
  `No-input baseline: GAME OVER at t=${idle.timeEnded.toFixed(1)}s, delivered=${idle.delivered}, spawned=${idle.totalSpawned}`,
);

// 2) Greedy auto-player run, full tension curve.
const play = run(CONFIG.defaultSeed, 600, true);
console.log(
  `\nGreedy auto-player (seed=${CONFIG.defaultSeed}): ${
    play.gameOver ? `GAME OVER at t=${play.timeEnded.toFixed(1)}s` : `survived ${play.timeEnded}s`
  }`,
);
console.log(
  `  delivered=${play.delivered}  spawned=${play.totalSpawned}  stations=${play.stations}  trains=${play.trains}`,
);
console.log(
  `  avg trip time=${play.avgLatency.toFixed(1)}s  stuck-fallback boardings=${play.stuckBoardings} (${(
    (100 * play.stuckBoardings) /
    Math.max(1, play.delivered)
  ).toFixed(1)}% of deliveries)`,
);
console.log('  tension curve (10s — capped at first 220s):');
console.log('    t(s)  delivered  strain  waiting  maxQ');
for (const s of play.samples) {
  if (s.t > 220) break;
  if (s.t % 20 !== 0) continue;
  console.log(
    `    ${s.t.toString().padStart(4)}  ${s.delivered.toString().padStart(9)}  ${s.strain
      .toString()
      .padStart(6)}  ${s.waiting.toString().padStart(7)}  ${s.maxQueue.toString().padStart(4)}`,
  );
}

// 3) Determinism: identical seed + identical scripted actions => identical state.
const a = run(CONFIG.defaultSeed, 200, true);
const b = run(CONFIG.defaultSeed, 200, true);
const deterministic =
  a.delivered === b.delivered &&
  a.strain === b.strain &&
  a.rngState === b.rngState &&
  a.totalSpawned === b.totalSpawned &&
  a.timeEnded === b.timeEnded;
console.log(
  `\nDeterminism (two identical 200s runs): ${deterministic ? 'PASS' : 'FAIL'}  ` +
    `[delivered ${a.delivered}/${b.delivered}, rngState ${a.rngState}/${b.rngState}]`,
);

// Different seeds should differ (sanity).
const c = run(CONFIG.defaultSeed + 1, 200, true);
console.log(
  `  different seed differs: ${c.delivered !== a.delivered || c.rngState !== a.rngState ? 'yes' : 'no (suspicious)'}`,
);

// 4) Performance: steps/sec for the loaded full run.
const N = 60 * 60 * 5; // 5 sim-minutes of steps
const perfState = createGame(CONFIG.defaultSeed);
// warm up to a loaded state (~12 stations, multiple lines/trains)
for (let i = 0; i < 60 * 90; i++) {
  if (i % 30 === 0) plan(perfState);
  if (perfState.status !== 'playing') break;
  update(perfState, STEP);
}
let pTrains = 0;
for (const l of perfState.lines) pTrains += l.trains.length;
// force-resume if it died, just to time steady-state stepping
perfState.status = 'playing';
perfState.strain = 0;
const t0 = performance.now();
for (let i = 0; i < N; i++) update(perfState, STEP);
const t1 = performance.now();
const msTotal = t1 - t0;
console.log(
  `\nPerformance: ${N} steps in ${msTotal.toFixed(1)}ms => ${(msTotal / N).toFixed(
    4,
  )}ms/step (loaded: ${perfState.stations.length} stations, ${perfState.lines.length} lines, ${pTrains} trains)`,
);
console.log(
  `  headroom: a frame budget of 16.6ms fits ~${Math.floor(16.6 / (msTotal / N))} sim steps; sim uses ${(
    (msTotal / N) *
    CONFIG.simStepHz
  ).toFixed(3)}ms of CPU per real second.`,
);

console.log('\n=== done ===');
