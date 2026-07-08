// Final Approach — all tunable constants in one place for playtesting.
// Sim units are world pixels (1600x1000 logical space, letterboxed to the window).
// "Speeds" are world px/sec; they read like knots on the scope but aren't literal.

export const CONFIG = {
  // --- world / layout ---
  worldW: 1600,
  worldH: 1000,
  // airport reference (range-ring center)
  airportX: 750,
  airportY: 500,

  // --- runways (two starter strips on day 1 — E/W + N/S — each landable from
  //     either end; expansion adds angled/crossing strips later). ---
  approachLength: 210, // length of each final-approach corridor (px)
  approachIafExtra: 100, // extra leg beyond FAF where planes first join the approach (px)
  runways: [
    { cx: 750, cy: 500, headingDeg: 180, length: 300, side: '' as const },
    { cx: 750, cy: 500, headingDeg: 90, length: 240, side: '' as const },
  ],

  // --- runway expansion slots (purchasable via tech tree) ---
  // Each slot defines a new runway that can be added. They get progressively more
  // angled/crossing, creating intersection complexity.
  runwayExpansionSlots: [
    // Slot 1: diagonal (first shop purchase — runway_2)
    { cx: 730, cy: 440, headingDeg: 135, length: 240, side: 'X' as const },
    // Slot 2: offset crosswind strip (runway_4)
    { cx: 690, cy: 520, headingDeg: 90, length: 220, side: 'Z' as const },
    // Slot 3: parallel overflow strip (runway_5)
    { cx: 810, cy: 460, headingDeg: 180, length: 200, side: 'W' as const },
  ],

  // --- session: a shift is a timed round with an escalating arc + final rush ---
  shiftSeconds: 180, // 3-minute shift
  finalRushLead: 40, // the "final rush" climax starts this many seconds before the end
  finalRushSize: 2, // burst size at final-rush start
  finalRushIntervalFactor: 0.85, // spawn interval multiplier during the final rush
  // per-day (career) difficulty scaling
  dayIntervalFactor: 0.93, // spawn intervals shrink ~7% per day (floored below)
  dayIntervalFloor: 0.6,
  dayRushBonusEvery: 2, // rush waves grow by 1 plane every N days
  gradeTargetBase: 1200, // cash target for an A on day 1...
  gradeTargetPerDay: 200, // ...growing per day

  // --- failure ---
  crashesToFire: 2, // 2nd crash ends the shift (you're fired)

  // --- separation / conflict ---
  separationMin: 66, // base lateral separation ring radius (px); scaled by wake
  conflictToCrash: 4.5, // seconds two planes may stay inside separation before they collide
  predictLookahead: 14, // seconds ahead to project closures for the AMBER pre-warning

  // --- aircraft types: cruise px/s, approach factor, turn rate deg/s, wake factor, salary ---
  types: {
    small: { speed: 41, turnRateDeg: 35, wake: 1.0, salary: 90, label: 'small' },
    medium: { speed: 35, turnRateDeg: 28, wake: 1.18, salary: 120, label: 'med' },
    heavy: { speed: 30, turnRateDeg: 20, wake: 1.5, salary: 180, label: 'heavy' },
  },
  approachSpeedFactor: 0.72, // planes slow down on final
  alignToleranceDeg: 22, // heading must be within this of runway heading to land (else go-around)
  // approach guidance: planes join the extended centerline at a per-plane fix,
  // then track the centerline in (pure pursuit) so they arrive aligned.
  approachJoinCaptureRadius: 90, // join-fix capture distance (>= worst-case turn radius so nobody orbits it)
  approachLookahead: 110, // centerline-tracking aim distance (> turn radius for smooth convergence)
  approachMinJoinDist: 220, // join fix placed at least this far from the plane (> 2x turn radius, no orbit trap)

  // --- runway occupancy ---
  rolloutSeconds: 2.4, // how long a landing plane blocks the runway
  medicalAssistSeconds: 6, // emergency landings block the runway longer

  // --- fuel ---
  fuelSecondsStart: 165,
  fuelVariance: 35,
  lowFuelAt: 42, // below this -> low-fuel emergency (priority)

  // --- difficulty ramp (within a shift) ---
  firstSpawnAt: 3, // get a plane on the scope almost immediately
  spawnIntervalStart: 32, // calm onboarding
  spawnIntervalEnd: 10,
  rampDurationSeconds: 85,
  rushWaveEvery: 60, // after the ramp, periodic bursts ("holiday rush")
  rushWaveSize: 2,
  maxAirborneStart: 4, // concurrency cap (grows over time)
  maxAirborneGrowEvery: 45,
  maxAirborneCap: 10,
  heavyChanceStart: 0.03, // share of heavies grows with the rush
  heavyChanceEnd: 0.22,
  emergencyStartAt: 55, // no emergencies during onboarding
  emergencyChanceEnd: 0.08, // per-spawn chance once fully ramped
  // day-1 onboarding: gentler ramp so first shift reaches mid-game + final rush
  day1SpawnIntervalStart: 42,
  day1SpawnIntervalEnd: 12,
  day1RampDurationSeconds: 105,
  day1EmergencyStartAt: 90,
  day1MaxAirborneStart: 3,
  day1RushWaveSize: 1,
  // spawn geometry: early traffic enters from the approach side (east), widening
  // to all directions later; aim points are spread so planes don't all knife
  // into the exact center and self-collide.
  spawnAngleSpreadStartDeg: 55,
  spawnAngleSpreadEndDeg: 180,
  spawnAimSpread: 100,

  // --- economy ---
  onTimeBonusMax: 50, // bonus for quick handling, decays with time-in-airspace
  onTimeWindow: 55, // seconds within which the full bonus applies
  goAroundPenalty: 30,
  nearMissPenalty: 35,
  diversionPenalty: 45, // a plane allowed to leave the airspace unhandled
  crashPenalty: 500,
  streakStep: 0.1, // each consecutive safe landing/departure adds +10% pay...
  streakMaxMult: 2.0, // ...up to double pay

  // --- ground ops (terminal sits south of the middle runway) ---
  gates: [
    // Terminal 1 (Top Right)
    { x: 800, y: 400 },
    { x: 850, y: 400 },
    { x: 900, y: 400 },
  ],
  // gate expansion slots (purchasable)
  gateExpansionSlots: [
    // Terminal 2 (Bottom Left) - First Expansion
    { x: 600, y: 600 },
    { x: 650, y: 600 },
    { x: 700, y: 600 },
    // Terminal 1 Expansion
    { x: 800, y: 350 },
    { x: 850, y: 350 },
    { x: 900, y: 350 },
    // Terminal 2 Expansion
    { x: 600, y: 650 },
    { x: 650, y: 650 },
    { x: 700, y: 650 },
  ],
  rampWait: { x: 850, y: 450 }, // where arrivals idle if every gate is full
  taxiSpeed: 26, // ground speed (px/s) — deliberately slow
  groundSeparation: 22, // taxiing planes stop to avoid overlapping the one ahead
  turnaroundSeconds: 13, // gate time (deplane / refuel / board) before it can depart
  takeoffRollSeconds: 2.6, // runway occupancy during a takeoff roll
  departureSalary: 120, // paid when a departure successfully climbs out
  shortFinalGuard: 170, // a departure holds short if an arrival is this close to the shared runway

  // --- taxiway crossing ---
  crossingHoldShortDist: 30, // distance from runway center to stop at when waiting to cross
  crossingClearDist: 50, // how far past the runway center counts as "cleared"

  // --- weather (upgrade-gated) ---
  weatherCellRadius: 80, // radius of weather cells
  weatherCellSpeed: 12, // px/s drift speed
  weatherSpawnInterval: 60, // seconds between new weather cell spawns
  weatherMaxCells: 3,

  // --- input ---
  planeHitRadius: 24,
  pathSampleDist: 20, // min world-px between sampled drag points
  holdRadius: 120, // orbit radius for holds (must exceed v/turnRate for all types)
  // Stacked holds: orbit centers must be >= 2*holdRadius + separationMin*maxWake apart.
  holdStackAngleDeg: 45, // angular step when searching for a free orbit fix
  holdStackRadius: 90, // extra placement radius per retry slot (concentric stack)

  // --- airborne speed commands (player spacing tool) ---
  speedMultMin: 0.65,
  speedMultMax: 1.35,
  speedMultStep: 0.1,

  // --- determinism ---
  defaultSeed: 7,
  simStepHz: 60,
} as const;

