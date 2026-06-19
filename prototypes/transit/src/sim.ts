// sim.ts — all game state + `update(state, dt)`. NO DOM, NO canvas, NO input.
// Given the same seed and the same sequence of player actions, this evolves
// identically. Randomness comes only from `state.rng`.

import { CONFIG, PALETTE, TRAIN_SPEED } from './config';
import { createRng, weightedIndex } from './rng';
import {
  SHAPES,
  type GameState,
  type Line,
  type Passenger,
  type RoutingTable,
  type ShapeType,
  type Station,
  type Train,
} from './types';

// ----------------------------------------------------------------------------
// small helpers
// ----------------------------------------------------------------------------

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function stationById(state: GameState, id: number): Station {
  // ≤12 stations; linear scan is cheaper than maintaining a map.
  for (const s of state.stations) if (s.id === id) return s;
  throw new Error(`station ${id} not found`);
}

function lineById(state: GameState, id: number): Line | undefined {
  for (const l of state.lines) if (l.id === id) return l;
  return undefined;
}

export function routeDist(state: GameState, shape: ShapeType, stationId: number): number {
  const d = state.routing[shape].get(stationId);
  return d === undefined ? Infinity : d;
}

// ----------------------------------------------------------------------------
// construction
// ----------------------------------------------------------------------------

export function createGame(seed: number = CONFIG.defaultSeed): GameState {
  const rng = createRng(seed);
  const state: GameState = {
    time: 0,
    paused: false,
    status: 'playing',
    stations: [],
    lines: [],
    availableLineSlots: CONFIG.lineSlots,
    delivered: 0,
    strain: 0,
    maxStrain: CONFIG.maxStrain,
    spawnAccumulator: 0,
    nextStationAt: CONFIG.newStationEvery,
    baseTrainCapacity: CONFIG.trainCapacity,
    baseTrainSpeed: TRAIN_SPEED,
    draft: null,
    nextRushAt: CONFIG.rushHourEvery,
    routing: emptyRouting(),
    nextStationId: 1,
    nextPassengerId: 1,
    nextLineId: 1,
    nextTrainId: 1,
    rngSeed: seed,
    rng,
    totalSpawned: 0,
    stuckBoardings: 0,
    deliveredLatencySum: 0,
  };

  // Start stations get guaranteed-distinct shapes (one of each) so there is
  // real transport demand from t=0; positions are still seeded-random.
  for (let i = 0; i < CONFIG.startStations; i++) {
    placeStation(state, SHAPES[i % SHAPES.length]);
  }
  recomputeRouting(state);
  return state;
}

function emptyRouting(): RoutingTable {
  return { circle: new Map(), triangle: new Map(), square: new Map() };
}

/** Rejection-sampled placement that respects min spacing. Returns the station or null. */
function placeStation(state: GameState, forcedShape?: ShapeType): Station | null {
  const { worldW, worldH, margin, minStationSpacing } = CONFIG;
  for (let attempt = 0; attempt < 80; attempt++) {
    const x = state.rng.range(margin, worldW - margin);
    const y = state.rng.range(margin, worldH - margin);
    let ok = true;
    for (const s of state.stations) {
      if (Math.hypot(s.x - x, s.y - y) < minStationSpacing) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const shape = forcedShape ?? state.rng.pick(SHAPES);
    const station: Station = {
      id: state.nextStationId++,
      x,
      y,
      shape,
      queue: [],
      overflowTimer: 0,
    };
    state.stations.push(station);
    return station;
  }
  return null;
}

// ----------------------------------------------------------------------------
// routing: multi-source BFS, per shape, over the union of all line adjacencies.
// Transfers are free because a shared station is a single graph node.
// ----------------------------------------------------------------------------

export function recomputeRouting(state: GameState): void {
  const adj = new Map<number, number[]>();
  const ensure = (id: number) => {
    let a = adj.get(id);
    if (!a) {
      a = [];
      adj.set(id, a);
    }
    return a;
  };
  for (const s of state.stations) ensure(s.id);
  for (const line of state.lines) {
    const ids = line.stationIds;
    for (let i = 0; i + 1 < ids.length; i++) {
      const a = ids[i];
      const b = ids[i + 1];
      ensure(a).push(b);
      ensure(b).push(a);
    }
  }

  const routing = emptyRouting();
  for (const shape of SHAPES) {
    const dist = routing[shape];
    const queue: number[] = [];
    for (const s of state.stations) {
      if (s.shape === shape) {
        dist.set(s.id, 0);
        queue.push(s.id);
      }
    }
    // BFS
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      const d = dist.get(cur)!;
      for (const nb of adj.get(cur) ?? []) {
        if (!dist.has(nb)) {
          dist.set(nb, d + 1);
          queue.push(nb);
        }
      }
    }
  }
  state.routing = routing;
}

