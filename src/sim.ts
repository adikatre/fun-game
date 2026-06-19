// sim.ts — all game state + update(state, dt). NO DOM / canvas / input.
// Deterministic: same seed + same player actions ⇒ identical evolution.
// Randomness flows only through state.rng.

import { CONFIG } from './config';
import { createRng } from './rng';
import type {
  Aircraft,
  AircraftType,
  DraftState,
  GameState,
  Runway,
  Vec,
} from './types';

// ----------------------------------------------------------------------------
// math helpers
// ----------------------------------------------------------------------------

const TAU = Math.PI * 2;
const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const deg = (d: number) => (d * Math.PI) / 180;

function normAngle(a: number): number {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}
function angleDiff(from: number, to: number): number {
  return normAngle(to - from);
}
function turnToward(cur: number, target: number, maxStep: number): number {
  const d = angleDiff(cur, target);
  if (Math.abs(d) <= maxStep) return normAngle(target);
  return normAngle(cur + Math.sign(d) * maxStep);
}

// ----------------------------------------------------------------------------
// construction
// ----------------------------------------------------------------------------

function buildRunways(): Runway[] {
  return CONFIG.runways.map((r, i) => {
    const dir = deg(r.headingDeg);
    const dx = Math.cos(dir);
    const dy = Math.sin(dir);
    const approachEnd: Vec = { x: r.cx - dx * (r.length / 2), y: r.cy - dy * (r.length / 2) };
    const rollEnd: Vec = { x: r.cx + dx * (r.length / 2), y: r.cy + dy * (r.length / 2) };
    const finalEntry: Vec = {
      x: approachEnd.x - dx * CONFIG.approachLength,
      y: approachEnd.y - dy * CONFIG.approachLength,
    };
    return {
      id: i + 1,
      name: r.name,
      dir,
      cx: r.cx,
      cy: r.cy,
      length: r.length,
      width: 18,
      approachEnd,
      rollEnd,
      finalEntry,
      occupiedUntil: 0,
    };
  });
}

export function createGame(seed: number = CONFIG.defaultSeed): GameState {
  const rng = createRng(seed);
  return {
    time: 0,
    paused: false,
    status: 'playing',
    aircraft: [],
    runways: buildRunways(),
    incidents: 0,
    handled: 0,
    cash: 0,
    nearMisses: 0,
    goArounds: 0,
    diversions: 0,
    spawnAccumulator: 0,
    nextSpawnInterval: CONFIG.firstSpawnAt,
    nextRushAt: CONFIG.rampDurationSeconds + CONFIG.rushWaveEvery,
    totalSpawned: 0,
    conflicts: new Map(),
    crashFx: [],
    showHint: true,
    draft: null,
    nextAircraftId: 1,
    rngSeed: seed,
    rng,
  };
}

export function restart(seed: number): GameState {
  return createGame(seed);
}

// ----------------------------------------------------------------------------
// spawning
// ----------------------------------------------------------------------------

const CALLSIGNS = ['DAL', 'UAL', 'AAL', 'SWA', 'JBU', 'FDX', 'UPS', 'NKS', 'ASA', 'VIR'];

function spawnInterval(time: number): number {
  return lerp(CONFIG.spawnIntervalStart, CONFIG.spawnIntervalEnd, clamp01(time / CONFIG.rampDurationSeconds));
}
function maxAirborne(time: number): number {
  return Math.min(CONFIG.maxAirborneCap, CONFIG.maxAirborneStart + Math.floor(time / CONFIG.maxAirborneGrowEvery));
}
function heavyChance(time: number): number {
  return lerp(CONFIG.heavyChanceStart, CONFIG.heavyChanceEnd, clamp01(time / CONFIG.rampDurationSeconds));
}
function emergencyChance(time: number): number {
  if (time < CONFIG.emergencyStartAt) return 0;
  return lerp(0, CONFIG.emergencyChanceEnd, clamp01((time - CONFIG.emergencyStartAt) / CONFIG.rampDurationSeconds));
}