// ---------- Pastel / soft palette — Mini Airways inspired ----------
// Light background, clean colors, high contrast text.
// Reads as modern, inviting, and premium without the dark "controller room" feel.
export const PALETTE = {
  // base
  bg: '#E8F0FE',
  bgAlt: '#DCE6F6',
  bgVignette: 'rgba(200,215,240,0.4)',

  // terrain hints
  terrain: '#D4E2D4',      // parks/green areas
  water: '#C5DAF0',        // water features
  cityBlock: '#D8D8D8',    // urban blocks

  // range rings / scope overlay
  ring: 'rgba(100,120,160,0.12)',
  ringText: 'rgba(80,100,140,0.45)',

  // runway
  runway: '#B8C4D0',
  runwayEdge: 'rgba(80,100,130,0.6)',
  runwayCenter: 'rgba(255,255,255,0.7)',
  corridorFree: 'rgba(70,130,220,0.25)',
  corridorBusy: 'rgba(230,160,60,0.35)',

  // taxiways
  taxiway: 'rgba(200,180,100,0.5)',
  taxiwayLine: '#C8B860',
  holdShort: '#E8854A',

  // aircraft
  blip: '#4A90D9',           // inbound arrivals
  blipDim: 'rgba(74,144,217,0.45)',
  trail: 'rgba(74,144,217,0.2)',
  departure: '#E8854A',     // departures / ground-bound
  departureDim: 'rgba(232,133,74,0.45)',
  gateParked: '#5AC06B',     // at gate / turnaround
  gateFree: 'rgba(90,192,107,0.2)',
  gateBusy: '#E8B54A',
  gateReady: '#5AC06B',      // ready to depart

  // interaction
  selected: '#2D3748',
  hover: 'rgba(45,55,72,0.15)',

  // warnings
  warn: '#E8A030',           // amber / caution
  danger: '#E85454',         // red / conflict / crash
  cash: '#3DA06B',           // money popups (green on light bg)

  // text
  text: '#2D3748',
  textDim: 'rgba(45,55,72,0.5)',
  textLight: '#FFFFFF',

  // panels / UI
  panel: 'rgba(255,255,255,0.88)',
  hudPanel: 'rgba(255,255,255,0.15)',
  panelEdge: 'rgba(100,120,160,0.2)',
  panelShadow: 'rgba(0,0,0,0.08)',

  // weather
  weatherCell: 'rgba(120,140,180,0.3)',
  weatherRain: 'rgba(100,120,160,0.5)',
} as const;

