# Headway — prototype report (post-M3, + M4 stub)

> The brief says this note is the actual output that matters. It answers the one
> question the prototype exists for: **does the real-time-with-pause routing loop
> feel tense, responsive, and satisfying?** — backed by instrumented sim runs and
> a runtime smoke test of the full render/input stack.

## TL;DR

- **Built:** M1–M3 in full, plus the optional M4 draft stub. All seven acceptance
  criteria (§7) are met. See `README.md` for the checklist and how to run.
- **Responsiveness:** excellent. Sim costs **~0.0004 ms/step** loaded (12 stations,
  3 lines, trains) — about **0.025 ms of CPU per real second**. 60 fps is never in
  question; the bottleneck would be the canvas, not the sim.
- **Pause-to-replan (the feature under test): works and feels right.** Time freezes
  cleanly, you can draw/extend/delete while paused, and resume has no jump.
- **Tense but fair?** The *opening and mid-game are*. The **late game goes flat**:
  once stations cap (~12) and the spawn ramp finishes (~3 min), an adequately
  routed network reaches a stable steady state and never breaks down. That's the
  #1 feel problem to fix.
- **Routing:** the greedy heuristic delivers ~97% of riders, but a chunk only move
  because of the anti-deadlock fallback. I improved the heuristic mid-build
  (one-hop → full-pass look-ahead), cutting fallback boardings from **32.6% → 22.4%**.

---

## How this was measured

Two harnesses (run with `npm run sim:test` and `npm run smoke`; both are bundled
with esbuild and run under Node, since `sim.ts` is DOM-free):

1. **`tools/headless.ts`** — runs the pure sim with a crude greedy auto-player
   (connects loose stations to the nearest line endpoint). It is *not* skilled
   play; it exists to keep passengers flowing so the mechanics can be observed.
2. **`tools/smoke-dom.ts`** — stubs DOM + Canvas2D and runs the real
   `main`/`render`/`input` modules, firing synthetic mouse/keyboard events to
   confirm the whole stack initializes, renders thousands of frames, and reacts to
   input without throwing (15/15 checks pass).

I also captured live headless-Chrome screenshots of (a) a running, delivering
network, and (b) the M4 rush-hour draft, to confirm the visuals render.

---

## 1. Does the loop feel tense but fair?

**Failure mode works.** Do nothing and the run ends at **t ≈ 75 s** (strain hits 3
from station overflow). The opening is a genuine call to action.

**Tension curve (greedy auto-player, seed 1337), waiting = total queued, maxQ = fullest station:**

```
 t(s)  delivered  strain  waiting  maxQ
   20          0       0        2     1
   60         12       0        2     2
   80         13       0        6     4
  120         31       0        7     3
  160         46       0        9     3
  200         80       0       12     3
  220         91       0       13     5     <- ramp done, stations capped
```

- **Opening (0–60 s): fair, maybe a touch slow.** First passenger at ~4 s, queues
  stay tiny. The pressure to build is real but gentle.
- **Mid-game (60–180 s): the good part.** Spawn rate ramps, the 12th station
  arrives, the fullest stations reach 5/6 capacity, and you feel the network
  straining. This is where the loop is tense and the pause-to-replan matters.
- **Late-game (>180 s): flat.** The ramp holds and no new stations spawn, so a
  network that was keeping up keeps up *forever*. The auto-player survived a full
  **600 s with strain 0**. There is no escalating breakdown for competent play —
  only a steady grind. **This is the main fairness/flatness issue.**

**So:** tense-but-fair in the first ~3 minutes, then it plateaus. For a human with
imperfect routing and reaction time the mid-game margin (maxQ 5/6) should bite, but
the absence of late escalation means a good player is never *forced* to break.

## 2. Frame timing under load

- **Sim:** 18,000 steps (5 sim-minutes) in ~7 ms ⇒ **~0.0004 ms/step**. A 16.6 ms
  frame could fit ~40,000 sim steps. The sim is effectively free.