function makeAircraft(state: GameState): Aircraft {
  const rng = state.rng;
  // Spawn on a ring around the airport. Early traffic enters from the approach
  // side (east, angle ~0) within a narrow spread; the spread widens to all
  // directions as the shift ramps up.
  const spread = deg(
    lerp(CONFIG.spawnAngleSpreadStartDeg, CONFIG.spawnAngleSpreadEndDeg, clamp01(state.time / CONFIG.rampDurationSeconds)),
  );
  const ang = (rng.next() - 0.5) * 2 * spread; // centered on east
  const radius = 540;
  let x = CONFIG.airportX + Math.cos(ang) * radius;
  let y = CONFIG.airportY + Math.sin(ang) * radius;
  x = Math.max(18, Math.min(CONFIG.worldW - 18, x));
  y = Math.max(18, Math.min(CONFIG.worldH - 18, y));
  // aim at a spread point near the airport (not the exact center) to avoid a
  // self-colliding knot of converging traffic.
  const aimX = CONFIG.airportX + (rng.next() - 0.5) * 2 * CONFIG.spawnAimSpread;
  const aimY = CONFIG.airportY + (rng.next() - 0.5) * 2 * CONFIG.spawnAimSpread;
  const heading = Math.atan2(aimY - y, aimX - x);

  const type: AircraftType =
    rng.next() < heavyChance(state.time) ? 'heavy' : rng.next() < 0.5 ? 'small' : 'medium';
  const t = CONFIG.types[type];
  const callsign = `${rng.pick(CALLSIGNS)}${100 + rng.int(899)}`;

  let fuel = CONFIG.fuelSecondsStart + (rng.next() - 0.5) * 2 * CONFIG.fuelVariance;
  let emergency: Aircraft['emergency'] = 'none';
  const eRoll = rng.next();
  if (eRoll < emergencyChance(state.time)) {
    if (rng.next() < 0.5) {
      emergency = 'medical';
    } else {
      fuel = CONFIG.lowFuelAt * 0.8; // arrives already critical
      emergency = 'lowFuel';
    }
  }

  return {
    id: state.nextAircraftId++,
    callsign,
    type,
    x,
    y,
    heading,
    speed: t.speed,
    cruiseSpeed: t.speed,
    turnRate: deg(t.turnRateDeg),
    wake: t.wake,
    altitude: 3200 + Math.floor(rng.next() * 1600),
    fuelSeconds: fuel,
    emergency,
    phase: 'inbound',
    waypoints: [],
    assignedRunwayId: null,
    holdCenter: null,
    age: 0,
    landTimer: 0,
    conflict: false,
    conflictPartner: null,
    trail: [],
    px: x,
    py: y,
    ppx: x,
    ppy: y,
  };
}

// ----------------------------------------------------------------------------
// player actions (callable any time, including while paused)
// ----------------------------------------------------------------------------

function findAircraft(state: GameState, id: number): Aircraft | undefined {
  return state.aircraft.find((a) => a.id === id);
}
function findRunway(state: GameState, id: number): Runway | undefined {
  return state.runways.find((r) => r.id === id);
}

export function assignApproach(state: GameState, aircraftId: number, runwayId: number): boolean {
  const ac = findAircraft(state, aircraftId);
  const rw = findRunway(state, runwayId);
  if (!ac || !rw || ac.phase === 'landing') return false;
  ac.phase = 'approach';
  ac.assignedRunwayId = rw.id;
  ac.holdCenter = null;
  ac.waypoints = [{ ...rw.finalEntry }, { ...rw.approachEnd }];
  return true;
}

