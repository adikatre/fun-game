import type { Rng } from './rng';

export type AircraftType = 'small' | 'medium' | 'heavy';
export type Emergency = 'none' | 'lowFuel' | 'medical';

/**
 * inbound   — just spawned, flying its initial heading, unmanaged
 * vectoring — following a player-drawn / clicked path of waypoints
 * holding   — orbiting a fix (racetrack-ish), burning fuel
 * approach  — locked to a runway's final, flying the corridor to touchdown
 * landing   — on the runway, decelerating; occupies the runway
 * goAround  — rejected approach, climbing out; becomes vectoring/inbound again
 */
export type Phase = 'inbound' | 'vectoring' | 'holding' | 'approach' | 'landing' | 'goAround';

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
  waypoints: Vec[]; // path being followed (vectoring/approach)
  assignedRunwayId: number | null;
  holdCenter: Vec | null;
  age: number; // seconds since spawn (gates diversion / on-time bonus)
  landTimer: number; // rollout countdown while phase === 'landing'
  conflict: boolean; // inside separation with someone this tick (render)
  conflictPartner: number | null; // id of nearest conflicting plane (render connector)
  trail: Vec[]; // recent positions (radar trail)
  // render interpolation
  px: number;
  py: number;
  ppx: number;
  ppy: number;
}

export interface Runway {
  id: number;
  name: string;
  dir: number; // landing travel heading (radians)
  cx: number;
  cy: number;
  length: number;
  width: number;
  approachEnd: Vec; // touchdown point (start of rollout)
  rollEnd: Vec; // far end
  finalEntry: Vec; // start of the approach corridor (FAF)
  occupiedUntil: number; // sim time the runway is free again
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

  // failure / score
  incidents: number; // crashes
  handled: number; // safe landings
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

/** A drag-in-progress (drawing a flight path), produced by input for the renderer. */
export interface DragHint {
  fromAircraftId: number;
  points: Vec[]; // sampled world points
  snapRunwayId: number | null;
  valid: boolean;
}

/** Everything the renderer needs about transient input/UI state. */
export interface RenderHints {
  pointerWorld: Vec | null;
  hoverAircraftId: number | null;
  selectedAircraftId: number | null;
  hoverRunwayId: number | null;
  drag: DragHint | null;
}