- **Stutter risk is on the render/GC side, not the sim.** Per frame the renderer
  allocates a `Map` (station lookup) and a couple of gradient objects. At this
  scale it's immaterial and I observed no hitching across a driven 2-minute run,
  but those allocations are trivially cacheable if profiling ever flags them.
- **Routing recompute** (multi-source BFS per shape) runs on every structural
  change and every new station. With ≤12 nodes it's sub-microsecond; no concern.
- Fixed-timestep loop clamps `dt` to 0.25 s and caps catch-up steps, so a
  backgrounded tab won't spiral.

## 3. Routing weirdness

The heuristic is intentionally greedy (per the brief): BFS gives each station its
hop-distance to the nearest station of each shape; a passenger boards/stays iff the
train, in its current pass, reaches a station strictly closer to their destination
shape. Observed behavior:

- **Fallback reliance.** Even after the look-ahead fix, **~22% of deliveries happen
  via the 25 s anti-deadlock fallback** (down from ~33% with naive one-hop
  look-ahead). Average trip time is ~22 s — uncomfortably close to the 25 s
  threshold. Translation: a meaningful minority of passengers sit and *refuse
  visibly-available trains* until they panic-board. To a player this can read as a
  bug even though it's the rule working as written.
- **Why they refuse:** (a) during ramp-up a passenger's destination shape may be
  temporarily unreachable (no line connects it yet) — legitimate pressure; and
  (b) on a ping-pong line a passenger whose destination is "behind" the train must
  wait a full half-cycle for the return pass — correct, but it looks like the train
  is ignoring them.
- **No infinite looping observed.** Because boarding requires a *strict* distance
  decrease, a riding passenger's distance is monotonically non-increasing, so no
  oscillation. Determinism holds exactly (identical delivered count and RNG state
  across repeated seeded runs).
- **Hotspots.** The "bias destinations toward far shapes" spawn rule does
  concentrate demand for distant shapes, which can over-load one station. It's a
  feature (pressure) but worth watching during tuning.

## 4. Top 3 changes that would most improve the feel

1. **Give the late game an escalation knob.** Right now everything stops growing at
   ~3 minutes and a competent network coasts. Keep the pressure rising past the
   ramp: continue spawning stations beyond 12 (forcing line re-draws), and/or push
   spawn interval below the current floor, and/or add periodic demand spikes. The
   loop needs a reason to *break* eventually, not just a plateau to grind.

2. **Make the boarding rule less of a cliff and more legible.** Two cheap moves:
   (a) lower `stuckPassengerFallback` from 25 s toward ~12 s so the safety net
   isn't a long, visible stall; and (b) when a passenger deliberately *won't* board
   (wrong-direction pass / no progress), render that intent — e.g., dim those
   waiting shapes — so the refusal reads as a decision, not a glitch. Optionally
   board on distance-*non-increase* when a transfer is one hop away.

3. **Turn up crowding feedback and reward the pause.** Capacity 6 / 10 s overflow /
   3 strain is forgiving and the only warning is the thin overflow ring. Make a
   crowding station read loudly (body color shift + a pulse as it nears overflow),
   surface the per-station danger while *paused* (the replan moment should spotlight
   what's about to fail), and consider that **1 train per new line is too few** —
   trains are the main throughput lever yet you only get more via the draft.

### Smaller notes / nice-to-haves
- Draw-vs-extend is gesture-inferred (drag from a line endpoint = extend, else new
  line). It's intuitive but means you can't start a *new* line from a station
  that's already an endpoint without a free-station detour — fine for the
  prototype, worth an explicit modifier later.
- The M4 "+1 Train" upgrade auto-targets the busiest line (no target UI); good
  enough for pacing tests, not for the real draft.
- Deterministic seeding is wired (`?seed=` in the URL) — a ready hook for daily
  runs.
