import type { Rng } from './rng';

export type ShapeType = 'circle' | 'triangle' | 'square';
export const SHAPES: readonly ShapeType[] = ['circle', 'triangle', 'square'] as const;

export interface Passenger {
  id: number;
  destShape: ShapeType;
  spawnedAt: number; // sim time at spawn — drives the stuck-passenger fallback
}

export interface Station {
  id: number;
  x: number;
  y: number;
  shape: ShapeType;
  queue: Passenger[]; // waiting passengers, oldest first (FIFO)
  overflowTimer: number; // seconds spent over capacity (0 when at/under)
}

export type TrainPhase = 'moving' | 'dwelling';

export interface Train {
  id: number;
  lineId: number;
  edgeIndex: number; // edge connects stationIds[edgeIndex] <-> stationIds[edgeIndex+1]
  t: number; // 0..1 progress along the current edge, in travel direction
  dir: 1 | -1; // +1 = toward higher index, -1 = toward lower index
  phase: TrainPhase;
  dwell: number; // remaining dwell seconds when phase === 'dwelling'
  capacity: number;
  speed: number; // world units / second
  passengers: Passenger[];
  // render interpolation (world coords) + facing
  px: number;
  py: number;
  ppx: number;
  ppy: number;
  angle: number;
}

export interface Line {
  id: number;
  color: string;
  stationIds: number[]; // ordered path; trains ping-pong end to end
  trains: Train[];
}

/** dist[shape] : stationId -> min hops to the nearest station of that shape. */
export type RoutingTable = Record<ShapeType, Map<number, number>>;

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
  time: number; // sim seconds elapsed
  paused: boolean;
  status: GameStatus;

  stations: Station[];
  lines: Line[];

  availableLineSlots: number;
  delivered: number; // score
  strain: number; // 0..maxStrain
  maxStrain: number;

  spawnAccumulator: number;
  nextStationAt: number; // sim time of the next station spawn

  // base values new trains inherit (raised by upgrades)
  baseTrainCapacity: number;
  baseTrainSpeed: number;

  // M4 draft
  draft: DraftState | null;
  nextRushAt: number;

  routing: RoutingTable;

  // id counters
  nextStationId: number;
  nextPassengerId: number;
  nextLineId: number;
  nextTrainId: number;

  rngSeed: number;
  rng: Rng;

  // lightweight stats for the report / HUD
  totalSpawned: number;
  stuckBoardings: number; // passengers that boarded via the anti-deadlock fallback
  deliveredLatencySum: number; // sum of (deliveredAt - spawnedAt); /delivered = avg trip time
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

/** A drag-in-progress, computed by input each frame for the renderer to draw. */
export interface DragHint {
  fromStationId: number;
  toX: number; // world coords (cursor or snapped station)
  toY: number;
  snapStationId: number | null;
  action: 'create' | 'extend' | 'invalid';
  color: string;
}

/** Everything the renderer needs about transient input/UI state. */
export interface RenderHints {
  pointerWorld: { x: number; y: number } | null;
  hoverStationId: number | null;
  drag: DragHint | null;
}