// ---------- Light dashboard palette for menu screens ----------
// Clean, modern, premium feel that contrasts with the in-game radar scope.
export const MENU_PALETTE = {
  bg: '#F8FAFC',
  bgGrad1: '#EEF2FF',       // subtle gradient start (cool lavender)
  bgGrad2: '#F8FAFC',       // gradient end (near-white)

  card: '#FFFFFF',
  cardHover: '#F7FAFF',
  cardBorder: '#E2E8F0',
  cardShadow: 'rgba(0,0,0,0.06)',
  cardShadowHover: 'rgba(74,144,217,0.15)',

  accent: '#4A90D9',        // matches gameplay blue
  accentLight: 'rgba(74,144,217,0.1)',
  accentHover: '#3A7BC8',

  success: '#48BB78',
  successBg: 'rgba(72,187,120,0.1)',

  danger: '#F56565',
  dangerBg: 'rgba(245,101,101,0.08)',

  text: '#1A202C',
  textSecondary: '#4A5568',
  textDim: '#A0AEC0',

  divider: '#E2E8F0',
  sliderTrack: '#E2E8F0',
  sliderFill: '#4A90D9',
  sliderThumb: '#FFFFFF',

  btnPrimary: '#4A90D9',
  btnPrimaryHover: '#3A7BC8',
  btnPrimaryText: '#FFFFFF',
  btnSecondary: '#EDF2F7',
  btnSecondaryHover: '#E2E8F0',
  btnSecondaryText: '#4A5568',

  tierHeader: '#F7FAFC',
  tierBorder: '#E2E8F0',
  locked: 'rgba(160,174,192,0.4)',
} as const;

/** Per-day difficulty knobs derived from CONFIG (career progression). */
export function dayDifficulty(day: number): {
  intervalFactor: number;
  rushWaveSize: number;
  gradeTarget: number;
  spawnIntervalStart: number;
  spawnIntervalEnd: number;
  rampDurationSeconds: number;
  emergencyStartAt: number;
  maxAirborneStart: number;
} {
  const d = Math.max(1, day);
  const onboarding = d === 1;
  return {
    intervalFactor: Math.max(CONFIG.dayIntervalFloor, Math.pow(CONFIG.dayIntervalFactor, d - 1)),
    rushWaveSize: onboarding
      ? CONFIG.day1RushWaveSize
      : CONFIG.rushWaveSize + Math.floor((d - 1) / CONFIG.dayRushBonusEvery),
    gradeTarget: CONFIG.gradeTargetBase + (d - 1) * CONFIG.gradeTargetPerDay,
    spawnIntervalStart: onboarding ? CONFIG.day1SpawnIntervalStart : CONFIG.spawnIntervalStart,
    spawnIntervalEnd: onboarding ? CONFIG.day1SpawnIntervalEnd : CONFIG.spawnIntervalEnd,
    rampDurationSeconds: onboarding ? CONFIG.day1RampDurationSeconds : CONFIG.rampDurationSeconds,
    emergencyStartAt: onboarding ? CONFIG.day1EmergencyStartAt : CONFIG.emergencyStartAt,
    maxAirborneStart: onboarding ? CONFIG.day1MaxAirborneStart : CONFIG.maxAirborneStart,
  };
}

export type RunwayLayout = (typeof CONFIG.runways)[number];
export type AircraftTypeKey = keyof typeof CONFIG.types;
