// sim.ts — all game state + update(state, dt). NO DOM / canvas / input.
// Deterministic: same seed + same player actions ⇒ identical evolution.
// Randomness flows only through state.rng.

import { CONFIG } from './config';
import { createRng } from './rng';
import {
  AIRBORNE_PHASES,
  type Aircraft,
  type AircraftType,
  type DraftState,
  type Gate,
  type GameState,
  type Runway,
  type Vec,
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

/** Two-digit runway number from a landing heading (screen angle, 0 = east). */
function runwayNumber(headingDeg: number): string {
  const compass = (((450 - headingDeg) % 360) + 360) % 360;
  let n = Math.round(compass / 10);
  if (n === 0) n = 36;
  return n.toString().padStart(2, '0');
}
const swapSide = (s: 'L' | 'R'): 'L' | 'R' => (s === 'L' ? 'R' : 'L');

function buildRunways(): Runway[] {
  return CONFIG.runways.map((r, i) => {
    const makeEnd = (headingDeg: number, side: 'L' | 'R') => {
      const dir = deg(headingDeg);
      const dx = Math.cos(dir);
      const dy = Math.sin(dir);
      const threshold: Vec = { x: r.cx - dx * (r.length / 2), y: r.cy - dy * (r.length / 2) };
      const finalEntry: Vec = {
        x: threshold.x - dx * CONFIG.approachLength,
        y: threshold.y - dy * CONFIG.approachLength,
      };
      return { name: runwayNumber(headingDeg) + side, dir, threshold, finalEntry };
    };
    return {
      id: i + 1,
      cx: r.cx,
      cy: r.cy,
      length: r.length,
      width: 18,
      // primary end (headingDeg) + reciprocal end (headingDeg + 180, L/R swapped)
      ends: [makeEnd(r.headingDeg, r.side), makeEnd(r.headingDeg + 180, swapSide(r.side))] as [
        Runway['ends'][0],
        Runway['ends'][1],
      ],
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
    gates: CONFIG.gates.map((g, i) => ({ id: i + 1, x: g.x, y: g.y, occupantId: null })),
    incidents: 0,
    handled: 0,
    departed: 0,
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
    assignedEnd: null,
    holdCenter: null,
    gateId: null,
    taxiTarget: null,
    turnaround: 0,
    age: 0,
    landTimer: 0,
    landDecel: 0,
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

const isAirborneArrival = (ac: Aircraft) =>
  ac.phase === 'inbound' || ac.phase === 'holding' || ac.phase === 'approach';
const isDispatchable = (ac: Aircraft) =>
  ac.phase === 'readyDep' || ac.phase === 'taxiOut' || ac.phase === 'holdShort';

/** Clear a plane to land on a specific END of a runway (the side the player chose). */
export function assignApproach(state: GameState, aircraftId: number, runwayId: number, end: 0 | 1): boolean {
  const ac = findAircraft(state, aircraftId);
  const rw = findRunway(state, runwayId);
  if (!ac || !rw || !isAirborneArrival(ac)) return false;
  const re = rw.ends[end];
  ac.phase = 'approach';
  ac.assignedRunwayId = rw.id;
  ac.assignedEnd = end;
  ac.holdCenter = null;
  ac.waypoints = [{ ...re.finalEntry }, { ...re.threshold }];
  return true;
}

/** Dispatch a parked/ready plane for takeoff in a runway END's direction. */
export function dispatchDeparture(state: GameState, aircraftId: number, runwayId: number, end: 0 | 1): boolean {
  const ac = findAircraft(state, aircraftId);
  const rw = findRunway(state, runwayId);
  if (!ac || !rw || !isDispatchable(ac)) return false;
  freeGate(state, ac); // pushed back; the gate opens up
  ac.assignedRunwayId = rw.id;
  ac.assignedEnd = end;
  ac.phase = 'taxiOut';
  // line up at the OPPOSITE end and roll toward `end` (take off in end.dir)
  ac.taxiTarget = { ...rw.ends[(1 - end) as 0 | 1].threshold };
  return true;
}

/** Unified "send to this runway side": land if airborne, take off if parked. */
export function commandToRunway(state: GameState, aircraftId: number, runwayId: number, end: 0 | 1): boolean {
  const ac = findAircraft(state, aircraftId);
  if (!ac) return false;
  if (isAirborneArrival(ac)) return assignApproach(state, aircraftId, runwayId, end);
  if (isDispatchable(ac)) return dispatchDeparture(state, aircraftId, runwayId, end);
  return false;
}

export function toggleHold(state: GameState, aircraftId: number): boolean {
  const ac = findAircraft(state, aircraftId);
  if (!ac || !isAirborneArrival(ac)) return false;
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
    ac.assignedEnd = null;
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
  ac.assignedEnd = null;
  ac.waypoints = [];
  state.goArounds += 1;
  state.cash -= CONFIG.goAroundPenalty;
}

function attemptLanding(state: GameState, ac: Aircraft, rw: Runway, end: 0 | 1): void {
  const re = rw.ends[end];
  const aligned = Math.abs(angleDiff(ac.heading, re.dir)) <= deg(CONFIG.alignToleranceDeg);
  const free = state.time >= rw.occupiedUntil;
  if (free && (aligned || ac.emergency !== 'none')) {
    ac.phase = 'landing';
    ac.heading = re.dir;
    ac.x = re.threshold.x;
    ac.y = re.threshold.y;
    const v0 = ac.cruiseSpeed * CONFIG.approachSpeedFactor * 0.7;
    ac.speed = v0;
    // Decelerate from v0 to taxiSpeed over the full runway length (physics: vf²=v0²+2ad)
    const vf = CONFIG.taxiSpeed;
    const d = rw.length;
    ac.landDecel = (v0 * v0 - vf * vf) / (2 * d); // positive magnitude; applied as subtraction
    // Estimate rollout time for runway occupancy: t = (v0 - vf) / decel
    const rolloutTime = (v0 - vf) / ac.landDecel;
    const medExtra = ac.emergency === 'medical' ? CONFIG.medicalAssistSeconds : 0;
    ac.landTimer = rolloutTime + medExtra;
    rw.occupiedUntil = state.time + ac.landTimer;
  } else if (ac.emergency === 'medical') {
    // medical can't go around — re-fly the approach (tight retry)
    ac.waypoints = [{ ...re.finalEntry }, { ...re.threshold }];
  } else {
    goAround(state, ac);
  }
}

// --- ground helpers ---

function freeGate(state: GameState, ac: Aircraft): void {
  if (ac.gateId == null) return;
  const g = state.gates.find((gg) => gg.id === ac.gateId);
  if (g && g.occupantId === ac.id) g.occupantId = null;
  ac.gateId = null;
}
function nearestFreeGate(state: GameState, ac: Aircraft): Gate | null {
  let best: Gate | null = null;
  let bd = Infinity;
  for (const g of state.gates) {
    if (g.occupantId !== null) continue;
    const d = dist(ac.x, ac.y, g.x, g.y);
    if (d < bd) {
      bd = d;
      best = g;
    }
  }
  return best;
}
/** A shared runway is clear for a departure only if no arrival is landing/short-final. */
function runwayClearForDeparture(state: GameState, rw: Runway): boolean {
  if (state.time < rw.occupiedUntil) return false;
  for (const a of state.aircraft) {
    if (a.assignedRunwayId !== rw.id) continue;
    if (a.phase === 'landing') return false;
    if (a.phase === 'approach' && a.assignedEnd != null) {
      const th = rw.ends[a.assignedEnd].threshold;
      if (dist(a.x, a.y, th.x, th.y) < CONFIG.shortFinalGuard) return false;
    }
  }
  return true;
}
function groundBlockedAhead(state: GameState, ac: Aircraft): boolean {
  for (const o of state.aircraft) {
    if (o.id === ac.id || AIRBORNE_PHASES.includes(o.phase)) continue;
    const dx = o.x - ac.x;
    const dy = o.y - ac.y;
    if (Math.hypot(dx, dy) < CONFIG.groundSeparation && dx * Math.cos(ac.heading) + dy * Math.sin(ac.heading) > 0) {
      return true;
    }
  }
  return false;
}

/** Rolled out: pay for the arrival, then head for a gate (or the ramp if full). */
function beginTaxiIn(state: GameState, ac: Aircraft): void {
  payForLanding(state, ac); // arrival salary + on-time bonus, handled++
  ac.emergency = 'none'; // resolved on the ground
  ac.assignedRunwayId = null;
  ac.assignedEnd = null;
  ac.phase = 'taxiIn';
  const g = nearestFreeGate(state, ac);
  if (g) {
    g.occupantId = ac.id;
    ac.gateId = g.id;
    ac.taxiTarget = { x: g.x, y: g.y };
  } else {
    ac.gateId = null;
    ac.taxiTarget = { ...CONFIG.rampWait };
  }
}

const GROUND_ARRIVE = 9;

/** Steer + advance one aircraft. Returns a disposition for the caller to act on. */
type Disposition = 'none' | 'diverted' | 'departed';

function stepAircraft(state: GameState, ac: Aircraft, dt: number): Disposition {
  ac.age += dt;
  const airborne = AIRBORNE_PHASES.includes(ac.phase);
  if (airborne) {
    ac.fuelSeconds -= dt;
    if (ac.fuelSeconds <= CONFIG.lowFuelAt && ac.emergency === 'none') ac.emergency = 'lowFuel';
  }

  // --- steering (set heading) + speed target ---
  if (ac.phase === 'approach') {
    // Slow to half-speed on the final segment (last waypoint = threshold) for smoother capture
    ac.speed = ac.waypoints.length <= 1
      ? ac.cruiseSpeed * CONFIG.approachSpeedFactor * 0.6
      : ac.cruiseSpeed * CONFIG.approachSpeedFactor;
    const wp = ac.waypoints[0];
    if (wp) ac.heading = turnToward(ac.heading, Math.atan2(wp.y - ac.y, wp.x - ac.x), ac.turnRate * dt);
    const rw = ac.assignedRunwayId != null ? findRunway(state, ac.assignedRunwayId) : undefined;
    if (rw && ac.assignedEnd != null) {
      const th = rw.ends[ac.assignedEnd].threshold;
      ac.altitude = Math.round(3000 * clamp01(dist(ac.x, ac.y, th.x, th.y) / CONFIG.approachLength));
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
  } else if (ac.phase === 'landing') {
    ac.speed = Math.max(CONFIG.taxiSpeed, ac.speed - ac.landDecel * dt);
  } else if (ac.phase === 'departing') {
    ac.speed = Math.min(ac.cruiseSpeed, ac.speed + 40 * dt);
    ac.altitude = Math.min(6000, ac.altitude + 1300 * dt);
  } else if (ac.phase === 'takeoff') {
    ac.speed = Math.min(ac.cruiseSpeed, ac.speed + 45 * dt);
  } else if (ac.phase === 'taxiIn' || ac.phase === 'taxiOut') {
    const t = ac.taxiTarget;
    if (t) {
      ac.heading = Math.atan2(t.y - ac.y, t.x - ac.x);
      ac.speed = groundBlockedAhead(state, ac) ? 0 : CONFIG.taxiSpeed;
    } else ac.speed = 0;
  } else if (ac.phase === 'atGate' || ac.phase === 'readyDep' || ac.phase === 'holdShort') {
    ac.speed = 0;
  } else {
    ac.speed = ac.cruiseSpeed; // inbound flies straight
  }

  // --- advance position ---
  ac.x += Math.cos(ac.heading) * ac.speed * dt;
  ac.y += Math.sin(ac.heading) * ac.speed * dt;
  ac.px = ac.x;
  ac.py = ac.y;

  // --- trail (air only) ---
  if (airborne || ac.phase === 'takeoff') {
    const last = ac.trail[ac.trail.length - 1];
    if (!last || dist(last.x, last.y, ac.x, ac.y) > 9) {
      ac.trail.push({ x: ac.x, y: ac.y });
      if (ac.trail.length > 16) ac.trail.shift();
    }
  } else if (ac.trail.length) {
    ac.trail.length = 0;
  }

  // --- post-move transitions ---
  if (ac.phase === 'landing') {
    ac.landTimer -= dt;
    // Exit when aircraft reaches the far end of the runway (position-based)
    if (ac.assignedRunwayId != null && ac.assignedEnd != null) {
      const rw = findRunway(state, ac.assignedRunwayId);
      if (rw) {
        const farEnd = rw.ends[(1 - ac.assignedEnd) as 0 | 1].threshold;
        if (dist(ac.x, ac.y, farEnd.x, farEnd.y) < 20) {
          beginTaxiIn(state, ac);
          return 'none';
        }
      }
    }
    // Fallback: timer (handles edge cases like medical-extended occupancy)
    if (ac.landTimer <= 0) beginTaxiIn(state, ac);
    return 'none';
  }
  if (ac.phase === 'takeoff') {
    ac.landTimer -= dt;
    if (ac.landTimer <= 0) ac.phase = 'departing';
    return 'none';
  }
  if (ac.phase === 'atGate') {
    ac.turnaround -= dt;
    if (ac.turnaround <= 0) {
      ac.phase = 'readyDep';
      ac.fuelSeconds = CONFIG.fuelSecondsStart; // refuelled at the gate
    }
    return 'none';
  }
  if (ac.phase === 'holdShort' && ac.assignedRunwayId != null && ac.assignedEnd != null) {
    const rw = findRunway(state, ac.assignedRunwayId);
    if (rw && runwayClearForDeparture(state, rw)) {
      const re = rw.ends[ac.assignedEnd];
      ac.phase = 'takeoff';
      ac.heading = re.dir;
      ac.speed = 16;
      ac.landTimer = CONFIG.takeoffRollSeconds;
      rw.occupiedUntil = state.time + CONFIG.takeoffRollSeconds;
    }
    return 'none';
  }
  if ((ac.phase === 'taxiIn' || ac.phase === 'taxiOut') && ac.taxiTarget) {
    if (dist(ac.x, ac.y, ac.taxiTarget.x, ac.taxiTarget.y) < GROUND_ARRIVE) {
      if (ac.phase === 'taxiOut') {
        ac.phase = 'holdShort';
        ac.taxiTarget = null;
      } else if (ac.gateId != null) {
        ac.phase = 'atGate';
        ac.turnaround = CONFIG.turnaroundSeconds;
        ac.taxiTarget = null;
      } else {
        // idling on the ramp — grab a gate as soon as one opens
        const g = nearestFreeGate(state, ac);
        if (g) {
          g.occupantId = ac.id;
          ac.gateId = g.id;
          ac.taxiTarget = { x: g.x, y: g.y };
        }
      }
    }
    return 'none';
  }

  // approach: waypoint capture -> landing attempt
  // Use a larger capture radius for the threshold (final waypoint) to prevent overshoots
  const wp = ac.waypoints[0];
  const captureR = (ac.phase === 'approach' && ac.waypoints.length === 1) ? 40 : CONFIG.arriveRadius;
  if (wp && dist(ac.x, ac.y, wp.x, wp.y) < captureR) {
    ac.waypoints.shift();
    if (ac.waypoints.length === 0 && ac.phase === 'approach' && ac.assignedRunwayId != null && ac.assignedEnd != null) {
      const rw = findRunway(state, ac.assignedRunwayId);
      if (rw) attemptLanding(state, ac, rw, ac.assignedEnd);
    }
  }

  // airspace exits: a climbing departure leaves successfully; an unmanaged arrival diverts
  const off = ac.x < -32 || ac.x > CONFIG.worldW + 32 || ac.y < -32 || ac.y > CONFIG.worldH + 32;
  if (off && ac.phase === 'departing') return 'departed';
  if (off && ac.phase === 'inbound' && ac.age > 2) return 'diverted';
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
    if (d === 'departed') {
      state.cash += CONFIG.departureSalary;
      state.departed += 1;
      remove.add(ac.id);
    } else if (d === 'diverted') {
      state.diversions += 1;
      state.cash -= CONFIG.diversionPenalty;
      remove.add(ac.id);
    } else if (ac.fuelSeconds <= 0 && AIRBORNE_PHASES.includes(ac.phase)) {
      state.incidents += 1;
      state.cash -= CONFIG.crashPenalty;
      state.crashFx.push({ x: ac.x, y: ac.y, ttl: 1.5 });
      remove.add(ac.id);
    }
  }

  // --- separation / conflict / collisions (airborne traffic only) ---
  for (const ac of state.aircraft) {
    ac.conflict = false;
    ac.conflictPartner = null;
  }
  const airborne = state.aircraft.filter((a) => AIRBORNE_PHASES.includes(a.phase) && !remove.has(a.id));
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
