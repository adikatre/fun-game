import type { Rng } from './rng';

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
  | 'takeoff'
  | 'departing';

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
  turnRate: number; // radians/s
  wake: number; // separation multiplier
  altitude: number; // feet, cosmetic + descends on approach
  fuelSeconds: number;
  emergency: Emergency;
  phase: Phase;
  waypoints: Vec[]; // approach path being followed: [finalEntry, threshold]
  assignedRunwayId: number | null;
  assignedEnd: 0 | 1 | null; // landing/takeoff end of the assigned runway
  holdCenter: Vec | null;
  // ground state
  gateId: number | null; // gate currently occupied / heading to
  taxiTarget: Vec | null; // current ground destination (gate / ramp / lineup)
  turnaround: number; // seconds left at the gate
  age: number; // seconds since spawn (gates diversion / on-time bonus)
  landTimer: number; // runway occupancy countdown while phase === 'landing'
  landDecel: number; // px/s² deceleration computed at touchdown (physics-based rollout)
  conflict: boolean; // inside separation with someone this tick (render)
  conflictPartner: number | null; // id of nearest conflicting plane (render connector)
  trail: Vec[]; // recent positions (radar trail)
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
  ends: [RunwayEnd, RunwayEnd]; // [0] primary, [1] reciprocal
  occupiedUntil: number; // whole strip is busy during any landing/takeoff
}

export interface Gate {
  id: number;
  x: number;
  y: number;
  occupantId: number | null;
}

export type GameStatus = 'playing' | 'gameover';

export interface DraftOption {
  id: string;
  title: string;
  desc: string;
}
export interface DraftState {
  options: DraftOption[];
}

export interface GameState {
  time: number;
  paused: boolean;
  status: GameStatus;

  aircraft: Aircraft[];
  runways: Runway[];
  gates: Gate[];

  // failure / score
  incidents: number; // crashes
  handled: number; // safe landings
  departed: number; // successful departures
  cash: number;
  nearMisses: number;
  goArounds: number;
  diversions: number;

  // spawning / ramp
  spawnAccumulator: number;
  nextSpawnInterval: number;
  nextRushAt: number;
  totalSpawned: number;

  // conflict bookkeeping: pairKey "a-b" -> seconds inside separation
  conflicts: Map<string, number>;

  // last crash marker for the renderer (id-less, world coords + ttl)
  crashFx: { x: number; y: number; ttl: number }[];

  // onboarding hint visibility
  showHint: boolean;

  // M4-style end-of-shift draft (optional)
  draft: DraftState | null;

  // id counters
  nextAircraftId: number;

  rngSeed: number;
  rng: Rng;
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
}
