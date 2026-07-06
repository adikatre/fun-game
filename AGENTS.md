# AGENTS.md — Final Approach

Instructions for AI coding agents working in this repo.

## Overview

**Final Approach** is a browser ATC game: TypeScript + Vite, no framework, no
backend. A deterministic fixed-timestep sim (`sim.ts`) drives everything; render
and input are side-effect-free consumers. The production build is a **single
self-contained `dist/index.html`** (JS, CSS, fonts, and audio inlined).

Session flow: `menu` → `tutorial` (how to play) → `playing` (6-min shift) →
`debrief` / `fired` → `upgrade` shop → next day.

## Setup & commands

```bash
npm install
npm run dev          # Vite dev server (http://localhost:5173)
npm run build        # typecheck + single-file dist/index.html
npm test             # typecheck + sim:test + smoke (run before committing gameplay changes)
npm run sim:test     # headless sim only (determinism, tension curve, perf)
npm run smoke        # full-stack smoke (fake DOM, synthetic input)
npm run gen:audio    # regenerate src/assets/audio-data.ts from tools/gen-audio.mjs
```

URL query aids: `?seed=<n>` (reproducible run), `?autoplay=1`, `?ff=<seconds>`.

## Architecture rules (do not break)

1. **Determinism** — `sim.ts` uses only the seeded `Rng` from `rng.ts`, never
   `Math.random`. Same seed + same player actions ⇒ identical evolution. Verified
   by `npm run sim:test`.
2. **Sim isolation** — `sim.ts` has no DOM, no audio, no rendering. It emits
   `GameEvent`s on `state.events`; `main.ts` drains them into `audio.ts` and
   `fx.ts` each frame. Never feed audio/fx back into the sim.
3. **Render is dumb** — `render.ts` draws `GameState` + `RenderHints` from
   `input.ts`. No game logic in render.
4. **Shared UI layout** — on-screen button hit targets live in `ui.ts` and are
   used by both `render.ts` and `input.ts` so visuals and clicks stay aligned.
5. **Pause-to-replan** — when paused, sim time freezes but all player commands
   (clear, dispatch, hold, abort) remain live.
6. **Headless safety** — `audio.ts`, `music.ts`, and `ambience.ts` no-op until a
   real `AudioContext` exists and the user has gestured (`audio.unlock()`).

## Where to change things

| Goal | File(s) |
| --- | --- |
| Tuning (spawn rates, separation, economy, palette) | `src/config.ts` |
| Game rules, aircraft phases, conflicts | `src/sim.ts`, `src/types.ts` |
| Drawing / HUD | `src/render.ts` |
| Controls / context menus | `src/input.ts`, `src/ui.ts` |
| Procedural SFX | `src/audio.ts` |
| Background music crossfades | `src/music.ts` |
| Ambience layers | `src/ambience.ts` |
| Music/ambience source clips | `tools/gen-audio.mjs` → `npm run gen:audio` |
| Between-shift upgrades | `src/upgrades.ts`, `src/upgrade-layout.ts` |
| Career stats | `src/stats.ts` |
| Juice (popups, shake, banners) | `src/fx.ts` (render-side only) |

## Audio pipeline

- **Runtime SFX** are synthesized in `audio.ts` (WebAudio oscillators, noise,
  envelopes).
- **Music stems** (`menu`, `gameBase`, `gamePulse`, `gameTension`) and the
  **ambience bed** are rendered offline by `tools/gen-audio.mjs`, encoded to MP3,
  and committed as base64 in `src/assets/audio-data.ts`. The raw `.mp3` files in
  `src/assets/audio/` are build artifacts for reference; the game reads
  `audio-data.ts` at runtime.
- After changing `gen-audio.mjs` or stem design, run `npm run gen:audio` and
  commit both `audio-data.ts` and any updated `.mp3` files.
- `MusicDirector` starts all game stems sample-synced and crossfades gains by
  intensity; do not break phase-locking when editing stems.

## Testing expectations

- Gameplay or sim changes: run `npm test` and fix failures before finishing.
- Smoke tests boot from `menu`, click through `tutorial` → `playing`, and
  exercise land/taxi/depart cycles. Status string is `tutorial` (not `briefing`).
- Do not delete or weaken determinism checks in `tools/headless.ts`.

## Conventions

- TypeScript strict; ES modules; no React/Vue.
- Keep diffs focused — match existing naming and module boundaries.
- `prototypes/transit/` is a preserved earlier prototype; do not modify unless asked.
- `NOTES.md` is a human design log, not agent instructions.
- Only create commits when the user asks. Do not push unless asked.

## Common pitfalls

- **Hold radius** must exceed `v / turnRate` for every aircraft type (see
  `config.ts` comments) or holds drift out of bounds.
- **Bidirectional runways** — landings and departures share strips; player picks
  the end by drag target.
- **Ground phases** (`taxiIn`, `atGate`, `readyDep`, `taxiOut`, `holdShort`,
  `lineUpWait`, `waitCross`) are not subject to airborne separation checks.
- Build stays single-file via `vite-plugin-singlefile` with a high
  `assetsInlineLimit`; large new binary assets affect bundle size directly.