export function setPath(state: GameState, aircraftId: number, points: Vec[]): boolean {
  const ac = findAircraft(state, aircraftId);
  if (!ac || ac.phase === 'landing') return false;
  ac.waypoints = points.map((p) => ({ ...p }));
  ac.assignedRunwayId = null;
  ac.holdCenter = null;
  ac.phase = ac.waypoints.length > 0 ? 'vectoring' : 'inbound';
  return true;
}

export function toggleHold(state: GameState, aircraftId: number): boolean {
  const ac = findAircraft(state, aircraftId);
  if (!ac || ac.phase === 'landing') return false;
  if (ac.phase === 'holding') {
    ac.phase = 'inbound';
    ac.holdCenter = null;
  } else {
    ac.holdCenter = {
      x: ac.x + Math.cos(ac.heading) * CONFIG.holdRadius,
      y: ac.y + Math.sin(ac.heading) * CONFIG.holdRadius,
    };
    ac.phase = 'holding';
    ac.assignedRunwayId = null;
    ac.waypoints = [];
  }
  return true;
}

// ----------------------------------------------------------------------------
// per-aircraft movement
// ----------------------------------------------------------------------------

function goAround(state: GameState, ac: Aircraft): void {
  ac.phase = 'inbound';
  ac.assignedRunwayId = null;
  ac.waypoints = [];
  state.goArounds += 1;
  state.cash -= CONFIG.goAroundPenalty;
}

function attemptLanding(state: GameState, ac: Aircraft, rw: Runway): void {
  const aligned = Math.abs(angleDiff(ac.heading, rw.dir)) <= deg(CONFIG.alignToleranceDeg);
  const free = state.time >= rw.occupiedUntil;
  if (free && (aligned || ac.emergency !== 'none')) {
    ac.phase = 'landing';
    ac.heading = rw.dir;
    ac.x = rw.approachEnd.x;
    ac.y = rw.approachEnd.y;
    ac.speed = ac.cruiseSpeed * CONFIG.approachSpeedFactor * 0.7;
    ac.landTimer = CONFIG.rolloutSeconds + (ac.emergency === 'medical' ? CONFIG.medicalAssistSeconds : 0);
    rw.occupiedUntil = state.time + ac.landTimer;
  } else if (ac.emergency === 'medical') {
    // medical can't go around — re-fly the approach (tight retry)
    ac.waypoints = [{ ...rw.finalEntry }, { ...rw.approachEnd }];
  } else {
    goAround(state, ac);
  }
}

/** Steer + advance one aircraft. Returns a disposition for the caller to act on. */
type Disposition = 'none' | 'handled' | 'diverted';

