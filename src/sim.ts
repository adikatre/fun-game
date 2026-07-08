// sim.ts — all game state + update(state, dt). NO DOM / canvas / input.
// Deterministic: same seed + same player actions ⇒ identical evolution.
// Randomness flows only through state.rng. The sim reports what happened each
// tick through state.events (drained by main for audio/fx) — output only, so
// determinism is unaffected.

import { CONFIG, dayDifficulty } from './config';
import { createRng } from './rng';
import {
  AIRBORNE_PHASES,
  type Aircraft,
  type AircraftType,
  type Gate,
  type GameState,
  type Grade,
  type Runway,
  type RunwayEnd,
  type Vec,
  type WeatherCell,
} from './types';
import {
  type UpgradeState,
  extraRunwayCount,
  extraGateCount,
  fuelMultiplier,
  turnaroundMultiplier,
  hasWeatherRadar,
  radarRangeMultiplier,
  createUpgradeState,
} from './upgrades';

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
const swapSide = (s: string): string => (s === 'L' ? 'R' : s === 'R' ? 'L' : s);

/**
 * Build all active runways: base runways from CONFIG.runways, plus any extra
 * expansion runways unlocked by the player's upgrade state.
 */
export function buildRunways(upgradeState: UpgradeState): Runway[] {
  const extraCount = extraRunwayCount(upgradeState);
  const layouts = [
    ...CONFIG.runways,
    ...CONFIG.runwayExpansionSlots.slice(0, extraCount),
  ];

  return layouts.map((r, i) => {
    const angleRad = deg(r.headingDeg);
    const makeEnd = (headingDeg: number, side: string) => {
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
      width: 28,
      angle: angleRad,
      ends: [makeEnd(r.headingDeg, r.side), makeEnd(r.headingDeg + 180, swapSide(r.side))] as [
        Runway['ends'][0],
        Runway['ends'][1],
      ],
      occupiedUntil: 0,
    };
  });
}

export function createGame(
  seed: number = CONFIG.defaultSeed,
  day = 1,
  tutorial = false,
  upgradeState: UpgradeState = createUpgradeState(),
): GameState {
  const rng = createRng(seed);

  // Build gates: base 6 + extra from upgrades
  const extraGates = extraGateCount(upgradeState);
  const gateLayouts = [
    ...CONFIG.gates,
    ...CONFIG.gateExpansionSlots.slice(0, extraGates),
  ];

  const diff = dayDifficulty(day);

  return {
    time: 0,
    paused: false,
    status: tutorial ? 'tutorial' : 'playing',
    day,
    shiftLength: CONFIG.shiftSeconds,
    grade: null,
    aircraft: [],
    runways: buildRunways(upgradeState),
    gates: gateLayouts.map((g, i) => ({ id: i + 1, x: g.x, y: g.y, occupantId: null, useCount: 0 })),
    weather: [],
    incidents: 0,
    handled: 0,
    departed: 0,
    cash: 0,
    nearMisses: 0,
    goArounds: 0,
    diversions: 0,
    streak: 0,
    bestStreak: 0,
    spawnAccumulator: 0,
    nextSpawnInterval: CONFIG.firstSpawnAt,
    nextRushAt: diff.rampDurationSeconds + CONFIG.rushWaveEvery,
    totalSpawned: 0,
    finalRushFired: false,
    weatherAccumulator: 0,
    nextWeatherId: 1,
    conflicts: new Map(),
    predicted: [],
    crashFx: [],
    events: [],
    showHint: true,
    nextAircraftId: 1,
    rngSeed: seed,
    rng,
    adDoubleUsed: false,
    adContinueUsed: false,
  };
}

export function restart(
  seed: number,
  day = 1,
  tutorial = false,
  upgradeState: UpgradeState = createUpgradeState(),
): GameState {
  return createGame(seed, day, tutorial, upgradeState);
}

/** Leave the tutorial / menu screen and start the shift (QA aids may call from menu). */
export function startShift(state: GameState): void {
  if (state.status === 'tutorial' || state.status === 'menu') state.status = 'playing';
}

// ----------------------------------------------------------------------------
// spawning
// ----------------------------------------------------------------------------

const CALLSIGNS = ['DAL', 'UAL', 'AAL', 'SWA', 'JBU', 'FDX', 'UPS', 'NKS', 'ASA', 'VIR'];

function inFinalRush(state: GameState): boolean {
  return state.time >= state.shiftLength - CONFIG.finalRushLead;
}
function spawnInterval(state: GameState): number {
  const diff = dayDifficulty(state.day);
  let iv =
    lerp(diff.spawnIntervalStart, diff.spawnIntervalEnd, clamp01(state.time / diff.rampDurationSeconds)) *
    diff.intervalFactor;
  if (inFinalRush(state)) iv *= CONFIG.finalRushIntervalFactor;
  return iv;
}
function maxAirborne(time: number, day: number): number {
  const diff = dayDifficulty(day);
  return Math.min(CONFIG.maxAirborneCap, diff.maxAirborneStart + Math.floor(time / CONFIG.maxAirborneGrowEvery));
}
function heavyChance(time: number, day: number): number {
  const ramp = dayDifficulty(day).rampDurationSeconds;
  return lerp(CONFIG.heavyChanceStart, CONFIG.heavyChanceEnd, clamp01(time / ramp));
}
function emergencyChance(time: number, day: number): number {
  const diff = dayDifficulty(day);
  if (time < diff.emergencyStartAt) return 0;
  return lerp(0, CONFIG.emergencyChanceEnd, clamp01((time - diff.emergencyStartAt) / diff.rampDurationSeconds));
}

