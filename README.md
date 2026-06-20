# Final Approach — ATC core-loop prototype

You're the tower controller. Planes stream into your airspace; you guide each one
onto a runway **without losing separation, fouling a runway, or running anyone out
of fuel.** A safe landing pays your salary. **Two crashes and you're fired.**
Traffic starts light and calm, then ramps to a holiday-rush climax with bursts and
emergencies.

This is a **feel prototype**. It pivots from an earlier transit prototype (now under
[`prototypes/transit/`](./prototypes/transit/)) to answer the question that one
couldn't: *does the real-time-with-pause loop feel tense and fun when the stakes are
real?* See [`NOTES.md`](./NOTES.md) for the findings — that report is the deliverable.

## Run it

```bash
npm install
npm run dev        # local dev server (http://localhost:5173)
npm run build      # -> dist/index.html : a single self-contained file
npm run preview    # serve the built bundle
```

`npm run build` emits **one self-contained `dist/index.html`** (JS + CSS inlined, no
external runtime calls) — the form the CrazyGames HTML5 target wants.

### Tests / verification

```bash
npm test           # typecheck + headless sim metrics + full-stack smoke test
npm run sim:test   # sim only: tension curve, determinism, per-step timing
npm run smoke      # runs real render/input/main against a stubbed DOM (no browser)
```

## Controls (mouse-first; no typed commands)

| Input | Action |
| --- | --- |
| **Drag a plane to a runway side** | If airborne: clear it to land from that end. If it's a **ready (cyan) departure** parked at a gate: launch it (takeoff in that direction). Each runway works **both** directions — drag to the side you want |
| **Click a plane, then click a runway side** | Same, as two clicks |
| **Right-click a plane** | Enter / leave a holding orbit (airborne only) |
| **Space** | Pause / resume — **you can still clear, dispatch, and hold while paused** |
| **R** | Start a new shift (same seed) |

CrazyGames key rules respected: pause is on `Space`; `Escape` and `Ctrl/Cmd+W` are
never bound. `?seed=<n>` sets the RNG seed (reproducible). `?autoplay=1` is a QA aid
that auto-clears inbound traffic so a fresh load shows a live, landing airport.

## What's in it

- **Two runways, each landable from either end** (four approach corridors total);
  the whole strip is occupied during a landing, so opposite-end approaches can't
  run simultaneously. You choose the approach side per plane.
- **Aircraft** in three types (small / medium / heavy) differing in speed, turn
  rate, and wake separation — all rendered as radar blips with callsign data blocks,
  heading-prediction vectors, and trails.
- **Separation conflicts**: an amber/red alert ring appears when two planes get too
  close; you have a fixed reaction window (and the pause, and go-arounds) before it
  becomes a crash. Resolving it in time = a logged near-miss.
- **Fuel**: depletes over the flight; low fuel becomes a priority emergency; empty =
  crash.
- **Emergencies**: medical (must land, can't go around, blocks the runway longer for
  assistance) and low-fuel.
- **Economy**: salary per landing (+ on-time bonus, + heavy bonus); penalties for
  go-arounds, near-misses, diversions; a crash is brutal.
- **Difficulty ramp**: calm onboarding from the approach side, widening to all
  directions, faster arrivals, more heavies, then periodic **rush waves**.

### Ground control (the second board)

- **Gates** at a terminal between the runways. A landed arrival **taxis to a free
  gate** (or idles on the ramp if they're all full), runs a **turnaround**
  (deplane / refuel / board), and then goes **ready to depart** (cyan, pulsing).
- **Departures**: drag a ready plane to a runway side to dispatch it — it taxis to
  the hold-short, waits for the strip to be **clear** (it won't roll into a
  landing), takes off in that direction, climbs out, and leaves the airspace for a
  payout.
- **The whole runway is shared** by landings *and* takeoffs from both ends, so you're
  now sequencing two streams over the same two strips — the core new tension. Ground
  traffic isn't subject to air separation; a climbing departure is.

## Architecture

The same strict separation as the transit prototype (the loop is proven; this is a
model swap on top of it):

```
src/
  config.ts   All tuning constants + the radar palette. Tweak here.
  rng.ts      Seeded PRNG (mulberry32). The sim uses ONLY this, never Math.random.
  types.ts    Shared data model (Aircraft, Runway, GameState, ...).
  sim.ts      All game state + update(state, dt). No DOM, no canvas, no input.
  render.ts   Draws a GameState as a radar scope. Interpolates motion. No logic.
  input.ts    Mouse/keyboard -> player actions on the sim. Produces render hints.
  main.ts     Fixed-timestep loop (sim @ 60 Hz; render on rAF with interpolation).
  sdk.ts      No-op CrazyGames SDK interface (forward hook; not integrated).
tools/
  headless.ts Sim metrics harness (auto-controller + tension/determinism/perf).
  fakedom.ts  Minimal DOM/Canvas2D stub for the smoke test.
  smoke-dom.ts Full-stack runtime smoke test.
prototypes/
  transit/    The earlier Headway transit prototype (source + its report), preserved
              for reference. Its entry was the root index.html, which now loads ATC.
```

- **Determinism:** same seed + same player actions ⇒ identical evolution. Randomness
  flows only through `state.rng`. Verified by the harness.
- **Pause-to-replan:** sim time freezes while all commands stay live; resume is
  seamless (the renderer interpolates from a per-tick snapshot).

## Scope (and what's deliberately deferred)

Implemented: the air core (arrivals, bidirectional runways, separation, fuel,
emergencies, ramp) **plus the ground-control layer** (gates, taxi-in, turnaround,
departures, takeoffs, shared-runway contention).

Still deferred (next increments): a real **taxiway network** with manual taxi
routing and **runway-crossing conflicts** (the current taxi is auto-routed
straight-line and the terminal sits between the runways so nothing has to cross an
active strip); plus typed ATC-language commands, weather, multiple airports, and
meta-progression.
