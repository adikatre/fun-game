# Headway — core-loop prototype

A playable prototype of **Headway** (working title): a roguelike transit-routing
game — *Mini Metro crossed with a roguelike deckbuilder*. You draw and redraw
transit lines to move passengers before stations overflow, pausing to replan as a
city keeps growing.

This is a **feel prototype**, not the game. It exists to answer one question:
**does the real-time-with-pause routing loop feel tense, responsive, and
satisfying?** See [`NOTES.md`](./NOTES.md) for the answer and findings — that
report is the real deliverable.

## Run it

```bash
npm install
npm run dev        # local dev server (http://localhost:5173)
npm run build      # -> dist/index.html : a single self-contained file
npm run preview    # serve the built bundle
```

`npm run build` emits **one self-contained `dist/index.html`** (JS + CSS inlined,
no external runtime calls) — the form the CrazyGames HTML5 target wants.

### Tests / verification

```bash
npm test           # typecheck + headless sim metrics + full-stack smoke test
npm run sim:test   # sim only: tension curve, determinism, per-step timing, routing stats
npm run smoke      # runs real render/input/main against a stubbed DOM (no browser)
```

## Controls

| Input | Action |
| --- | --- |
| **Drag station → station** | Create a new line (uses a free line slot) |
| **Drag from a line endpoint → station** | Extend that line |
| **Right-click a line** | Delete it |
| **Click a line chip** (bottom-left) | Delete that line |
| **Space** | Pause / resume — **you can still draw, extend, and delete while paused** |
| **R** | Restart (same seed) |
| `1` / `2` / `3` | Pick an upgrade during a rush-hour draft |

CrazyGames key rules are respected: pause is on `Space`; `Escape` and `Ctrl/Cmd+W`
are never bound. Mouse-first; structured so touch can be added later.

`?seed=<n>` in the URL sets the RNG seed (reproducible runs). `?autodraw=1` is a QA
aid that auto-connects the starting stations so a fresh load shows a live network.

## Architecture

Strict separation so the sim stays pure, deterministic, and easy to tune:

```
src/
  config.ts   All tuning constants + the warm color palette. Tweak here.
  rng.ts      Seeded PRNG (mulberry32). The sim uses ONLY this, never Math.random.
  types.ts    Shared data model.
  sim.ts      All game state + update(state, dt). No DOM, no canvas, no input.
  render.ts   Draws a GameState to canvas. Interpolates train motion. No logic.
  input.ts    Mouse/keyboard -> player actions on the sim. Produces render hints.
  main.ts     Fixed-timestep loop (sim @ 60 Hz; render on rAF with interpolation).
  sdk.ts      No-op CrazyGames SDK interface (forward hook; not integrated).
tools/
  headless.ts Sim metrics harness (auto-player + tension/determinism/perf report).
  fakedom.ts  Minimal DOM/Canvas2D stub for the smoke test.
  smoke-dom.ts Full-stack runtime smoke test.
```

- **Determinism:** same seed + same player actions ⇒ identical evolution. Randomness
  flows only through `state.rng`. Verified by the harness (identical delivered
  counts and RNG state across repeated runs).
- **Routing:** multi-source BFS per shape over the union of all line adjacencies
  (shared stations are free transfers). A passenger boards/stays iff the train's
  current pass reaches a strictly-closer station; a 25 s fallback prevents
  deadlock. Recomputed on any structural change. Pragmatic, not optimal — by design.

## Acceptance criteria (brief §7)

1. ✅ Draw / extend / delete lines with the mouse; new lines auto-run a train.
2. ✅ Passengers spawn, board, transfer across shared stations, get delivered.
3. ✅ Stations crowd; sustained overflow costs strain; max strain ends the run with
   a final score.
4. ✅ `Space` pauses; lines editable while paused; resume is seamless.
5. ✅ Stable 60 fps with 12 stations / 3 lines / multiple trains (sim ~0.0004 ms/step).
6. ✅ Difficulty escalates over ~3 minutes (and then plateaus — see `NOTES.md` §1).
7. ✅ Deterministic for a fixed seed + identical input.

## Out of scope (and intentionally not built)

The real upgrade/hazard decks (only a throwaway M4 draft stub exists),
meta-progression, multiple cities/operators, final art/audio, the real CrazyGames
SDK, and touch/mobile + multiplayer. See brief §8.