function makeAircraft(state: GameState, fuelMult: number, radarRangeMult: number): Aircraft {
  const rng = state.rng;
  // Spawn on a ring around the airport. Early traffic enters from the approach
  // side (east, angle ~0) within a narrow spread; the spread widens to all
  // directions as the shift ramps up.
  const spread = deg(
    lerp(
      CONFIG.spawnAngleSpreadStartDeg,
      CONFIG.spawnAngleSpreadEndDeg,
      clamp01(state.time / dayDifficulty(state.day).rampDurationSeconds),
    ),
  );
  const ang = (rng.next() - 0.5) * 2 * spread; // centered on east
  const radius = 1000 * radarRangeMult;
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
    rng.next() < heavyChance(state.time, state.day) ? 'heavy' : rng.next() < 0.5 ? 'small' : 'medium';
  const t = CONFIG.types[type];
  const callsign = `${rng.pick(CALLSIGNS)}${100 + rng.int(899)}`;

  let fuel = (CONFIG.fuelSecondsStart + (rng.next() - 0.5) * 2 * CONFIG.fuelVariance) * fuelMult;
  let emergency: Aircraft['emergency'] = 'none';
  const eRoll = rng.next();
  if (eRoll < emergencyChance(state.time, state.day)) {
    if (rng.next() < 0.5) {
      emergency = 'medical';
    } else {
      fuel = CONFIG.lowFuelAt * 0.8; // arrives already critical
      emergency = 'lowFuel';
    }
  }
  if (emergency !== 'none') state.events.push({ kind: 'emergency', emergency, callsign });

  return {
    id: state.nextAircraftId++,
    callsign,
    type,
    x,
    y,
    heading,
    speed: t.speed,
    cruiseSpeed: t.speed,
    speedMult: 1,
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
    manualHold: false,
    gateId: null,
    taxiTarget: null,
    turnaround: 0,
    age: 0,
    landTimer: 0,
    landDecel: 0,
    conflict: false,
    conflictPartner: null,
    conflictTimeLeft: 0,
    warn: false,
    trail: [],
    crossingRunwayId: null,
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

function maxWake(): number {
  let w = 0;
  for (const k of Object.keys(CONFIG.types) as AircraftType[]) {
    w = Math.max(w, CONFIG.types[k].wake);
  }
  return w;
}

/** Min center-to-center distance so two hold orbits never violate separation. */
function holdMinCenterSep(): number {
  return 2 * CONFIG.holdRadius + CONFIG.separationMin * maxWake();
}

function clampHoldCenter(c: Vec): Vec {
  const margin = CONFIG.holdRadius + 20;
  return {
    x: Math.max(margin, Math.min(CONFIG.worldW - margin, c.x)),
    y: Math.max(margin, Math.min(CONFIG.worldH - margin, c.y)),
  };
}

function defaultHoldCenter(ac: Aircraft): Vec {
  return {
    x: ac.x + Math.cos(ac.heading) * CONFIG.holdRadius,
    y: ac.y + Math.sin(ac.heading) * CONFIG.holdRadius,
  };
}

/** Pick an orbit fix that stays separated from every aircraft already holding. */
function pickHoldCenter(state: GameState, ac: Aircraft): Vec {
  const minDist = holdMinCenterSep();
  const existing = state.aircraft
    .filter((a) => a.id !== ac.id && a.phase === 'holding' && a.holdCenter)
    .map((a) => a.holdCenter!);

  const farEnough = (c: Vec) => existing.every((e) => dist(c.x, c.y, e.x, e.y) >= minDist);

  const MAX_SLOTS = 16;
  for (let slot = 0; slot < MAX_SLOTS; slot++) {
    const angle = ac.heading + deg(slot * CONFIG.holdStackAngleDeg);
    const radius = CONFIG.holdRadius + slot * CONFIG.holdStackRadius;
    const candidate = clampHoldCenter({
      x: ac.x + Math.cos(angle) * radius,
      y: ac.y + Math.sin(angle) * radius,
    });
    if (farEnough(candidate)) return candidate;
  }

  // Fallback: push away from the nearest existing hold center.
  if (existing.length > 0) {
    const def = defaultHoldCenter(ac);
    let nearest = existing[0];
    let nd = dist(def.x, def.y, nearest.x, nearest.y);
    for (const e of existing) {
      const d = dist(def.x, def.y, e.x, e.y);
      if (d < nd) {
        nd = d;
        nearest = e;
      }
    }
    const away = Math.atan2(def.y - nearest.y, def.x - nearest.x);
    return clampHoldCenter({
      x: nearest.x + Math.cos(away) * minDist,
      y: nearest.y + Math.sin(away) * minDist,
    });
  }

  return clampHoldCenter(defaultHoldCenter(ac));
}

/** How many aircraft are currently on approach to a specific runway end. */
export function approachCountOnCorridor(
  state: GameState,
  runwayId: number,
  end: 0 | 1,
  excludeId?: number,
): number {
  return state.aircraft.filter(
    (a) =>
      a.id !== excludeId &&
      a.phase === 'approach' &&
      a.assignedRunwayId === runwayId &&
      a.assignedEnd === end,
  ).length;
}

/** Signed along-track position relative to a runway end's threshold (>0 = past it). */
function alongTrack(ac: Aircraft, re: RunwayEnd): number {
  return (ac.x - re.threshold.x) * Math.cos(re.dir) + (ac.y - re.threshold.y) * Math.sin(re.dir);
}
/** Signed lateral offset from the extended centerline of a runway end. */
function crossTrack(ac: Aircraft, re: RunwayEnd): number {
  return -(ac.x - re.threshold.x) * Math.sin(re.dir) + (ac.y - re.threshold.y) * Math.cos(re.dir);
}

/**
 * Build an approach path suited to where THIS plane currently is.
 * A plane already established inbound (near the centerline, far enough out,
 * pointed the right way) goes straight in: [finalEntry, threshold].
 * Everyone else first flies to a join fix on the extended centerline:
 * [joinFix, finalEntry, threshold]. The fix sits far enough out to leave room
 * to align, and never so close to the plane that it falls inside the turning
 * circle (which makes the plane orbit it forever).
 */
function buildApproachWaypoints(re: RunwayEnd, ac: Aircraft): Vec[] {
  const dx = Math.cos(re.dir);
  const dy = Math.sin(re.dir);
  const distToRun = -alongTrack(ac, re);
  const cross = crossTrack(ac, re);
  const finalLeg = [{ ...re.finalEntry }, { ...re.threshold }];

  const established =
    distToRun > CONFIG.approachLength * 0.7 &&
    Math.abs(cross) < 40 &&
    Math.abs(angleDiff(ac.heading, re.dir)) < deg(45);
  if (established) return finalLeg;

  // Join at the plane's own distance out when it's beyond the corridor (no
  // doubling back to a fixed IAF), clamped to sane bounds.
  const minOut = CONFIG.approachLength + CONFIG.approachIafExtra;
  const maxOut = CONFIG.approachLength + 3 * CONFIG.approachIafExtra;
  let joinDist = Math.max(minOut, Math.min(distToRun, maxOut));
  // Keep the fix outside the plane's turn circle: push it further out if needed.
  const minJoin = CONFIG.approachMinJoinDist;
  if (Math.abs(cross) < minJoin) {
    const push = Math.sqrt(minJoin * minJoin - cross * cross);
    if (Math.abs(joinDist - distToRun) < push) joinDist = distToRun + push;
  }
  const joinFix = { x: re.threshold.x - dx * joinDist, y: re.threshold.y - dy * joinDist };
  return [joinFix, ...finalLeg];
}

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
  ac.waypoints = buildApproachWaypoints(re, ac);
  state.events.push({ kind: 'assign', x: ac.x, y: ac.y });
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
  state.events.push({ kind: 'dispatch', x: ac.x, y: ac.y });
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
    state.events.push({ kind: 'unhold' });
  } else {
    ac.holdCenter = pickHoldCenter(state, ac);
    ac.phase = 'holding';
    ac.assignedRunwayId = null;
    ac.assignedEnd = null;
    ac.waypoints = [];
    state.events.push({ kind: 'hold' });
  }
  return true;
}

