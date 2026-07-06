// upgrades.ts — tech tree / between-shift upgrade system.
// Players spend earned cash to permanently improve their airport.
// Upgrades persist across shifts via localStorage.

import { storage } from './sdk';

export type UpgradeId =
  | 'runway_2'
  | 'runway_3'
  | 'runway_4'
  | 'runway_5'
  | 'gates_1'
  | 'gates_2'
  | 'gates_3'
  | 'weather_radar'
  | 'radar_range_1'
  | 'radar_range_2'
  | 'fuel_reserves'
  | 'fast_turnaround_1'
  | 'fast_turnaround_2';

export interface UpgradeDef {
  id: UpgradeId;
  name: string;
  description: string;
  cost: number;
  icon: string; // emoji for now
  requires?: UpgradeId; // prerequisite upgrade
  category: 'runway' | 'gates' | 'radar' | 'fuel' | 'turnaround' | 'weather';
}

export interface UpgradeState {
  purchased: Set<UpgradeId>;
  totalCashEarned: number; // lifetime earnings (for stats)
  bankBalance: number; // cash available for spending (carries over between shifts)
}

export const UPGRADE_DEFS: UpgradeDef[] = [
  // --- Runways ---
  {
    id: 'runway_2',
    name: 'Runway 3',
    description: 'Add a diagonal runway (crosses your two starter strips)',
    cost: 1500,
    icon: '🛬',
    category: 'runway',
  },
  {
    id: 'runway_3',
    name: 'Runway 3',
    description: 'Add a diagonal runway (crosses existing strips)',
    cost: 3000,
    icon: '🛫',
    requires: 'runway_2',
    category: 'runway',
  },
  {
    id: 'runway_4',
    name: 'Runway 4',
    description: 'Add a second diagonal runway (more intersections)',
    cost: 5000,
    icon: '✈️',
    requires: 'runway_3',
    category: 'runway',
  },
  {
    id: 'runway_5',
    name: 'Crosswind Runway',
    description: 'Add a perpendicular crosswind runway (maximum complexity)',
    cost: 8000,
    icon: '🌪️',
    requires: 'runway_4',
    category: 'runway',
  },

  // --- Gates ---
  {
    id: 'gates_1',
    name: 'Terminal 2',
    description: '+3 gates — open a new terminal',
    cost: 1000,
    icon: '🏗️',
    category: 'gates',
  },
  {
    id: 'gates_2',
    name: 'Gate Expansion I',
    description: '+3 more gates at Terminal 1',
    cost: 2000,
    icon: '🏢',
    requires: 'gates_1',
    category: 'gates',
  },
  {
    id: 'gates_3',
    name: 'Gate Expansion II',
    description: '+3 more gates at Terminal 2',
    cost: 3500,
    icon: '🏙️',
    requires: 'gates_2',
    category: 'gates',
  },

  // --- Weather Radar ---
  {
    id: 'weather_radar',
    name: 'Weather Radar',
    description: 'See incoming storm cells — adds weather hazards but you can see them',
    cost: 2000,
    icon: '🌧️',
    category: 'weather',
  },

  // --- Radar Range ---
  {
    id: 'radar_range_1',
    name: 'Radar Range I',
    description: 'See planes 20% earlier (more reaction time)',
    cost: 1000,
    icon: '📡',
    category: 'radar',
  },
  {
    id: 'radar_range_2',
    name: 'Radar Range II',
    description: 'See planes 40% earlier',
    cost: 1800,
    icon: '📡',
    requires: 'radar_range_1',
    category: 'radar',
  },

  // --- Fuel Reserves ---
  {
    id: 'fuel_reserves',
    name: 'Fuel Reserves',
    description: 'Planes arrive with +30% fuel',
    cost: 1200,
    icon: '⛽',
    category: 'fuel',
  },

  // --- Faster Turnaround ---
  {
    id: 'fast_turnaround_1',
    name: 'Quick Turnaround I',
    description: 'Gate time reduced by 25%',
    cost: 1500,
    icon: '⚡',
    category: 'turnaround',
  },
  {
    id: 'fast_turnaround_2',
    name: 'Quick Turnaround II',
    description: 'Gate time reduced by 50% total',
    cost: 2500,
    icon: '⚡',
    requires: 'fast_turnaround_1',
    category: 'turnaround',
  },
];