// ----------------------------------------------------------------------------
// trains
// ----------------------------------------------------------------------------

function makeTrain(state: GameState, line: Line): Train {
  const first = stationById(state, line.stationIds[0]);
  const next = stationById(state, line.stationIds[1] ?? line.stationIds[0]);
  return {
    id: state.nextTrainId++,
    lineId: line.id,
    edgeIndex: 0,
    t: 0,
    dir: 1,
    phase: 'moving',
    dwell: 0,
    capacity: state.baseTrainCapacity,
    speed: state.baseTrainSpeed,
    passengers: [],
    px: first.x,
    py: first.y,
    ppx: first.x,
    ppy: first.y,
    angle: Math.atan2(next.y - first.y, next.x - first.x),
  };
}

/** Where a train heads after dwelling at its current arrival station (ping-pong). */
function departHop(n: number, edgeIndex: number, dir: 1 | -1): {
  edgeIndex: number;
  dir: 1 | -1;
  targetIndex: number;
} {
  const arrivedIndex = dir > 0 ? edgeIndex + 1 : edgeIndex;
  if (dir > 0) {
    if (arrivedIndex >= n - 1) return { edgeIndex: n - 2, dir: -1, targetIndex: n - 2 };
    return { edgeIndex: edgeIndex + 1, dir: 1, targetIndex: edgeIndex + 2 };
  } else {
    if (arrivedIndex <= 0) return { edgeIndex: 0, dir: 1, targetIndex: 1 };
    return { edgeIndex: edgeIndex - 1, dir: -1, targetIndex: edgeIndex - 1 };
  }
}

function setTrainWorldPos(state: GameState, line: Line, train: Train): void {
  const a = stationById(state, line.stationIds[train.edgeIndex]);
  const b = stationById(state, line.stationIds[train.edgeIndex + 1]);
  const from = train.dir > 0 ? a : b;
  const to = train.dir > 0 ? b : a;
  train.px = lerp(from.x, to.x, train.t);
  train.py = lerp(from.y, to.y, train.t);
}

/**
 * Board/alight at the station a train just reached.
 *
 * Decision rule (greedy but with a full-pass look-ahead): a passenger boards or
 * stays aboard iff riding this train in its CURRENT travel direction (until it
 * next reverses) will reach some station strictly closer (fewer graph hops) to
 * their destination shape. We look ahead to the end of the line in the train's
 * direction rather than just one hop — otherwise passengers refuse trains that
 * are heading the right way along a line but whose very next stop happens not to
 * reduce distance, and pile up until the anti-deadlock fallback fires.
 */