/**
 * Authorize a plane waiting at a taxiway-runway crossing to proceed.
 * The player accepts the risk of crossing an active runway.
 */
export function authorizeCrossing(state: GameState, aircraftId: number): boolean {
  const ac = findAircraft(state, aircraftId);
  if (!ac || ac.phase !== 'waitCross') return false;

  // Determine which direction the plane was heading before it stopped:
  // If it has a gateId or taxiTarget near a gate, it's taxiIn; otherwise taxiOut.
  if (ac.gateId != null || (ac.assignedRunwayId == null && ac.assignedEnd == null)) {
    ac.phase = 'taxiIn';
  } else {
    ac.phase = 'taxiOut';
  }

  state.events.push({ kind: 'crossRunway', x: ac.x, y: ac.y });
  return true;
}
export function commandTakeoff(state: GameState, aircraftId: number): boolean {
  const ac = findAircraft(state, aircraftId);
  if (!ac || ac.phase !== 'lineUpWait' || ac.assignedRunwayId == null) return false;
  const rw = findRunway(state, ac.assignedRunwayId);
  if (!rw) return false;
  ac.phase = 'takeoff';
  ac.speed = 16;
  ac.landTimer = CONFIG.takeoffRollSeconds;
  rw.occupiedUntil = Math.max(rw.occupiedUntil, state.time + CONFIG.takeoffRollSeconds);
  state.events.push({ kind: 'takeoffClearance', x: ac.x, y: ac.y });
  return true;
}

export function toggleManualHold(state: GameState, aircraftId: number): boolean {
  const ac = findAircraft(state, aircraftId);
  if (!ac || (ac.phase !== 'taxiIn' && ac.phase !== 'taxiOut')) return false;
  ac.manualHold = !ac.manualHold;
  state.events.push({ kind: 'manualHold', hold: ac.manualHold, x: ac.x, y: ac.y });
  return true;
}

export function commandGoAround(state: GameState, aircraftId: number): boolean {
  const ac = findAircraft(state, aircraftId);
  if (!ac || (ac.phase !== 'approach' && ac.phase !== 'landing')) return false;
  // If we're already decelerating hard on the runway, we might not be able to abort, but we allow it for now.
  goAround(state, ac, false);
  return true;
}

/** Step an airborne plane's commanded speed up or down (spacing tool). */
export function adjustAirborneSpeed(state: GameState, aircraftId: number, faster: boolean): boolean {
  const ac = findAircraft(state, aircraftId);
  if (!ac || !AIRBORNE_PHASES.includes(ac.phase)) return false;
  const delta = faster ? CONFIG.speedMultStep : -CONFIG.speedMultStep;
  const next = Math.max(CONFIG.speedMultMin, Math.min(CONFIG.speedMultMax, ac.speedMult + delta));
  if (next === ac.speedMult) return false;
  ac.speedMult = next;
  state.events.push({ kind: 'speedAdjust', faster, mult: next, x: ac.x, y: ac.y });
  return true;
}

