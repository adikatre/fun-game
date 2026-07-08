import type { Rng } from './rng';
import type { UpgradeState } from './upgrades';

export type AircraftType = 'small' | 'medium' | 'heavy';
export type Emergency = 'none' | 'lowFuel' | 'medical';

/**
 * Air-side:
 *  inbound   — just spawned / unmanaged, flying its current heading straight
 *  holding   — orbiting a fix, burning fuel
 *  approach  — locked to a runway end's final, flying the corridor to touchdown
 *  landing   — on the runway, decelerating; occupies the runway
 * Ground-side:
 *  taxiIn    — rolled out, taxiing to a gate (or the ramp if gates are full)
 *  atGate    — parked, turnaround timer running (deplane / refuel / board)
 *  readyDep  — parked, refuelled, waiting for the player to dispatch it
 *  taxiOut   — taxiing from the gate to a runway hold-short
 *  holdShort — waiting at the runway for it to be clear, then lines up
 *  takeoff   — accelerating down the runway; occupies the runway
 *  departing — airborne, climbing out to leave the airspace
 *  waitCross — waiting at a taxiway-runway intersection for player to authorize crossing
 */
export type Phase =
  | 'inbound'
  | 'holding'
  | 'approach'
  | 'landing'
  | 'taxiIn'
  | 'atGate'
  | 'readyDep'
  | 'taxiOut'
  | 'holdShort'
  | 'lineUpWait'
  | 'takeoff'
  | 'departing'
  | 'waitCross';

/** Airborne phases are subject to separation conflicts; ground phases are not. */
export const AIRBORNE_PHASES: readonly Phase[] = ['inbound', 'holding', 'approach', 'departing'];

export interface Vec {
  x: number;
  y: number;
}

export interface Aircraft {
  id: number;
  callsign: string;
  type: AircraftType;
  x: number;
  y: number;
  heading: number; // radians; 0 = +x (east), increases clockwise (screen y-down)
  speed: number; // current world px/s
  cruiseSpeed: number;
  speedMult: number; // player speed target as fraction of cruise (1 = nominal)
  turnRate: number; // radians/s
  wake: number; // separation multiplier
  altitude: number; // feet, cosmetic + descends on approach
  fuelSeconds: number;
  emergency: Emergency;
  phase: Phase;
  waypoints: Vec[]; // approach path being followed: [IAF, finalEntry, threshold]
  assignedRunwayId: number | null;
  assignedEnd: 0 | 1 | null; // landing/takeoff end of the assigned runway
  holdCenter: Vec | null;
  manualHold: boolean; // true if player explicitly commanded ground hold
  // ground state
  gateId: number | null; // gate currently occupied / heading to
  taxiTarget: Vec | null; // current ground destination (gate / ramp / lineup)
  turnaround: number; // seconds left at the gate
  age: number; // seconds since spawn (gates diversion / on-time bonus)
  landTimer: number; // runway occupancy countdown while phase === 'landing'
  landDecel: number; // px/s² deceleration computed at touchdown (physics-based rollout)
  conflict: boolean; // inside separation with someone this tick (render: RED)
  conflictPartner: number | null; // id of nearest conflicting plane (render connector)
  conflictTimeLeft: number; // seconds until this conflict becomes a crash (render countdown)
  warn: boolean; // PREDICTED conflict within lookahead (render: AMBER)
  trail: Vec[]; // recent positions (radar trail)
  // taxiway crossing state
  crossingRunwayId: number | null; // runway this plane needs to cross (null if not at a crossing)
  // render interpolation
  px: number;
  py: number;
  ppx: number;
  ppy: number;
}

/** One landable end of a runway (a runway has two — reciprocal directions). */
export interface RunwayEnd {
  name: string; // e.g. "27L" / "09R"
  dir: number; // landing travel heading (radians), pointing from this end toward the far end
  threshold: Vec; // touchdown point at this end
  finalEntry: Vec; // start of this end's approach corridor (FAF), outward from the threshold
}

export interface Runway {
  id: number;
  cx: number;
  cy: number;
  length: number;
  width: number;
  angle: number; // rotation angle in radians (for rendering)
  ends: [RunwayEnd, RunwayEnd]; // [0] primary, [1] reciprocal
  occupiedUntil: number; // whole strip is busy during any landing/takeoff
}

export interface Gate {
  id: number;
  x: number;
  y: number;
  occupantId: number | null;
  useCount: number; // times assigned; nudges selection away from a gate the sim keeps favoring on distance alone
}

/** A weather cell drifting across the map (no-fly zone). */
export interface WeatherCell {
  id: number;
  x: number;
  y: number;
  radius: number;
  vx: number; // drift velocity
  vy: number;
  ttl: number; // seconds until it dissipates
}

/**
 * menu      — main menu / title screen (game boots here)
 * tutorial  — how-to-play screen; sim is frozen until the player begins the shift
 * playing   — the shift is live
 * debrief   — the shift timer ran out; grade + stats screen
 * fired     — two crashes; failure screen
 * upgrade   — between shifts; tech tree / shop screen
 * stats     — career statistics dashboard
 * settings  — audio / reset settings screen
 */