function serviceStation(state: GameState, line: Line, train: Train): void {
  const n = line.stationIds.length;
  const arrivedIndex = train.dir > 0 ? train.edgeIndex + 1 : train.edgeIndex;
  const station = stationById(state, line.stationIds[arrivedIndex]);
  const here = station.id;

  // Indices this train will visit in its current pass (after departing here),
  // in travel direction, until it reverses at a line end.
  const dir = departHop(n, train.edgeIndex, train.dir).dir;
  const upcoming: number[] = [];
  for (let idx = arrivedIndex + dir; idx >= 0 && idx < n; idx += dir) upcoming.push(idx);

  const distHere = (shape: ShapeType) => routeDist(state, shape, here);
  const bestUpCache: Partial<Record<ShapeType, number>> = {};
  const bestUpcoming = (shape: ShapeType): number => {
    let v = bestUpCache[shape];
    if (v === undefined) {
      v = Infinity;
      for (const idx of upcoming) {
        const d = routeDist(state, shape, line.stationIds[idx]);
        if (d < v) v = d;
      }
      bestUpCache[shape] = v;
    }
    return v;
  };

  // 1) Alight: delivered here, or transfer (this pass won't get them closer).
  const transferAlighters: Passenger[] = [];
  train.passengers = train.passengers.filter((p) => {
    if (station.shape === p.destShape) {
      state.delivered += 1; // delivered!
      state.deliveredLatencySum += state.time - p.spawnedAt;
      return false;
    }
    if (bestUpcoming(p.destShape) < distHere(p.destShape)) return true; // stays aboard, pass makes progress
    transferAlighters.push(p); // get off to wait for a better line / the return pass
    return false;
  });

  // 2) Board the people who were already waiting (FIFO), up to capacity.
  const remaining: Passenger[] = [];
  for (const p of station.queue) {
    if (train.passengers.length >= train.capacity) {
      remaining.push(p);
      continue;
    }
    const progresses = bestUpcoming(p.destShape) < distHere(p.destShape);
    const stuck = state.time - p.spawnedAt > CONFIG.stuckPassengerFallback;
    if (progresses || stuck) {
      if (!progresses && stuck) state.stuckBoardings += 1;
      train.passengers.push(p);
    } else {
      remaining.push(p);
    }
  }
  // Transfer-alighters wait at this station for the next train (after current riders).
  station.queue = remaining.concat(transferAlighters);
}

// ----------------------------------------------------------------------------
// player actions (callable any time — including while paused)
// ----------------------------------------------------------------------------

export function canCreateLine(state: GameState): boolean {
  return state.lines.length < state.availableLineSlots;
}

function nextFreeColor(state: GameState): string {
  const used = new Set(state.lines.map((l) => l.color));
  for (const c of PALETTE.lineColors) if (!used.has(c)) return c;
  return PALETTE.lineColors[state.lines.length % PALETTE.lineColors.length];
}

/** Color a freshly created line would receive — for the input layer's drag preview. */
export function previewNewLineColor(state: GameState): string {
  return nextFreeColor(state);
}

export function createLine(state: GameState, aId: number, bId: number): Line | null {
  if (!canCreateLine(state) || aId === bId) return null;
  const line: Line = {
    id: state.nextLineId++,
    color: nextFreeColor(state),
    stationIds: [aId, bId],
    trains: [],
  };
  line.trains.push(makeTrain(state, line));
  state.lines.push(line);
  recomputeRouting(state);
  return line;
}

/** Extend a line by attaching `newStationId` at whichever endpoint the gesture started from. */
export function extendLine(
  state: GameState,
  lineId: number,
  fromEndpointId: number,
  newStationId: number,
): boolean {
  const line = lineById(state, lineId);
  if (!line) return false;
  if (line.stationIds.includes(newStationId)) return false; // no dupes / self-cross
  const ids = line.stationIds;
  if (fromEndpointId === ids[0]) {
    ids.unshift(newStationId);
    // Prepending shifts every index up by one — keep trains consistent.
    for (const tr of line.trains) tr.edgeIndex += 1;
  } else if (fromEndpointId === ids[ids.length - 1]) {
    ids.push(newStationId);
  } else {
    return false; // not an endpoint
  }
  recomputeRouting(state);
  return true;
}

export function deleteLine(state: GameState, lineId: number): boolean {
  const idx = state.lines.findIndex((l) => l.id === lineId);
  if (idx < 0) return false;
  state.lines.splice(idx, 1);
  recomputeRouting(state);
  return true;
}