function commandedCruiseSpeed(ac: Aircraft): number {
  return ac.cruiseSpeed * ac.speedMult;
}

// ----------------------------------------------------------------------------
// per-aircraft movement
// ----------------------------------------------------------------------------

function goAround(state: GameState, ac: Aircraft, penalize = true): void {
  ac.phase = 'inbound';
  ac.assignedRunwayId = null;
  ac.assignedEnd = null;
  ac.waypoints = [];
  state.goArounds += 1;
  const amount = penalize ? -CONFIG.goAroundPenalty : 0;
  if (penalize) state.cash -= CONFIG.goAroundPenalty;
  state.events.push({ kind: 'goAround', amount, x: ac.x, y: ac.y });
}

function attemptLanding(state: GameState, ac: Aircraft, rw: Runway, end: 0 | 1): void {
  const re = rw.ends[end];
  const aligned =
    Math.abs(angleDiff(ac.heading, re.dir)) <= deg(CONFIG.alignToleranceDeg) &&
    Math.abs(crossTrack(ac, re)) <= 40;
  const someoneLinedUp = state.aircraft.some((a) => a.phase === 'lineUpWait' && a.assignedRunwayId === rw.id);
  const free = state.time >= rw.occupiedUntil && !someoneLinedUp;
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
    ac.waypoints = buildApproachWaypoints(re, ac);
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
// Distance alone can permanently starve a gate that's never geometrically closest
// from any rollout end (e.g. a middle gate flanked by two outer ones). Add a small
// per-use penalty so a heavily-used gate loses its edge to an idle neighbor over time.
const GATE_FAIRNESS_PENALTY = 40;
function nearestFreeGate(state: GameState, ac: Aircraft): Gate | null {
  let best: Gate | null = null;
  let bestScore = Infinity;
  for (const g of state.gates) {
    if (g.occupantId !== null) continue;
    const score = dist(ac.x, ac.y, g.x, g.y) + g.useCount * GATE_FAIRNESS_PENALTY;
    if (score < bestScore) {
      bestScore = score;
      best = g;
    }
  }
  if (best) best.useCount += 1;
  return best;
}
/** A shared runway is clear for a departure only if no arrival is landing/short-final. */

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

/** Streak-scaled pay multiplier for safe operations. */
function streakMult(state: GameState): number {
  return Math.min(CONFIG.streakMaxMult, 1 + state.streak * CONFIG.streakStep);
}
function breakStreak(state: GameState): void {
  state.streak = 0;
}

/** Rolled out: pay for the arrival, then head for a gate (or the ramp if full). */
function beginTaxiIn(state: GameState, ac: Aircraft): void {
  // arrival salary + on-time bonus, scaled by the safe-operation streak
  const base = CONFIG.types[ac.type].salary;
  const onTime = Math.round(CONFIG.onTimeBonusMax * clamp01(1 - ac.age / CONFIG.onTimeWindow));
  const amount = Math.round((base + onTime) * streakMult(state));
  state.cash += amount;
  state.handled += 1;
  state.streak += 1;
  state.bestStreak = Math.max(state.bestStreak, state.streak);
  state.events.push({ kind: 'land', amount, x: ac.x, y: ac.y, streak: state.streak });

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

// ----------------------------------------------------------------------------
// taxiway-runway crossing detection
// ----------------------------------------------------------------------------

/**
 * Check if a taxiing plane (taxiIn or taxiOut) is approaching a runway it
 * needs to cross. If so, set the plane to waitCross. The plane waits until
 * the player calls authorizeCrossing().
 *
 * A plane "needs to cross" a runway if:
 *   1. The runway is NOT the plane's assigned runway (don't stop for your own runway)
 *   2. The plane's taxi path crosses the runway strip
 *   3. The plane is close enough to the runway center to warrant stopping
 *
 * We check if the plane is within crossingHoldShortDist of a runway center
 * and heading toward it.
 */
function checkTaxiCrossing(state: GameState, ac: Aircraft): boolean {
  // Only applies to taxiing planes
  if (ac.phase !== 'taxiIn' && ac.phase !== 'taxiOut') return false;
  // Already waiting to cross — don't re-check
  if (ac.crossingRunwayId != null) return false;

  for (const rw of state.runways) {
    // Don't stop for your own assigned runway
    if (rw.id === ac.assignedRunwayId) continue;

    // Check if plane is close to the runway strip
    const dToCenter = dist(ac.x, ac.y, rw.cx, rw.cy);
    if (dToCenter > CONFIG.crossingHoldShortDist + rw.length / 2) continue;

    // Project the plane's position onto the runway axis to see if the plane
    // is heading toward the strip and within hold-short distance.
    const cosA = Math.cos(rw.angle);
    const sinA = Math.sin(rw.angle);
    const relX = ac.x - rw.cx;
    const relY = ac.y - rw.cy;

    // Signed distance along the runway axis and perpendicular to it
    const alongRunway = relX * cosA + relY * sinA;
    const perpToRunway = Math.abs(-relX * sinA + relY * cosA);

    // Is the plane close to the runway strip (within the strip + margin)?
    if (Math.abs(alongRunway) > rw.length / 2 + 10) continue;
    // Is the plane approaching from outside the strip?
    if (perpToRunway > CONFIG.crossingHoldShortDist) continue;
    if (perpToRunway < rw.width / 2 + 2) continue; // Already on the strip — let it pass through

    // Is the plane heading toward the runway (dot product of heading with perpendicular direction)?
    const headingDx = Math.cos(ac.heading);
    const headingDy = Math.sin(ac.heading);
    const perpDirX = -sinA;
    const perpDirY = cosA;
    // Check both perpendicular directions
    const dotPerp = headingDx * perpDirX + headingDy * perpDirY;
    const toRunwaySign = (-relX * sinA + relY * cosA) > 0 ? -1 : 1;
    const headingTowardRunway = dotPerp * toRunwaySign > 0.1;
    if (!headingTowardRunway) continue;

    // Stop and wait for player authorization
    ac.phase = 'waitCross';
    ac.crossingRunwayId = rw.id;
    ac.speed = 0;
    return true;
  }

  return false;
}

/**
 * Check if a taxiing/crossing plane has cleared the runway it was crossing.
 * Clear the crossingRunwayId once the plane is past it.
 */
function checkCrossingCleared(ac: Aircraft, state: GameState): void {
  if (ac.crossingRunwayId == null) return;
  // Only clear when actively taxiing (after authorization)
  if (ac.phase === 'waitCross') return;

  const rw = findRunway(state, ac.crossingRunwayId);
  if (!rw) {
    ac.crossingRunwayId = null;
    return;
  }

  const relX = ac.x - rw.cx;
  const relY = ac.y - rw.cy;
  const sinA = Math.sin(rw.angle);
  const cosA = Math.cos(rw.angle);
  const perpToRunway = Math.abs(-relX * sinA + relY * cosA);

  // Once the plane is far enough from the runway center perpendicular, it has cleared
  if (perpToRunway > CONFIG.crossingClearDist) {
    ac.crossingRunwayId = null;
  }
}

// ----------------------------------------------------------------------------
// ground crash detection
// ----------------------------------------------------------------------------

/**
 * Check if a ground plane is physically ON a runway strip that is currently
 * occupied by a landing or takeoff plane → CRASH.
 */
function isOnRunwayStrip(px: number, py: number, rw: Runway): boolean {
  // Transform point into the runway's local frame
  const cosA = Math.cos(rw.angle);
  const sinA = Math.sin(rw.angle);
  const relX = px - rw.cx;
  const relY = py - rw.cy;
  const along = relX * cosA + relY * sinA;
  const perp = -relX * sinA + relY * cosA;
  return Math.abs(along) <= rw.length / 2 + 5 && Math.abs(perp) <= rw.width / 2 + 5;
}

function checkGroundCrash(state: GameState, ac: Aircraft): boolean {
  // Only check taxiing/crossing planes that are moving
  const isGroundMoving =
    ac.phase === 'taxiIn' || ac.phase === 'taxiOut' ||
    (ac.phase === 'waitCross' && ac.speed > 0);
  if (!isGroundMoving && ac.crossingRunwayId == null) return false;
  // When a plane has been authorized to cross (phase reverted to taxiIn/taxiOut
  // but crossingRunwayId still set), check the crossing runway
  if (ac.phase === 'taxiIn' || ac.phase === 'taxiOut') {
    // Check all runways for active operations
    for (const rw of state.runways) {
      if (!isOnRunwayStrip(ac.x, ac.y, rw)) continue;
      // Is there a landing or takeoff plane on this runway right now?
      for (const other of state.aircraft) {
        if (other.id === ac.id) continue;
        if ((other.phase === 'landing' || other.phase === 'takeoff') && other.assignedRunwayId === rw.id) {
          return true; // CRASH — ground plane on active runway
        }
      }
    }
  }
  return false;
}

// ----------------------------------------------------------------------------
// weather system
// ----------------------------------------------------------------------------

function spawnWeatherCell(state: GameState): void {
  const rng = state.rng;

  // Spawn from an edge of the map
  const edge = rng.int(4); // 0=top, 1=right, 2=bottom, 3=left
  let x: number, y: number, vx: number, vy: number;
  const speed = CONFIG.weatherCellSpeed * (0.5 + rng.next());

  switch (edge) {
    case 0: // top
      x = rng.range(100, CONFIG.worldW - 100);
      y = -CONFIG.weatherCellRadius;
      vx = (rng.next() - 0.5) * speed;
      vy = speed;
      break;
    case 1: // right
      x = CONFIG.worldW + CONFIG.weatherCellRadius;
      y = rng.range(100, CONFIG.worldH - 100);
      vx = -speed;
      vy = (rng.next() - 0.5) * speed;
      break;
    case 2: // bottom
      x = rng.range(100, CONFIG.worldW - 100);
      y = CONFIG.worldH + CONFIG.weatherCellRadius;
      vx = (rng.next() - 0.5) * speed;
      vy = -speed;
      break;
    default: // left
      x = -CONFIG.weatherCellRadius;
      y = rng.range(100, CONFIG.worldH - 100);
      vx = speed;
      vy = (rng.next() - 0.5) * speed;
      break;
  }

  const cell: WeatherCell = {
    id: state.nextWeatherId++,
    x,
    y,
    radius: CONFIG.weatherCellRadius * (0.7 + rng.next() * 0.6),
    vx,
    vy,
    ttl: 40 + rng.next() * 40, // 40–80 seconds
  };
  state.weather.push(cell);
}

function updateWeather(state: GameState, dt: number, hasRadar: boolean): void {
  if (!hasRadar) return;

  // Spawn weather cells periodically
  state.weatherAccumulator += dt;
  if (state.weatherAccumulator >= CONFIG.weatherSpawnInterval && state.weather.length < CONFIG.weatherMaxCells) {
    state.weatherAccumulator -= CONFIG.weatherSpawnInterval;
    spawnWeatherCell(state);
  }

  // Update positions and TTL
  for (const cell of state.weather) {
    cell.x += cell.vx * dt;
    cell.y += cell.vy * dt;
    cell.ttl -= dt;
  }

  // Remove expired cells or those that have drifted far off-screen
  state.weather = state.weather.filter(
    (c) =>
      c.ttl > 0 &&
      c.x > -CONFIG.weatherCellRadius * 3 &&
      c.x < CONFIG.worldW + CONFIG.weatherCellRadius * 3 &&
      c.y > -CONFIG.weatherCellRadius * 3 &&
      c.y < CONFIG.worldH + CONFIG.weatherCellRadius * 3,
  );
}

/**
 * Check if an airborne plane is inside a weather cell. If so, apply a diversion
 * penalty (the plane doesn't crash but gets penalised).
 */
function checkWeatherPenalty(state: GameState, ac: Aircraft): boolean {
  if (!AIRBORNE_PHASES.includes(ac.phase)) return false;

  for (const cell of state.weather) {
    if (dist(ac.x, ac.y, cell.x, cell.y) < cell.radius) {
      // Diversion penalty — plane pushed out of the weather
      state.diversions += 1;
      state.cash -= CONFIG.diversionPenalty;
      breakStreak(state);
      state.events.push({ kind: 'divert', amount: -CONFIG.diversionPenalty, x: ac.x, y: ac.y });
      return true; // remove the plane
    }
  }
  return false;
}

// ----------------------------------------------------------------------------
// per-aircraft step
// ----------------------------------------------------------------------------

/** Steer + advance one aircraft. Returns a disposition for the caller to act on. */
type Disposition = 'none' | 'diverted' | 'departed';

function stepAircraft(state: GameState, ac: Aircraft, dt: number, turnaroundMult: number): Disposition {
  ac.age += dt;
  const airborne = AIRBORNE_PHASES.includes(ac.phase);
  if (airborne) {
    ac.fuelSeconds -= dt;
    if (ac.fuelSeconds <= CONFIG.lowFuelAt && ac.emergency === 'none') {
      ac.emergency = 'lowFuel';
      state.events.push({ kind: 'emergency', emergency: 'lowFuel', callsign: ac.callsign });
    }
  }

  // --- steering (set heading) + speed target ---
  if (ac.phase === 'approach') {
    // Slow down on the final segment (last waypoint = threshold) for smoother capture
    const approachBase = commandedCruiseSpeed(ac) * CONFIG.approachSpeedFactor;
    ac.speed = ac.waypoints.length <= 1 ? approachBase * 0.6 : approachBase;
    const rw = ac.assignedRunwayId != null ? findRunway(state, ac.assignedRunwayId) : undefined;
    if (rw && ac.assignedEnd != null) {
      const re = rw.ends[ac.assignedEnd];
      let target: Vec;
      if (ac.waypoints.length >= 3) {
        // still heading for the join fix
        target = ac.waypoints[0];
      } else {
        // Established: track the extended centerline — aim at a point a fixed
        // lookahead ahead of the plane's abeam position, so it converges onto
        // the centerline and crosses the threshold aligned.
        const aim = alongTrack(ac, re) + CONFIG.approachLookahead;
        target = {
          x: re.threshold.x + Math.cos(re.dir) * aim,
          y: re.threshold.y + Math.sin(re.dir) * aim,
        };
      }
      ac.heading = turnToward(ac.heading, Math.atan2(target.y - ac.y, target.x - ac.x), ac.turnRate * dt);
      const th = re.threshold;
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
    ac.speed = lerp(ac.speed, commandedCruiseSpeed(ac), 1.5 * dt);
  } else if (ac.phase === 'landing') {
    ac.speed = Math.max(CONFIG.taxiSpeed, ac.speed - ac.landDecel * dt);
  } else if (ac.phase === 'departing') {
    ac.speed = Math.min(commandedCruiseSpeed(ac), ac.speed + 40 * dt);
    ac.altitude = Math.min(6000, ac.altitude + 1300 * dt);
  } else if (ac.phase === 'takeoff') {
    ac.speed = Math.min(ac.cruiseSpeed, ac.speed + 45 * dt);
  } else if (ac.phase === 'taxiIn' || ac.phase === 'taxiOut') {
    const t = ac.taxiTarget;
    if (t) {
      ac.heading = Math.atan2(t.y - ac.y, t.x - ac.x);
      ac.speed = (ac.manualHold || groundBlockedAhead(state, ac)) ? 0 : CONFIG.taxiSpeed;
    } else ac.speed = 0;
  } else if (ac.phase === 'waitCross') {
    ac.speed = 0; // waiting for player authorization
  } else if (ac.phase === 'atGate' || ac.phase === 'readyDep' || ac.phase === 'holdShort' || ac.phase === 'lineUpWait') {
    ac.speed = 0;
  } else {
    // inbound flies straight at commanded cruise speed
    ac.speed = lerp(ac.speed, commandedCruiseSpeed(ac), 1.5 * dt);
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

  // --- taxi crossing detection ---
  if (ac.phase === 'taxiIn' || ac.phase === 'taxiOut') {
    checkTaxiCrossing(state, ac);
  }
  // Check if plane has cleared a crossing
  checkCrossingCleared(ac, state);

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
    const someoneLinedUp = state.aircraft.some((a) => a.phase === 'lineUpWait' && a.assignedRunwayId === ac.assignedRunwayId);
    if (rw && state.time >= rw.occupiedUntil && !someoneLinedUp) {
      const startEnd = rw.ends[(1 - ac.assignedEnd) as 0 | 1];
      const targetEnd = rw.ends[ac.assignedEnd];
      ac.phase = 'lineUpWait';
      ac.x = startEnd.threshold.x;
      ac.y = startEnd.threshold.y;
      ac.heading = targetEnd.dir;
      state.events.push({ kind: 'lineUp', x: ac.x, y: ac.y });
    }
    return 'none';
  }
  if (ac.phase === 'waitCross') {
    // Just waiting — don't move
    return 'none';
  }
  if ((ac.phase === 'taxiIn' || ac.phase === 'taxiOut') && ac.taxiTarget) {
    if (dist(ac.x, ac.y, ac.taxiTarget.x, ac.taxiTarget.y) < GROUND_ARRIVE) {
      if (ac.phase === 'taxiOut') {
        ac.phase = 'holdShort';
        ac.taxiTarget = null;
      } else if (ac.gateId != null) {
        ac.phase = 'atGate';
        ac.turnaround = CONFIG.turnaroundSeconds * turnaroundMult;
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

  // approach: fix capture -> landing attempt
  if (ac.phase === 'approach' && ac.assignedRunwayId != null && ac.assignedEnd != null) {
    const rw = findRunway(state, ac.assignedRunwayId);
    if (rw) {
      const re = rw.ends[ac.assignedEnd];
      // join fix: captured by proximity (radius exceeds any turn radius, so no orbiting)
      if (
        ac.waypoints.length === 3 &&
        dist(ac.x, ac.y, ac.waypoints[0].x, ac.waypoints[0].y) < CONFIG.approachJoinCaptureRadius
      ) {
        ac.waypoints.shift();
      }
      // final entry: captured once the plane passes abeam of it (never orbits a point)
      if (ac.waypoints.length === 2 && -alongTrack(ac, re) < CONFIG.approachLength) {
        ac.waypoints.shift();
      }
      // threshold: crossing the threshold line triggers the landing attempt
      if (ac.waypoints.length === 1 && alongTrack(ac, re) > -8) {
        ac.waypoints.shift();
        attemptLanding(state, ac, rw, ac.assignedEnd);
      }
    }
  }

  // airspace exits: a climbing departure leaves successfully; an unmanaged arrival diverts
  const off = ac.x < -32 || ac.x > CONFIG.worldW + 32 || ac.y < -32 || ac.y > CONFIG.worldH + 32;
  if (off && ac.phase === 'departing') return 'departed';
  if (off && ac.phase === 'inbound' && ac.age > 2) return 'diverted';
  return 'none';
}

// ----------------------------------------------------------------------------
// grading (end of shift)
// ----------------------------------------------------------------------------

export function computeGrade(state: GameState): Grade {
  if (state.status === 'fired' || state.incidents >= CONFIG.crashesToFire) return 'F';
  const target = dayDifficulty(state.day).gradeTarget;
  const clean = state.incidents === 0;
  let g: Grade;
  if (clean && state.nearMisses === 0 && state.cash >= target * 1.25) g = 'S';
  else if (clean && state.cash >= target) g = 'A';
  else if (state.cash >= target * 0.6) g = 'B';
  else if (state.cash >= target * 0.3) g = 'C';
  else g = 'D';
  // a crash caps the grade at C — safety first
  if (!clean && (g === 'S' || g === 'A' || g === 'B')) g = 'C';
  return g;
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

/**
 * Main sim update. Pass upgradeState so the tick can apply upgrade-aware logic
 * (fuel multiplier on spawn, turnaround multiplier, weather radar).
 */
export function update(state: GameState, dt: number, upgradeState: UpgradeState = createUpgradeState()): void {
  if (state.paused || state.status !== 'playing') {
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

  const diff = dayDifficulty(state.day);
  const fuelMult = fuelMultiplier(upgradeState);
  const turnaroundMult = turnaroundMultiplier(upgradeState);
  const hasRadar = hasWeatherRadar(upgradeState);
  const radarRangeMult = radarRangeMultiplier(upgradeState);

  // --- weather ---
  updateWeather(state, dt, hasRadar);

  // --- shift clock ---
  if (!state.finalRushFired && state.time >= state.shiftLength - CONFIG.finalRushLead) {
    state.finalRushFired = true;
    state.events.push({ kind: 'finalRush' });
    for (let k = 0; k < CONFIG.finalRushSize; k++) {
      if (state.aircraft.length < CONFIG.maxAirborneCap) {
        state.aircraft.push(makeAircraft(state, fuelMult, radarRangeMult));
        state.totalSpawned += 1;
      }
    }
  }
  if (state.time >= state.shiftLength) {
    state.status = 'debrief';
    state.grade = computeGrade(state);
    state.events.push({ kind: 'shiftEnd', grade: state.grade });
    return;
  }

  // --- spawning ---
  state.spawnAccumulator += dt;
  while (state.spawnAccumulator >= state.nextSpawnInterval) {
    state.spawnAccumulator -= state.nextSpawnInterval;
    if (state.aircraft.length < maxAirborne(state.time, state.day)) {
      state.aircraft.push(makeAircraft(state, fuelMult, radarRangeMult));
      state.totalSpawned += 1;
    }
    state.nextSpawnInterval = spawnInterval(state);
  }
  // rush waves after the ramp
  if (state.time >= state.nextRushAt) {
    state.events.push({ kind: 'rush' });
    for (let k = 0; k < diff.rushWaveSize; k++) {
      if (state.aircraft.length < CONFIG.maxAirborneCap) {
        state.aircraft.push(makeAircraft(state, fuelMult, radarRangeMult));
        state.totalSpawned += 1;
      }
    }
    state.nextRushAt += CONFIG.rushWaveEvery;
  }

  // --- per-aircraft step ---
  const remove = new Set<number>();
  for (const ac of state.aircraft) {
    const d = stepAircraft(state, ac, dt, turnaroundMult);
    if (d === 'departed') {
      const amount = Math.round(CONFIG.departureSalary * streakMult(state));
      state.cash += amount;
      state.departed += 1;
      state.streak += 1;
      state.bestStreak = Math.max(state.bestStreak, state.streak);
      state.events.push({ kind: 'depart', amount, x: ac.x, y: ac.y, streak: state.streak });
      remove.add(ac.id);
    } else if (d === 'diverted') {
      state.diversions += 1;
      state.cash -= CONFIG.diversionPenalty;
      breakStreak(state);
      state.events.push({ kind: 'divert', amount: -CONFIG.diversionPenalty, x: ac.x, y: ac.y });
      remove.add(ac.id);
    } else if (ac.fuelSeconds <= 0 && AIRBORNE_PHASES.includes(ac.phase)) {
      state.incidents += 1;
      breakStreak(state);
      state.crashFx.push({ x: ac.x, y: ac.y, ttl: 1.5 });
      state.events.push({ kind: 'crash', x: ac.x, y: ac.y });
      remove.add(ac.id);
    }
  }

  // --- ground crash detection ---
  for (const ac of state.aircraft) {
    if (remove.has(ac.id)) continue;
    if (checkGroundCrash(state, ac)) {
      state.incidents += 1;
      breakStreak(state);
      state.crashFx.push({ x: ac.x, y: ac.y, ttl: 1.5 });
      state.events.push({ kind: 'groundCrash', x: ac.x, y: ac.y });
      remove.add(ac.id);
    }
  }

  // --- weather diversion penalties ---
  if (hasRadar) {
    for (const ac of state.aircraft) {
      if (remove.has(ac.id)) continue;
      if (checkWeatherPenalty(state, ac)) {
        remove.add(ac.id);
      }
    }
  }

  // --- separation / conflict / collisions (airborne traffic only) ---
  for (const ac of state.aircraft) {
    ac.conflict = false;
    ac.conflictPartner = null;
    ac.conflictTimeLeft = 0;
    ac.warn = false;
  }
  state.predicted = [];
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
        next.set(key, prevT + dt);
        a.conflict = b.conflict = true;
        if (a.conflictPartner == null) a.conflictPartner = b.id;
        if (b.conflictPartner == null) b.conflictPartner = a.id;
        if (dd < CONFIG.planeHitRadius * 1.5) crashPairs.push([a, b]);
      } else {
        if (prevT > 0) {
          // separation regained before collision => near miss
          state.nearMisses += 1;
          breakStreak(state);
          state.events.push({
            kind: 'nearMiss',
            x: (a.x + b.x) / 2,
            y: (a.y + b.y) / 2,
          });
        }
        // AMBER pre-warning: project current headings/speeds to closest approach
        const rx = b.x - a.x;
        const ry = b.y - a.y;
        const vx = Math.cos(b.heading) * b.speed - Math.cos(a.heading) * a.speed;
        const vy = Math.sin(b.heading) * b.speed - Math.sin(a.heading) * a.speed;
        const vv = vx * vx + vy * vy;
        if (vv > 1e-6) {
          const tca = -(rx * vx + ry * vy) / vv;
          if (tca > 0 && tca <= CONFIG.predictLookahead) {
            const cx = rx + vx * tca;
            const cy = ry + vy * tca;
            if (Math.hypot(cx, cy) < sep * 0.95) {
              a.warn = b.warn = true;
              state.predicted.push({
                aId: a.id,
                bId: b.id,
                t: tca,
                x: a.x + Math.cos(a.heading) * a.speed * tca + cx / 2,
                y: a.y + Math.sin(a.heading) * a.speed * tca + cy / 2,
              });
            }
          }
        }
      }
    }
  }
  state.conflicts = next;

  for (const [a, b] of crashPairs) {
    if (remove.has(a.id) || remove.has(b.id)) continue;
    remove.add(a.id);
    remove.add(b.id);
    state.incidents += 1;
    breakStreak(state);
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    state.crashFx.push({ x: cx, y: cy, ttl: 1.5 });
    state.events.push({ kind: 'crash', x: cx, y: cy });
  }

  if (remove.size > 0) state.aircraft = state.aircraft.filter((a) => !remove.has(a.id));

  // --- failure ---
  if (state.incidents >= CONFIG.crashesToFire) {
    state.status = 'fired';
    state.grade = 'F';
    state.events.push({ kind: 'fired' });
  }

  // --- onboarding hint ---
  if (state.handled > 0 || state.time > 22) state.showHint = false;

  // keep the event queue bounded if nobody drains it (headless harness)
  if (state.events.length > 512) state.events.splice(0, state.events.length - 512);
}
