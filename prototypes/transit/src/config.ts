// All tunable constants live here so playtesting is a single-file edit.
// Sim values come straight from the design brief; layout/input/palette are
// prototype-rendering concerns and are grouped separately.

export const CONFIG = {
  // --- world / layout (logical units; renderer letterboxes to the window) ---
  worldW: 1280,
  worldH: 800,
  margin: 90, // keep stations away from the very edge
  minStationSpacing: 132, // reject station placements closer than this

  // --- sim: stations & failure (brief §5) ---
  startStations: 3,
  maxStations: 12,
  newStationEvery: 20, // seconds between new-station spawns
  stationCapacity: 6, // waiting passengers before a station is "over capacity"
  overflowToFail: 10, // seconds over capacity before a strain hit
  maxStrain: 3, // run ends when strain reaches this
  dropToCapacityOnOverflow: true, // shed the newest excess riders on a strain hit (relief)

  // --- sim: lines & trains ---
  lineSlots: 3, // simultaneous lines the player may have
  trainCapacity: 6,
  edgeTravelSeconds: 3, // a "reference length" edge takes this long...
  referenceEdgeLength: 240, // ...where reference length is this many world units
  stationDwellSeconds: 0.5, // board/alight stop time

  // --- sim: difficulty ramp (brief §5) ---
  spawnIntervalStart: 4.0, // seconds between passenger spawns at t=0
  spawnIntervalEnd: 1.2, // ...ramping to this
  rampDurationSeconds: 180, // ...over this long, then holds
  stuckPassengerFallback: 25, // after waiting this long, board ANY train (anti-deadlock)
  farDestBias: 1.0, // >0 biases each passenger's destination toward far shapes

  // --- M4: draft stub ---
  enableDraft: true,
  rushHourEvery: 80, // seconds between "rush hour" draft offers

  // --- input ---
  snapRadius: 36, // cursor-to-station snap distance for drawing
  lineHitRadius: 14, // right-click distance to delete a line

  // --- determinism ---
  defaultSeed: 1337,

  // --- timing ---
  simStepHz: 60,
} as const;

// Warm, deliberately *not* Mini-Metro-white. Dark warm slate/charcoal with a
// paper-cream foreground and saturated transit-line accents.
export const PALETTE = {
  bg: '#1e1a17',
  bgVignette: '#15110e',
  grid: '#28221c',
  stationFill: '#2b2620',
  stationStroke: '#f0e6d2',
  paper: '#f0e6d2',
  text: '#f4ecdc',
  textDim: '#9d9286',
  panel: '#2a241e',
  panelEdge: '#3c342b',
  danger: '#e0533d',
  warn: '#e8a33d',
  good: '#7cc36a',
  // line-slot colors (first `lineSlots` are the starting palette; extras cover +slot upgrades)
  lineColors: ['#e8a33d', '#5bb3c4', '#e0533d', '#b07cc6', '#7cc36a', '#d98cae'],
} as const;

// Derived: constant train speed in world units / second.
export const TRAIN_SPEED = CONFIG.referenceEdgeLength / CONFIG.edgeTravelSeconds;