/** Endpoints of every line, for the input layer's draw-vs-extend decision. */
export function endpointLinesAt(state: GameState, stationId: number): Line[] {
  return state.lines.filter(
    (l) => l.stationIds[0] === stationId || l.stationIds[l.stationIds.length - 1] === stationId,
  );
}

export function restart(seed: number): GameState {
  return createGame(seed);
}

// ----------------------------------------------------------------------------
// spawning
// ----------------------------------------------------------------------------

export function currentSpawnInterval(time: number): number {
  const k = Math.min(1, Math.max(0, time / CONFIG.rampDurationSeconds));
  return lerp(CONFIG.spawnIntervalStart, CONFIG.spawnIntervalEnd, k);
}

function spawnPassenger(state: GameState): void {
  if (state.stations.length === 0) return;
  const station = state.rng.pick(state.stations);
  const others = SHAPES.filter((s) => s !== station.shape);
  // Bias destination toward shapes that are FAR from here (creates pressure).
  const weights = others.map((sh) => {
    const d = routeDist(state, sh, station.id);
    const dd = Number.isFinite(d) ? Math.min(d, 10) : 3; // unreachable => neutral baseline
    return 1 + CONFIG.farDestBias * dd;
  });
  const destShape = others[weightedIndex(state.rng, weights)];
  station.queue.push({
    id: state.nextPassengerId++,
    destShape,
    spawnedAt: state.time,
  });
  state.totalSpawned += 1;
}

// ----------------------------------------------------------------------------
// M4: minimal draft stub (data-driven, throwaway scaffolding)
// ----------------------------------------------------------------------------

interface DraftEffect {
  id: string;
  title: string;
  desc: string;
  applicable: (s: GameState) => boolean;
  apply: (s: GameState) => void;
}

function busiestLine(state: GameState): Line | null {
  let best: Line | null = null;
  let bestLoad = -1;
  for (const line of state.lines) {
    let load = 0;
    for (const t of line.trains) load += t.passengers.length;
    for (const id of line.stationIds) load += stationById(state, id).queue.length;
    if (load > bestLoad) {
      bestLoad = load;
      best = line;
    }
  }
  return best;
}

const DRAFT_EFFECTS: DraftEffect[] = [
  {
    id: 'addTrain',
    title: '+1 Train',
    desc: 'Add a train to your busiest line.',
    applicable: (s) => s.lines.length > 0,
    apply: (s) => {
      const line = busiestLine(s);
      if (line) line.trains.push(makeTrain(s, line));
    },
  },
  {
    id: 'lineSlot',
    title: '+1 Line',
    desc: 'Unlock another line slot.',
    applicable: (s) => s.availableLineSlots < PALETTE.lineColors.length,
    apply: (s) => {
      s.availableLineSlots += 1;
    },
  },
  {
    id: 'capacity',
    title: '+2 Capacity',
    desc: 'Every train (current and future) carries +2.',
    applicable: () => true,
    apply: (s) => {
      s.baseTrainCapacity += 2;
      for (const l of s.lines) for (const t of l.trains) t.capacity += 2;
    },
  },
  {
    id: 'maxStrain',
    title: '+1 Max Strain',
    desc: 'Raise the failure threshold by one pip.',
    applicable: () => true,
    apply: (s) => {
      s.maxStrain += 1;
    },
  },
  {
    id: 'speed',
    title: '+25% Speed',
    desc: 'Every train (current and future) runs faster.',
    applicable: () => true,
    apply: (s) => {
      s.baseTrainSpeed *= 1.25;
      for (const l of s.lines) for (const t of l.trains) t.speed *= 1.25;
    },
  },
];

function buildDraft(state: GameState): void {
  const pool = DRAFT_EFFECTS.filter((e) => e.applicable(state));
  // Fisher–Yates over a copy, take up to 3.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = state.rng.int(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const chosen = pool.slice(0, 3);
  if (chosen.length === 0) return;
  state.draft = { options: chosen.map((e) => ({ id: e.id, title: e.title, desc: e.desc })) };
  state.paused = true; // auto-pause for "rush hour"
}

