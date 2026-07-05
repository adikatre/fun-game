// stats.ts — career statistics persistence.
// Tracks lifetime stats across shifts, persisted to localStorage.

import type { CareerStats, GameState } from './types';

const STORAGE_KEY = 'fa.career';

/** Create a fresh (empty) career stats record. */
export function createCareerStats(): CareerStats {
  return {
    totalShifts: 0,
    totalLandings: 0,
    totalDepartures: 0,
    bestCash: 0,
    bestStreak: 0,
    totalCrashes: 0,
    lifetimeEarnings: 0,
    grades: { S: 0, A: 0, B: 0, C: 0, D: 0, F: 0 },
  };
}

/** Record a completed shift's stats into the lifetime career record. */
export function recordShiftStats(stats: CareerStats, state: GameState): void {
  stats.totalShifts++;
  stats.totalLandings += state.handled;
  stats.totalDepartures += state.departed;
  stats.totalCrashes += state.incidents;
  stats.lifetimeEarnings += Math.max(0, state.cash);
  if (state.cash > stats.bestCash) stats.bestCash = state.cash;
  if (state.bestStreak > stats.bestStreak) stats.bestStreak = state.bestStreak;
  if (state.grade) {
    stats.grades[state.grade] = (stats.grades[state.grade] || 0) + 1;
  }
}

/** Save career stats to localStorage. */
export function saveCareerStats(stats: CareerStats): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(stats));
  } catch { /* private mode etc */ }
}

/** Load career stats from localStorage. */
export function loadCareerStats(): CareerStats {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return createCareerStats();
    const data = JSON.parse(raw);
    return {
      totalShifts: data.totalShifts ?? 0,
      totalLandings: data.totalLandings ?? 0,
      totalDepartures: data.totalDepartures ?? 0,
      bestCash: data.bestCash ?? 0,
      bestStreak: data.bestStreak ?? 0,
      totalCrashes: data.totalCrashes ?? 0,
      lifetimeEarnings: data.lifetimeEarnings ?? 0,
      grades: {
        S: data.grades?.S ?? 0,
        A: data.grades?.A ?? 0,
        B: data.grades?.B ?? 0,
        C: data.grades?.C ?? 0,
        D: data.grades?.D ?? 0,
        F: data.grades?.F ?? 0,
      },
    };
  } catch {
    return createCareerStats();
  }
}

/** Wipe all career stats (for Settings reset). */
export function resetAllCareerData(): void {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
    globalThis.localStorage?.removeItem('fa.day');
    globalThis.localStorage?.removeItem('fa.best');
    globalThis.localStorage?.removeItem('fa.upgrades');
    globalThis.localStorage?.removeItem('fa.volume');
  } catch { /* ignore */ }
}
