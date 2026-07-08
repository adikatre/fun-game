// fx.ts — transient, render-only feedback state (popups, screen shake, banner,
// animated cash counter). Lives OUTSIDE the sim so determinism is untouched;
// main feeds it drained GameEvents and per-frame dt.

import { PALETTE } from './config';
import type { GameEvent, GameState } from './types';

export interface Popup {
  x: number; // world coords
  y: number;
  text: string;
  color: string;
  ttl: number;
  ttl0: number;
  size: number;
}

export interface Banner {
  text: string;
  sub: string;
  color: string;
  ttl: number;
  ttl0: number;
}

export class Fx {
  popups: Popup[] = [];
  banner: Banner | null = null;
  shake = 0; // world-px amplitude
  flash = 0; // full-screen red flash alpha
  displayCash = 0; // eased counter shown in the HUD

  private pop(x: number, y: number, text: string, color: string, size = 15, ttl = 1.4): void {
    this.popups.push({ x, y, text, color, ttl, ttl0: ttl, size });
    if (this.popups.length > 24) this.popups.shift();
  }

  private showBanner(text: string, sub: string, color: string, ttl = 3): void {
    this.banner = { text, sub, color, ttl, ttl0: ttl };
  }

  onEvent(e: GameEvent): void {
    switch (e.kind) {
      case 'land':
        this.pop(e.x, e.y - 14, `+$${e.amount}`, PALETTE.cash, e.streak >= 4 ? 18 : 15);
        if (e.streak >= 3) this.pop(e.x, e.y + 8, `STREAK ×${e.streak}`, PALETTE.gateReady, 11, 1.1);
        break;
      case 'depart':
        this.pop(e.x, e.y - 14, `+$${e.amount}`, PALETTE.departure, e.streak >= 4 ? 18 : 15);
        break;
      case 'goAround':
        this.pop(e.x, e.y - 14, e.amount ? `GO-AROUND ${e.amount}` : 'GO-AROUND', PALETTE.warn, 12);
        break;
      case 'assign':
        this.pop(e.x, e.y - 14, 'CLEARED ✓', PALETTE.blip, 11, 0.9);
        break;
      case 'corridorBusy':
        this.pop(e.x, e.y - 14, `CORRIDOR BUSY — ${e.endName}`, PALETTE.warn, 12, 1.2);
        break;
      case 'nearMiss':
        this.pop(e.x, e.y - 14, `NEAR MISS`, PALETTE.warn, 13);
        this.shake = Math.max(this.shake, 4);
        break;
      case 'divert':
        this.pop(e.x, e.y, `DIVERTED ${e.amount}`, PALETTE.warn, 12);
        break;
      case 'crash':
        this.pop(e.x, e.y - 22, `CRASH`, PALETTE.danger, 20, 2);
        this.shake = Math.max(this.shake, 14);
        this.flash = Math.max(this.flash, 0.25);
        break;
      case 'groundCrash':
        this.pop(e.x, e.y - 22, `GROUND CRASH`, PALETTE.danger, 20, 2);
        this.shake = Math.max(this.shake, 16);
        this.flash = Math.max(this.flash, 0.3);
        break;
      case 'crossRunway':
        this.pop(e.x, e.y - 10, `CROSSING`, PALETTE.warn, 11, 0.8);
        break;
      case 'emergency':
        this.showBanner(
          e.emergency === 'medical' ? `MAYDAY — ${e.callsign}` : `LOW FUEL — ${e.callsign}`,
          e.emergency === 'medical' ? 'medical emergency · get them down NOW' : 'priority landing needed',
          PALETTE.danger,
          2.6,
        );
        break;
      case 'rush':
        this.showBanner('RUSH TRAFFIC', 'a wave of arrivals is checking in', PALETTE.warn, 2.4);
        break;
      case 'finalRush':
        this.showBanner('FINAL RUSH', 'last push of the shift — everything at once', PALETTE.danger, 3.2);
        break;
      case 'purchase':
        this.showBanner('UPGRADE PURCHASED', e.upgradeId, PALETTE.cash, 1.8);
        break;
      default:
        break;
    }
  }

  update(dt: number, state: GameState): void {
    for (const p of this.popups) {
      p.ttl -= dt;
      p.y -= 22 * dt;
    }
    this.popups = this.popups.filter((p) => p.ttl > 0);
    if (this.banner) {
      this.banner.ttl -= dt;
      if (this.banner.ttl <= 0) this.banner = null;
    }
    this.shake = Math.max(0, this.shake - dt * 26);
    this.flash = Math.max(0, this.flash - dt * 0.9);
    // ease the HUD cash counter toward the real value
    const diff = state.cash - this.displayCash;
    if (Math.abs(diff) < 1) this.displayCash = state.cash;
    else this.displayCash += diff * Math.min(1, dt * 8);
  }

  reset(state: GameState): void {
    this.popups = [];
    this.banner = null;
    this.shake = 0;
    this.flash = 0;
    this.displayCash = state.cash;
  }
}
