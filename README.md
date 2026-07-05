# Final Approach — you are the tower

Real-time air traffic control in the browser. Planes stream into your airspace;
you guide each one onto a runway, taxi it to a gate, turn it around, and launch
it again — **without losing separation, fouling a runway, or running anyone out
of fuel.** A shift is **6 minutes**, graded S→F, ending in a **final rush**
climax. Each career day is harder than the last. **Two crashes and you're fired.**

Fully synthesized audio (no assets), mouse + touch input, single-file build.

## Run it

```bash
npm install
npm run dev        # local dev server (http://localhost:5173)
npm run build      # -> dist/index.html : ONE self-contained file
npm run preview    # serve the built bundle
```

## Deploy

`npm run build` emits a single self-contained `dist/index.html` (JS + CSS + audio
all inlined; zero external requests). Deploying = putting that one file anywhere:

- **Netlify / Vercel / GitHub Pages**: publish the `dist/` folder.
- **itch.io**: zip `dist/index.html` (as `index.html`) and upload as an HTML5 game.
- Any static file host or CDN works; there is no server component. Scores,
  career day, and mute preference persist in `localStorage`.

### Tests / verification

```bash
npm test           # typecheck + headless sim metrics + full-stack smoke test
npm run sim:test   # sim only: tension curve, determinism, per-step timing
npm run smoke      # runs real render/input/main against a stubbed DOM (no browser)
```

## Controls (mouse-first; touch works)

| Input | Action |
| --- | --- |
| **Drag a plane to a runway side** | If airborne: clear it to land from that end. If it's a **ready (cyan) departure** at a gate: launch it in that direction. Each runway works **both** directions |
| **Tap a plane, then tap a runway side** | Same, as two taps |
| **Click an airborne plane** | Opens floating menu: **Abort** to go-around |
| **Click a taxiing plane** | Opens floating menu: **Hold / Go** to manually stop or resume ground taxi |
| **Right-click / double-tap a plane** | Enter / leave a holding orbit (airborne only) |
| **Space** | Pause / resume — **you can still clear, dispatch, and hold while paused** |
| **M** | Mute / unmute · **R** restarts the shift |
| **On-screen buttons** | PAUSE / SOUND / HOLD (bottom-right; touch-friendly) |

`?seed=<n>` sets the RNG seed (reproducible run). QA aids: `?autoplay=1`
auto-clears traffic; `?ff=<seconds>` fast-forwards the sim at load.

## What's in it

- **A session with a shape**: calm onboarding → density ramp → rush waves → a
  **FINAL RUSH** in the last 75 s → **debrief with a letter grade** (S–F, scaled
  to your career day), career-best tracking, and a next-day difficulty bump.
- **Base-Building & Progression**: Start your career at a tiny airfield with a single
  runway and 3 gates. Use your shift earnings in the **upgrade shop** to unlock
  new runways (creating complex intersections), new gate terminals, and advanced radar tech!
- **Streak economy**: consecutive safe landings/departures multiply pay (up to
  ×2); any near-miss, diversion, or crash resets it.
- **Line Up & Wait**: Departures now taxi to the runway threshold and hold short. They must be explicitly cleared for takeoff by tapping them, which brings up the Takeoff button. This allows you to position aircraft on the runway for immediate departure when a gap in arrivals occurs.
- **Air & Ground Control**: Click planes to open a floating context menu.
  Order an **Abort** for an immediate go-around on approach. Command taxiing planes to **Hold Short**
  or **Continue Taxi** to resolve ground deadlocks.
- **Predictive conflict alerts**: closures are projected ~12 s ahead — an amber
  ✕ marks *where* separation will be lost and in how many seconds, before the
  red alert (with visible countdown-to-collision ring) ever starts.
- **Synthesized audio**: radio chirps, touchdown thumps, streak-rising cash
  chimes, mayday tones, a conflict klaxon, crash booms, ambience — all WebAudio,
  zero asset files.
- **Juice**: floating +$ popups, screen shake, incident flash, event banners,
  animated cash counter, radar sweep.
- **Runways work from either end** (four approach corridors per runway);
  landings and takeoffs share the strips, so you sequence two streams over one
  resource. Gates, taxi, turnarounds, and departures make every arrival worth
  two payouts.
- **Emergencies**: medical (must land, blocks the runway longer) and low fuel.

## Architecture

Strict separation, deterministic sim:

```
src/
  config.ts   All tuning constants + palette + per-day difficulty. Tweak here.
  rng.ts      Seeded PRNG (mulberry32). The sim uses ONLY this, never Math.random.
  types.ts    Shared data model (Aircraft, Runway, GameState, GameEvent, ...).
  sim.ts      All game state + update(state, dt). No DOM. Emits GameEvents.
  render.ts   Draws a GameState as a radar scope. Interpolates motion. No logic.
  input.ts    Pointer/keyboard -> player actions. Produces render hints.
  ui.ts       Screen-space button layout shared by render + input.
  audio.ts    WebAudio synth engine (event-driven; no assets).
  fx.ts       Render-only feedback: popups, shake, banners, cash tween.
  main.ts     Fixed-timestep loop + session flow (briefing→shift→debrief→next day),
              localStorage persistence, event draining into audio/fx.
  sdk.ts      No-op platform SDK interface (forward hook).
tools/
  headless.ts Sim metrics harness (auto-controller + tension/determinism/perf).
  fakedom.ts  Minimal DOM/Canvas2D stub for the smoke test.
  smoke-dom.ts Full-stack runtime smoke test (input → sim → render, 20 checks).
```

- **Determinism:** same seed + same player actions ⇒ identical evolution. The
  sim communicates outward only through `state.events` (drained by `main` for
  audio/fx), so feedback never touches the simulation. Verified by the harness.
- **Pause-to-replan:** sim time freezes while all commands stay live.

## Deferred ideas

## Deferred ideas

Weather cells to route around, a shared daily-seed challenge board, and more
complex progressive taxi routing.