/** Create a fresh (empty) upgrade state. */
export function createUpgradeState(): UpgradeState {
  return {
    purchased: new Set(),
    totalCashEarned: 1500, // starting bonus to afford early upgrades
    bankBalance: 1500,
  };
}

/** Check if an upgrade's prerequisites are met and player can afford it. */
export function canPurchase(state: UpgradeState, id: UpgradeId): boolean {
  if (state.purchased.has(id)) return false;
  const def = UPGRADE_DEFS.find((d) => d.id === id);
  if (!def) return false;
  if (def.requires && !state.purchased.has(def.requires)) return false;
  return state.bankBalance >= def.cost;
}

/** Check if an upgrade is unlocked (prerequisites met) but maybe not affordable. */
export function isUnlocked(state: UpgradeState, id: UpgradeId): boolean {
  if (state.purchased.has(id)) return true;
  const def = UPGRADE_DEFS.find((d) => d.id === id);
  if (!def) return false;
  if (def.requires && !state.purchased.has(def.requires)) return false;
  return true;
}

/** Purchase an upgrade. Returns true on success. */
export function purchaseUpgrade(state: UpgradeState, id: UpgradeId): boolean {
  if (!canPurchase(state, id)) return false;
  const def = UPGRADE_DEFS.find((d) => d.id === id)!;
  state.bankBalance -= def.cost;
  state.purchased.add(id);
  return true;
}

/** How many extra runways the player has purchased. */
export function extraRunwayCount(state: UpgradeState): number {
  let count = 0;
  if (state.purchased.has('runway_2')) count++;
  if (state.purchased.has('runway_3')) count++;
  if (state.purchased.has('runway_4')) count++;
  if (state.purchased.has('runway_5')) count++;
  return count;
}

/** How many extra gates the player has purchased. */
export function extraGateCount(state: UpgradeState): number {
  let count = 0;
  if (state.purchased.has('gates_1')) count += 3;
  if (state.purchased.has('gates_2')) count += 3;
  if (state.purchased.has('gates_3')) count += 3;
  return count;
}

/** Fuel multiplier from upgrades. */
export function fuelMultiplier(state: UpgradeState): number {
  return state.purchased.has('fuel_reserves') ? 1.3 : 1.0;
}

/** Turnaround time multiplier from upgrades. */
export function turnaroundMultiplier(state: UpgradeState): number {
  if (state.purchased.has('fast_turnaround_2')) return 0.5;
  if (state.purchased.has('fast_turnaround_1')) return 0.75;
  return 1.0;
}

/** Radar spawn radius multiplier from upgrades. */
export function radarRangeMultiplier(state: UpgradeState): number {
  if (state.purchased.has('radar_range_2')) return 1.4;
  if (state.purchased.has('radar_range_1')) return 1.2;
  return 1.0;
}

/** Whether weather system is active. */
export function hasWeatherRadar(state: UpgradeState): boolean {
  return state.purchased.has('weather_radar');
}

// --- persistence ---

const STORAGE_KEY = 'fa.upgrades';

export function saveUpgradeState(state: UpgradeState): void {
  try {
    const data = {
      purchased: [...state.purchased],
      totalCashEarned: state.totalCashEarned,
      bankBalance: state.bankBalance,
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch { /* private mode etc */ }
}

export function loadUpgradeState(): UpgradeState {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return createUpgradeState();
    const data = JSON.parse(raw);
    return {
      purchased: new Set(data.purchased ?? []),
      totalCashEarned: data.totalCashEarned ?? 0,
      bankBalance: data.bankBalance ?? 0,
    };
  } catch {
    return createUpgradeState();
  }
}