function stepAircraft(state: GameState, ac: Aircraft, dt: number): Disposition {
  ac.age += dt;
  if (ac.phase !== 'landing') {
    ac.fuelSeconds -= dt;
    if (ac.fuelSeconds <= CONFIG.lowFuelAt && ac.emergency === 'none') ac.emergency = 'lowFuel';
  }

  // --- steering (set heading) + speed target ---
  if (ac.phase === 'approach') {
    ac.speed = ac.cruiseSpeed * CONFIG.approachSpeedFactor;
    const wp = ac.waypoints[0];
    if (wp) ac.heading = turnToward(ac.heading, Math.atan2(wp.y - ac.y, wp.x - ac.x), ac.turnRate * dt);
    // cosmetic descent along the corridor
    const rw = ac.assignedRunwayId != null ? findRunway(state, ac.assignedRunwayId) : undefined;
    if (rw) {
      const d = dist(ac.x, ac.y, rw.approachEnd.x, rw.approachEnd.y);
      ac.altitude = Math.round(3000 * clamp01(d / CONFIG.approachLength));
    }
  } else if (ac.phase === 'holding' && ac.holdCenter) {
    const c = ac.holdCenter;
    const toC = Math.atan2(c.y - ac.y, c.x - ac.x);
    const r = dist(ac.x, ac.y, c.x, c.y);
    let desired = toC + Math.PI / 2;
    if (r < CONFIG.holdRadius * 0.85) desired -= 0.4;
    else if (r > CONFIG.holdRadius * 1.15) desired += 0.4;
    ac.heading = turnToward(ac.heading, desired, ac.turnRate * dt);
    ac.speed = ac.cruiseSpeed;
  } else if (ac.phase === 'vectoring') {
    const wp = ac.waypoints[0];
    if (wp) ac.heading = turnToward(ac.heading, Math.atan2(wp.y - ac.y, wp.x - ac.x), ac.turnRate * dt);
    else ac.phase = 'inbound';
    ac.speed = ac.cruiseSpeed;
  } else if (ac.phase === 'landing') {
    ac.speed = Math.max(8, ac.speed - 26 * dt); // decelerate on rollout
  } else {
    // inbound: hold current heading
    ac.speed = ac.cruiseSpeed;
  }

  // --- advance position ---
  ac.x += Math.cos(ac.heading) * ac.speed * dt;
  ac.y += Math.sin(ac.heading) * ac.speed * dt;
  ac.px = ac.x;
  ac.py = ac.y;

  // --- trail ---
  const last = ac.trail[ac.trail.length - 1];
  if (!last || dist(last.x, last.y, ac.x, ac.y) > 9) {
    ac.trail.push({ x: ac.x, y: ac.y });
    if (ac.trail.length > 16) ac.trail.shift();
  }

  // --- post-move: landing rollout, waypoint capture, diversion ---
  if (ac.phase === 'landing') {
    ac.landTimer -= dt;
    if (ac.landTimer <= 0) return 'handled';
    return 'none';
  }

  const wp = ac.waypoints[0];
  if (wp && dist(ac.x, ac.y, wp.x, wp.y) < CONFIG.arriveRadius) {
    ac.waypoints.shift();
    if (ac.waypoints.length === 0 && ac.phase === 'approach' && ac.assignedRunwayId != null) {
      const rw = findRunway(state, ac.assignedRunwayId);
      if (rw) attemptLanding(state, ac, rw);
    }
  }

  if (
    ac.age > 2 &&
    (ac.x < -32 || ac.x > CONFIG.worldW + 32 || ac.y < -32 || ac.y > CONFIG.worldH + 32)
  ) {
    return 'diverted';
  }
  return 'none';
}

// ----------------------------------------------------------------------------
// economy on a safe landing
// ----------------------------------------------------------------------------

function payForLanding(state: GameState, ac: Aircraft): void {
  const base = CONFIG.types[ac.type].salary;
  const onTime = Math.round(CONFIG.onTimeBonusMax * clamp01(1 - ac.age / CONFIG.onTimeWindow));
  state.cash += base + onTime;
  state.handled += 1;
}

// ----------------------------------------------------------------------------
// the tick
// ----------------------------------------------------------------------------

function snapshotInterp(state: GameState): void {
  for (const ac of state.aircraft) {
    ac.ppx = ac.px;
    ac.ppy = ac.py;
  }
}