export type GameStatus = 'menu' | 'tutorial' | 'playing' | 'debrief' | 'fired' | 'upgrade' | 'stats' | 'settings';

/** Lifetime career statistics, persisted across shifts. */
export interface CareerStats {
  totalShifts: number;
  totalLandings: number;
  totalDepartures: number;
  bestCash: number;
  bestStreak: number;
  totalCrashes: number;
  lifetimeEarnings: number;
  grades: Record<Grade, number>;
}

export type Grade = 'S' | 'A' | 'B' | 'C' | 'D' | 'F';

/** Deterministic sim output events, drained by main each frame for audio/fx. */
export type GameEvent =
  | { kind: 'assign'; x: number; y: number }
  | { kind: 'dispatch'; x: number; y: number }
  | { kind: 'hold' }
  | { kind: 'unhold' }
  | { kind: 'land'; amount: number; x: number; y: number; streak: number }
  | { kind: 'depart'; amount: number; x: number; y: number; streak: number }
  | { kind: 'goAround'; amount: number; x: number; y: number }
  | { kind: 'nearMiss'; x: number; y: number }
  | { kind: 'divert'; amount: number; x: number; y: number }
  | { kind: 'crash'; x: number; y: number }
  | { kind: 'groundCrash'; x: number; y: number }
  | { kind: 'takeoffClearance'; x: number; y: number }
  | { kind: 'lineUp'; x: number; y: number }
  | { kind: 'emergency'; emergency: Emergency; callsign: string }
  | { kind: 'crossRunway'; x: number; y: number }
  | { kind: 'manualHold'; hold: boolean; x: number; y: number }
  | { kind: 'speedAdjust'; faster: boolean; mult: number; x: number; y: number }
  | { kind: 'rush' }
  | { kind: 'finalRush' }
  | { kind: 'shiftEnd'; grade: Grade }
  | { kind: 'fired' }
  | { kind: 'purchase'; upgradeId: string }
  | { kind: 'purchaseFailed'; reason: string };

/** A predicted loss of separation (amber warning) for the renderer. */
export interface PredictedConflict {
  aId: number;
  bId: number;
  t: number; // seconds until closest approach
  x: number; // predicted conflict point (midpoint at closest approach)
  y: number;
}

export interface GameState {
  time: number;
  paused: boolean;
  status: GameStatus;
  day: number; // career shift number (difficulty scales with it)
  shiftLength: number; // seconds in this shift
  grade: Grade | null; // set when the shift ends

  aircraft: Aircraft[];
  runways: Runway[];
  gates: Gate[];
  weather: WeatherCell[]; // active weather cells

  // failure / score
  incidents: number; // crashes
  handled: number; // safe landings
  departed: number; // successful departures
  cash: number;
  nearMisses: number;
  goArounds: number;
  diversions: number;
  streak: number; // consecutive safe landings/departures (pay multiplier)
  bestStreak: number;

  // spawning / ramp
  spawnAccumulator: number;
  nextSpawnInterval: number;
  nextRushAt: number;
  totalSpawned: number;
  finalRushFired: boolean;

  // weather spawning
  weatherAccumulator: number;
  nextWeatherId: number;

  // conflict bookkeeping: pairKey "a-b" -> seconds inside separation
  conflicts: Map<string, number>;
  predicted: PredictedConflict[];

  // last crash marker for the renderer (id-less, world coords + ttl)
  crashFx: { x: number; y: number; ttl: number }[];

  // deterministic output events (drained by main for audio / fx)
  events: GameEvent[];

  // onboarding hint visibility
  showHint: boolean;

  // id counters
  nextAircraftId: number;

  rngSeed: number;
  rng: Rng;

  adDoubleUsed: boolean;
  adContinueUsed: boolean;
}

/** Read-only viewport transform shared by render + input (world <-> screen). */
export interface Viewport {
  scale: number;
  offsetX: number;
  offsetY: number;
  cssW: number;
  cssH: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A drag-in-progress (choosing a runway end to land on), for the renderer. */
export interface DragHint {
  fromAircraftId: number;
  toX: number; // cursor world position
  toY: number;
  targetRunwayId: number | null;
  targetEnd: 0 | 1 | null; // which end/side the drop currently selects
  endName: string | null; // label of that end (e.g. "27L")
}

/** Everything the renderer needs about transient input/UI state. */
export interface RenderHints {
  pointerWorld: Vec | null;
  hoverAircraftId: number | null;
  selectedAircraftId: number | null;
  hoverRunwayId: number | null;
  hoverEnd: 0 | 1 | null;
  drag: DragHint | null;
  hoverButtonId: string | null;
  hoverUpgradeId: string | null;
  muted: boolean;
  best: number;
  upgrades: UpgradeState;
  shopScrollY?: number;
  confirmingReset?: boolean;
  restartArmed?: boolean;
  tutorialReadOnly?: boolean;
  volume?: number;
  musicVolume?: number;
  sfxVolume?: number;
  careerStats?: CareerStats;
}
