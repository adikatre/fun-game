# Final Approach — prototype report

> This pivots the earlier transit prototype (which felt low-stakes — "just
> connecting shapes") into an ATC game, to test whether the **real-time-with-pause
> loop feels tense and fun when the stakes are real**: crashes, fuel, your job.
> The transit prototype and its report are preserved under `prototypes/transit/`.

## Update log (newest first)

**Fun/UX overhaul + deployment readiness (July 2026).** The prototype became a
game. What changed and why:

1. **Timed shifts with a grade (the big structural fix).** The old
   endless-until-fired loop plateaued into a grind. A shift is now 6 minutes
   with an arc — ramp → rush waves → a **FINAL RUSH** in the last 75 s — ending
   in a debrief screen with a letter grade (S–F, target scales per career day),
   career-best tracking (`localStorage`), and a NEXT SHIFT that's genuinely
   harder (spawn intervals shrink ~7%/day, rush waves grow). Two crashes still
   fires you on the spot.
2. **Fully synthesized WebAudio** (`audio.ts`): radio chirps on clearances,
   touchdown thump + cash chime that rises a semitone per streak, spool-up
   whoosh on departures, mayday two-tones, a pulsing conflict klaxon driven by
   live alert level, crash boom, ambience, shift-end jingle. Zero asset files;
   the build stays one HTML file. Mute persists (M key / on-screen button).
3. **Predictive conflict warnings.** The flat 3.6 s red window felt twitchy
   (called out in the original report). The sim now projects closures 12 s
   ahead: an amber ✕ marks *where* separation will be lost and in how many
   seconds; the red phase shows a countdown ring + seconds-to-impact. Deaths
   feel earned; pause is a planning tool instead of a panic button.
4. **Streak economy.** Consecutive safe landings/departures multiply pay up to
   ×2 (HUD badge; near-miss/diversion/crash resets). Gives the mid-game a
   risk/reward pull the flat economy lacked.
5. **Juice** (`fx.ts`): +$ popups at the touchdown point, screen shake + red
   flash on incidents, sliding event banners (MAYDAY / RUSH / FINAL RUSH),
   eased cash counter, radar sweep. All render-side; the deterministic sim
   communicates through a drained `state.events` queue, so determinism is
   untouched (harness: PASS).
6. **Touch + UX**: pointer events, double-tap = hold, on-screen PAUSE/SOUND/
   HOLD buttons (shared layout in `ui.ts` so render and hit-testing can't
   disagree), tap-empty-space deselects, briefing/start screen that also
   unlocks audio, proper end screens with buttons.
7. **Deployment**: meta/OG tags, inline SVG favicon, `?ff=` QA fast-forward.
   `dist/index.html` is 52 KB (17 KB gzip), zero external requests.

Verification: typecheck clean, determinism PASS, 0.0016 ms/step loaded,
20/20 smoke checks (now covering briefing → shift → debrief → next-day flow),
headless-Chrome screenshots of briefing, mid-game (streaks, occupied-runway
amber, inbound strip), and the fired screen.

**Ground control layer + bidirectional runways.** Two additions on top of the
air-core v1 below:

1. **Bidirectional runways** — each strip is landable (and now departable) from
   *either* end (four approach corridors: 27L/27R + 09R/09L). You pick the side by
   dragging the plane to it. This alone made the auto-controller *better* (planes
   approach from whichever side they're already on — fewer U-turns: handled 8→17 in
   the 600 s bot run).
2. **Ground control** — landed arrivals taxi to a **gate**, run a **turnaround**
   (refuel/board), then go **ready to depart**; the player dispatches them by
   dragging to a runway side, and they taxi out, hold short, take off, and climb away
   for a payout. **Landings and takeoffs share the same two runways**, so you now
   sequence two streams over one resource — the core new tension.

What this did to the game (auto-controller, seed 7):

```
 t(s)  landed  departed  cash      (air-core only, for comparison: by 160s ~$1,120, 0 dep)
   60     3        1     $534
  100     5        3     $1,063
  140     7        5     $1,636   <- departures roughly double the revenue per plane
```

- **Economy deepened**: each plane can earn twice (a landing *and* a departure), and
  the curve climbs faster — more reward, and a real reason to keep gates cycling.
- **Difficulty rose, as intended**: sharing runways between landings and takeoffs is
  a genuine squeeze, so the naive bot now gets fired ~3 min in (vs ~5.8 with
  arrivals only). A human juggling both streams with pause + sequencing is the test.
- **Determinism still PASS**; per-step cost rose to ~**0.0025 ms/step** loaded (the
  O(n²) ground-spacing check) — still ~0.15 ms CPU per real second, 60 fps untouched.
- **15/15 full-stack smoke checks pass**, including a full
  land → taxi → turnaround → dispatch → takeoff cycle and bidirectional-end assigns.
- **Deferred next**: a real taxiway network + manual taxi routing + runway-crossing
  conflicts (taxi is currently auto-routed straight-line; the terminal sits between
  the runways so nothing crosses an active strip).

---

## TL;DR (air-core v1)

- **Built:** the agreed **air-core v1** — arrivals, two runways with approach
  corridors, separation conflicts, fuel + low-fuel/medical emergencies, the traffic
  ramp + rush waves, economy (salary / penalties), and **2-crashes-and-you're-fired**.
- **It's a model swap on a proven loop, not a rewrite.** The fixed-timestep sim,
  rAF interpolation, seeded determinism, `Viewport` transform, pause-to-replan, and
  the strain→failure pattern all carried straight over from the transit prototype.
- **Stakes are fixed.** Doing nothing now means planes converge and *collide*
  (no-input run is fired in ~4–4.5 min). A clean landing pays salary; a crash is
  brutal (−$500). The "low stakes" complaint is gone.
- **The curve is right:** a calm, profitable opening (a naive auto-controller banks
  ~$1,120 over the first 160 s with **zero incidents**), then escalating density
  causes a breakdown around the 3-minute mark.
- **Responsiveness:** sim is ~**0.0004–0.0007 ms/step** loaded → 60 fps has enormous
  headroom. Pause-to-replan works and is *more* compelling here than in transit.
- **Verification:** determinism PASS, 13/13 full-stack smoke checks pass, single
  self-contained `dist/index.html` builds, and live headless-Chrome screenshots
  confirm the radar scope, ILS approaches, a MAYDAY emergency, and the fired screen.

## How this was measured

- **`npm run sim:test`** — pure sim + a crude auto-controller (clear one plane to
  final per runway, sequence a second when the leader is far down the approach, park
  the rest in holds, break conflicts by holding). It is *not* skilled play; it keeps
  traffic flowing so the loop can be observed. Reports the tension curve,
  determinism, and per-step timing.
- **`npm run smoke`** — stubs DOM + Canvas2D and runs the real `main`/`render`/`input`
  modules, firing synthetic clicks/drags/keys: click-to-land, drag-vector,
  right-click hold, Space pause + freeze, edit-while-paused, restart, long run.
- **Live headless-Chrome screenshots** of calm opening, an ILS approach, a MAYDAY,
  and the "YOU'RE FIRED" summary.

---

## 1. Does the loop feel tense — and fair?

**Tension curve (auto-controller, seed 7):**

```
 t(s)  handled  incidents  airborne   cash
   20        1          0         0    $156
   80        4          0         1    $572
  120        6          0         2    $918
  160        8          0         4   $1120     <- calm + profitable
  180        8          1         5    $240      <- density spikes, first crash
  (fired at ~3:00–3:35 across runs)
```

- **Opening is calm, legible, and rewarding.** Early arrivals enter from the
  approach side (east), so click-a-plane → click-a-runway just works and the salary
  ticks up. This is the addictive on-ramp the brief asked for — and it emerged
  naturally once spawns stopped knifing into the exact center.
- **Mid-game tightens.** Spawns widen to all directions, heavies (bigger wake) appear,
  and rush waves stack arrivals. Two runways become the bottleneck; you start
  sequencing and holding. This is where pause-to-replan earns its keep.
- **Breakdown is real.** A weak controller crashes out ~3 min in; a human reacting in
  real time (plus pause + go-arounds) should last well beyond that. Unlike the
  transit prototype, there's a genuine fail state that *bites*.
- **Fairness levers are in place:** conflicts warn before they kill (a fixed
  ~3.6 s window once the alert shows), go-arounds defuse a bad approach for cash not
  a life, low fuel flags early, and you can pause to think. Two crashes (not one)
  gives recovery room.

**Where it's still flat / unfair (honest):**
- **Late-game plateaus**, same structural issue the transit report flagged: after the
  ramp + max concurrency, pressure stops *rising*. Rush waves help but it becomes a
  steady grind rather than a mounting climax.
- **The 3.6 s conflict window can feel twitchy** with fast closures between two
  heavies — sometimes the alert and the crash are close together. Needs a closure-
  rate-aware warning, not a flat timer.
- **Auto-approach from the wrong side draws ugly paths** and can trigger an
  unfair-feeling go-around; manual drag-vectoring is the workaround but a new player
  won't know to reach for it.

## 2. Frame timing under load

- Sim: **0.0004–0.0007 ms/step** with a dozen-plus aircraft. A 16.6 ms frame fits
  ~25,000–40,000 sim steps; the sim uses ~0.04 ms of CPU per real second. 60 fps is
  never the sim's problem.
- The conflict check is O(n²) over airborne planes, but n ≤ ~13, so it's trivial.
- Per-frame render allocations are minor (a few gradients, an inbound-strip sort);
  no hitching observed across long driven runs. Cacheable if ever needed.
- Fixed-timestep loop clamps `dt` and caps catch-up steps, so a backgrounded tab
  won't spiral.

## 3. Bugs / weirdness found and fixed during the build

- **Holds drifted out of bounds → mass diversions.** `holdRadius` (46 px) was tighter
  than the turn radius a heavy needs at cruise (`v/turnRate` ≈ 128 px), so holding
  planes spiraled outward and left the airspace. Raised to 120 px; diversions went
  from ~27/run to **0**. (General rule now noted in config: hold radius must exceed
  `v/turnRate` for every type.)
- **Spawns knifed into the exact center**, creating an unavoidable collision knot and
  a harsh opening. Now each plane aims at a spread point near the airport and early
  traffic enters from the approach side, widening over time.
- **Economy was over-punishing** (diversion −80, near-miss −60 stacking into a death
  spiral). Softened to −45 / −35; a crash (−500) is the thing that really hurts.

## 4. Top 3 changes that would most improve the feel

1. **Add ground operations next (departures + taxi).** This is the agreed next layer
   and it's also the biggest *fun* unlock: departures contend for the same runways as
   arrivals, taxi/queue/crossing conflicts add a second board to manage, and it turns
   "land the arrivals" into the real juggling act people picture when they think ATC.
   It also fixes the late-game plateau by adding a second, independent pressure source.
2. **Make conflict prediction proactive, not just reactive.** Draw the closure — when
   two heading vectors will intersect inside separation, highlight the *future*
   conflict point and time-to-conflict, and scale the warning by closure rate instead
   of a flat 3.6 s timer. This makes the tension readable and the deaths feel earned,
   and it makes the pause genuinely a planning tool rather than a panic button.
3. **Teach vectoring, and add a speed lever.** New players will only click-to-land and
   then feel helpless in the rush. A 10-second guided first arrival ("drag me onto
   downwind"), plus a simple speed-up/slow-down control (the real controller's primary
   spacing tool), would deepen the skill ceiling and let players *solve* the squeeze
   instead of just holding everything.

### Smaller notes
- "+1 Train"-style end-of-shift upgrades are stubbed (`openDraft`/`applyDraftOption`)
  but not wired into the loop — an easy A4 to test the wave→reward rhythm (e.g. "open
  a 3rd runway", "fuel reserves", "faster turnaround").
- Altitude is cosmetic in v1 (descends on final, shown in the data block); conflict is
  purely lateral so the separation game stays readable. Real altitude/holds-by-level
  is a later depth knob.
- Deterministic seeding is wired (`?seed=`), ready for daily-shift leaderboards.