export function update(state: GameState, dt: number): void {
  if (state.paused || state.status === 'gameover') {
    // freeze interpolation (geometry may have changed via paused editing)
    for (const ac of state.aircraft) {
      ac.px = ac.x;
      ac.py = ac.y;
      ac.ppx = ac.x;
      ac.ppy = ac.y;
    }
    return;
  }

  snapshotInterp(state);
  state.time += dt;

  // crash effects decay
  for (const fx of state.crashFx) fx.ttl -= dt;
  state.crashFx = state.crashFx.filter((f) => f.ttl > 0);

  // --- spawning ---
  state.spawnAccumulator += dt;
  while (state.spawnAccumulator >= state.nextSpawnInterval) {
    state.spawnAccumulator -= state.nextSpawnInterval;
    if (state.aircraft.length < maxAirborne(state.time)) {
      state.aircraft.push(makeAircraft(state));
      state.totalSpawned += 1;
    }
    state.nextSpawnInterval = spawnInterval(state.time);
  }
  // rush waves after the ramp
  if (state.time >= state.nextRushAt) {
    for (let k = 0; k < CONFIG.rushWaveSize; k++) {
      if (state.aircraft.length < CONFIG.maxAirborneCap) {
        state.aircraft.push(makeAircraft(state));
        state.totalSpawned += 1;
      }
    }
    state.nextRushAt += CONFIG.rushWaveEvery;
  }

  // --- per-aircraft step ---
  const remove = new Set<number>();
  for (const ac of state.aircraft) {
    const d = stepAircraft(state, ac, dt);
    if (d === 'handled') {
      payForLanding(state, ac);
      remove.add(ac.id);
    } else if (d === 'diverted') {
      state.diversions += 1;
      state.cash -= CONFIG.diversionPenalty;
      remove.add(ac.id);
    } else if (ac.fuelSeconds <= 0 && ac.phase !== 'landing') {
      state.incidents += 1;
      state.cash -= CONFIG.crashPenalty;
      state.crashFx.push({ x: ac.x, y: ac.y, ttl: 1.5 });
      remove.add(ac.id);
    }
  }

  // --- separation / conflict / collisions ---
  for (const ac of state.aircraft) {
    ac.conflict = false;
    ac.conflictPartner = null;
  }
  const airborne = state.aircraft.filter((a) => a.phase !== 'landing' && !remove.has(a.id));
  const next = new Map<string, number>();
  const crashPairs: [Aircraft, Aircraft][] = [];
  for (let i = 0; i < airborne.length; i++) {
    for (let j = i + 1; j < airborne.length; j++) {
      const a = airborne[i];
      const b = airborne[j];
      const sep = CONFIG.separationMin * Math.max(a.wake, b.wake);
      const dd = dist(a.x, a.y, b.x, b.y);
      const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
      const prevT = state.conflicts.get(key) ?? 0;
      if (dd < sep) {
        const t = prevT + dt;
        next.set(key, t);
        a.conflict = b.conflict = true;
        if (a.conflictPartner == null) a.conflictPartner = b.id;
        if (b.conflictPartner == null) b.conflictPartner = a.id;
        if (t >= CONFIG.conflictToCrash) crashPairs.push([a, b]);
      } else if (prevT > 0) {
        // separation regained before collision => near miss
        state.nearMisses += 1;
        state.cash -= CONFIG.nearMissPenalty;
      }
    }
  }
  state.conflicts = next;

  for (const [a, b] of crashPairs) {
    if (remove.has(a.id) || remove.has(b.id)) continue;
    remove.add(a.id);
    remove.add(b.id);
    state.incidents += 1;
    state.cash -= CONFIG.crashPenalty;
    state.crashFx.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, ttl: 1.5 });
  }

  if (remove.size > 0) state.aircraft = state.aircraft.filter((a) => !remove.has(a.id));

  // --- failure ---
  if (state.incidents >= CONFIG.crashesToFire) state.status = 'gameover';

  // --- onboarding hint ---
  if (state.handled > 0 || state.time > 22) state.showHint = false;
}

// ----------------------------------------------------------------------------
// M4-style end-of-shift bonus draft (optional scaffolding; off by default flow)
// ----------------------------------------------------------------------------

export function openDraft(state: GameState): void {
  const opts: DraftState['options'] = [
    { id: 'fuel', title: 'Fuel Reserves', desc: 'Inbound traffic arrives with more fuel.' },
    { id: 'turnaround', title: 'Fast Turnaround', desc: 'Runways clear quicker after landings.' },
    { id: 'spacing', title: 'Wake Waiver', desc: 'Tighter separation allowed (riskier, denser).' },
  ];
  state.draft = { options: opts };
  state.paused = true;
}
export function applyDraftOption(state: GameState, _optionId: string): void {
  // intentionally minimal for the prototype; effects wired in A4 if pursued
  state.draft = null;
  state.paused = false;
}