export function applyDraftOption(state: GameState, optionId: string): void {
  if (!state.draft) return;
  const effect = DRAFT_EFFECTS.find((e) => e.id === optionId);
  if (effect) effect.apply(state);
  state.draft = null;
  state.paused = false;
  state.nextRushAt = state.time + CONFIG.rushHourEvery;
}

// ----------------------------------------------------------------------------
// the tick
// ----------------------------------------------------------------------------

/** Recompute every train's interpolation position from current geometry. */
function refreshTrainPositions(state: GameState, snapshot: boolean): void {
  for (const line of state.lines) {
    for (const tr of line.trains) {
      setTrainWorldPos(state, line, tr);
      if (snapshot) {
        tr.ppx = tr.px;
        tr.ppy = tr.py;
      }
    }
  }
}

export function update(state: GameState, dt: number): void {
  // Frozen states: keep render positions correct (geometry may have changed
  // while paused via editing) and collapse interpolation so nothing drifts.
  if (state.paused || state.status === 'gameover') {
    refreshTrainPositions(state, true);
    return;
  }

  // Snapshot previous positions for render interpolation, then advance.
  for (const line of state.lines) {
    for (const tr of line.trains) {
      tr.ppx = tr.px;
      tr.ppy = tr.py;
    }
  }

  state.time += dt;

  // --- new stations ---
  while (state.time >= state.nextStationAt && state.stations.length < CONFIG.maxStations) {
    const added = placeStation(state);
    state.nextStationAt += CONFIG.newStationEvery;
    if (added) recomputeRouting(state);
  }

  // --- passenger spawns (ramped) ---
  state.spawnAccumulator += dt;
  let interval = currentSpawnInterval(state.time);
  while (state.spawnAccumulator >= interval) {
    spawnPassenger(state);
    state.spawnAccumulator -= interval;
    interval = currentSpawnInterval(state.time);
  }

  // --- trains ---
  for (const line of state.lines) {
    const n = line.stationIds.length;
    for (const tr of line.trains) {
      if (tr.phase === 'moving') {
        const a = stationById(state, line.stationIds[tr.edgeIndex]);
        const b = stationById(state, line.stationIds[tr.edgeIndex + 1]);
        const from = tr.dir > 0 ? a : b;
        const to = tr.dir > 0 ? b : a;
        const len = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
        tr.angle = Math.atan2(to.y - from.y, to.x - from.x);
        tr.t += (tr.speed * dt) / len;
        if (tr.t >= 1) {
          tr.t = 1;
          serviceStation(state, line, tr);
          tr.phase = 'dwelling';
          tr.dwell = CONFIG.stationDwellSeconds;
        }
      } else {
        tr.dwell -= dt;
        if (tr.dwell <= 0) {
          const hop = departHop(n, tr.edgeIndex, tr.dir);
          tr.edgeIndex = hop.edgeIndex;
          tr.dir = hop.dir;
          tr.t = 0;
          tr.phase = 'moving';
        }
      }
      setTrainWorldPos(state, line, tr);
    }
  }

  // --- crowding / overflow / strain ---
  for (const st of state.stations) {
    if (st.queue.length > CONFIG.stationCapacity) {
      st.overflowTimer += dt;
      if (st.overflowTimer >= CONFIG.overflowToFail) {
        state.strain += 1;
        st.overflowTimer = 0;
        if (CONFIG.dropToCapacityOnOverflow && st.queue.length > CONFIG.stationCapacity) {
          st.queue.length = CONFIG.stationCapacity; // shed newest excess (relief + clear feedback)
        }
      }
    } else {
      st.overflowTimer = Math.max(0, st.overflowTimer - dt);
    }
  }

  // --- failure ---
  if (state.strain >= state.maxStrain) {
    state.status = 'gameover';
  }

  // --- M4: rush-hour draft ---
  if (CONFIG.enableDraft && state.status === 'playing' && !state.draft && state.time >= state.nextRushAt) {
    buildDraft(state);
  }
}
