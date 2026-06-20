// Final Approach — all tunable constants in one place for playtesting.
// Sim units are world pixels (1280x800 logical space, letterboxed to the window).
// "Speeds" are world px/sec; they read like knots on the scope but aren't literal.

export const CONFIG = {
  // --- world / layout ---
  worldW: 1280,
  worldH: 800,
  // airport reference (range-ring center)
  airportX: 600,
  airportY: 410,

  // --- runways (two parallel strips; each can be landed from EITHER end, so
  //     there are four approach corridors total; the player picks the side by
  //     dragging the plane to it). `headingDeg` is the primary end's landing
  //     travel direction; the reciprocal end is the opposite. ---
  approachLength: 300, // length of each final-approach corridor (px)
  runways: [
    { cx: 560, cy: 330, headingDeg: 180, length: 150, side: 'L' as const },
    { cx: 560, cy: 500, headingDeg: 180, length: 150, side: 'R' as const },
  ],

  // --- failure ---
  crashesToFire: 2, // 2nd crash ends the shift (you're fired)

  // --- separation / conflict ---
  separationMin: 66, // base lateral separation ring radius (px); scaled by wake
  conflictToCrash: 3.6, // seconds two planes may stay inside separation before they collide
  // (a fixed, fair reaction window once the amber alert shows)

  // --- aircraft types: cruise px/s, approach factor, turn rate deg/s, wake factor, salary ---
  types: {
    small: { speed: 82, turnRateDeg: 52, wake: 1.0, salary: 90, label: 'small' },
    medium: { speed: 70, turnRateDeg: 40, wake: 1.18, salary: 120, label: 'med' },
    heavy: { speed: 60, turnRateDeg: 27, wake: 1.5, salary: 180, label: 'heavy' },
  },
  approachSpeedFactor: 0.72, // planes slow down on final
  arriveRadius: 18, // waypoint capture distance
  alignToleranceDeg: 22, // heading must be within this of runway heading to land (else go-around)

  // --- runway occupancy ---
  rolloutSeconds: 2.4, // how long a landing plane blocks the runway
  medicalAssistSeconds: 6, // emergency landings block the runway longer

  // --- fuel ---
  fuelSecondsStart: 165,
  fuelVariance: 35,
  lowFuelAt: 42, // below this -> low-fuel emergency (priority)

  // --- difficulty ramp ---
  firstSpawnAt: 3, // get a plane on the scope almost immediately
  spawnIntervalStart: 21, // calm onboarding
  spawnIntervalEnd: 6.5,
  rampDurationSeconds: 180,
  rushWaveEvery: 40, // after the ramp, periodic bursts ("holiday rush")
  rushWaveSize: 3,
  maxAirborneStart: 4, // concurrency cap (grows over time)
  maxAirborneGrowEvery: 40,
  maxAirborneCap: 13,
  heavyChanceStart: 0.05, // share of heavies grows with the rush
  heavyChanceEnd: 0.3,
  emergencyStartAt: 95, // no emergencies during onboarding
  emergencyChanceEnd: 0.14, // per-spawn chance once fully ramped
  // spawn geometry: early traffic enters from the approach side (east), widening
  // to all directions later; aim points are spread so planes don't all knife
  // into the exact center and self-collide.
  spawnAngleSpreadStartDeg: 55,
  spawnAngleSpreadEndDeg: 180,
  spawnAimSpread: 80,

  // --- economy ---
  onTimeBonusMax: 50, // bonus for quick handling, decays with time-in-airspace
  onTimeWindow: 55, // seconds within which the full bonus applies
  goAroundPenalty: 30,
  nearMissPenalty: 35,
  diversionPenalty: 45, // a plane allowed to leave the airspace unhandled
  crashPenalty: 500,

  // --- ground ops (terminal sits between the two runways) ---
  gates: [
    { x: 505, y: 415 },
    { x: 555, y: 415 },
    { x: 605, y: 415 },
    { x: 655, y: 415 },
  ],
  rampWait: { x: 770, y: 415 }, // where arrivals idle if every gate is full
  taxiSpeed: 26, // ground speed (px/s) — deliberately slow
  groundSeparation: 22, // taxiing planes stop to avoid overlapping the one ahead
  turnaroundSeconds: 13, // gate time (deplane / refuel / board) before it can depart
  takeoffRollSeconds: 2.6, // runway occupancy during a takeoff roll
  departureSalary: 120, // paid when a departure successfully climbs out
  shortFinalGuard: 150, // a departure holds short if an arrival is this close to the shared runway

  // --- input ---
  planeHitRadius: 22,
  pathSampleDist: 20, // min world-px between sampled drag points
  holdRadius: 120, // orbit radius for holds (must exceed v/turnRate for all types)

  // --- determinism ---
  defaultSeed: 7,
  simStepHz: 60,
} as const;

// Radar/phosphor palette — instantly reads as ATC, and is its own identity
// (not Mini-Metro-white, not the transit prototype's warm paper).
export const PALETTE = {
  bg: '#0a0f0c',
  bgVignette: '#050806',
  ring: 'rgba(95,224,138,0.10)',
  ringText: 'rgba(95,224,138,0.35)',
  sweep: 'rgba(95,224,138,0.07)',
  runway: '#20302a',
  runwayEdge: 'rgba(180,230,200,0.5)',
  corridorFree: 'rgba(95,224,138,0.32)',
  corridorBusy: 'rgba(232,181,74,0.45)',
  blip: '#67e8a0', // normal arrival
  blipDim: 'rgba(103,232,160,0.5)',
  trail: 'rgba(103,232,160,0.22)',
  departure: '#5bd6e8', // departures / ground-bound traffic
  gateFree: 'rgba(103,232,160,0.22)',
  gateBusy: '#e8b54a',
  gateReady: '#5bd6e8',
  selected: '#e9f7ee',
  warn: '#e8b54a', // low fuel / caution
  danger: '#ff5a48', // conflict / emergency / crash
  text: '#dff3e6',
  textDim: 'rgba(223,243,230,0.55)',
  panel: 'rgba(10,18,14,0.82)',
  panelEdge: 'rgba(103,232,160,0.25)',
} as const;

export type RunwayLayout = (typeof CONFIG.runways)[number];
export type AircraftTypeKey = keyof typeof CONFIG.types;
