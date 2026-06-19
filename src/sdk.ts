// Forward hook only. The real CrazyGames SDK (ads, leaderboards, IAP) is OUT OF
// SCOPE for this prototype, but isolating its surface behind a no-op interface
// means it can be wired in later without touching game/sim code.

export interface PlatformSdk {
  init(): Promise<void>;
  /** Call when active gameplay begins / resumes (CrazyGames midgame ads hook). */
  gameplayStart(): void;
  /** Call when gameplay pauses / a menu opens. */
  gameplayStop(): void;
  /** Call on a positive beat (e.g. a delivery milestone). */
  happytime(): void;
}

const noop: PlatformSdk = {
  init: async () => {},
  gameplayStart: () => {},
  gameplayStop: () => {},
  happytime: () => {},
};

export const sdk: PlatformSdk = noop;
