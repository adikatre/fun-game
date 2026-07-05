// Integration of the CrazyGames SDK v3.

declare global {
  interface Window {
    CrazyGames?: {
      SDK: {
        /** v3 requires awaiting this before any other module is used. */
        init(): Promise<void>;
        game: {
          gameplayStart(): void;
          gameplayStop(): void;
          happytime(): void;
        };
        ad: {
          requestAd(type: 'rewarded' | 'midgame', callbacks: {
            adStarted: () => void;
            adFinished: () => void;
            adError: (error: string, errorData: any) => void;
          }): void;
        };
      };
    };
  }
}

// Basic Launch on CrazyGames disables monetization. Keep every ad CTA / gate
// behind this flag so nothing blocks progression during the 2-week test phase.
// Flip to `true` only once the game is promoted to Full Launch.
export const FULL_LAUNCH = false;

export interface PlatformSdk {
  init(): Promise<void>;
  /** Call when active gameplay begins / resumes (CrazyGames midgame ads hook). */
  gameplayStart(): void;
  /** Call when gameplay pauses / a menu opens. */
  gameplayStop(): void;
  /** Call on a positive beat (e.g. a delivery milestone). */
  happytime(): void;
  /** Request a rewarded video ad. */
  requestRewardedAd(onSuccess: () => void, onError: () => void, onStart: () => void): void;
  /** Request a midgame video ad. */
  requestMidgameAd(onComplete: () => void, onStart: () => void): void;
}

// True once `window.CrazyGames.SDK.init` has resolved. All SDK calls are no-ops
// until then so we never throw "CrazySDK is not initialized yet" on boot.
let initialized = false;

function withGame(fn: (game: NonNullable<Window['CrazyGames']>['SDK']['game']) => void): void {
  if (!initialized) return;
  const game = window.CrazyGames?.SDK?.game;
  if (!game) return;
  try {
    fn(game);
  } catch (err) {
    // The SDK throws in the `disabled` environment (non-CrazyGames domains).
    console.warn('CrazyGames SDK call failed:', err);
  }
}

export const sdk: PlatformSdk = {
  init: async () => {
    const cg = window.CrazyGames?.SDK;
    if (cg && typeof cg.init === 'function') {
      try {
        // v3: must be *called* and awaited; the SDK is unusable until it resolves.
        await cg.init();
      } catch (err) {
        console.warn('CrazyGames SDK init failed:', err);
      }
    }
    initialized = true;
  },
  gameplayStart: () => withGame((game) => game.gameplayStart()),
  gameplayStop: () => withGame((game) => game.gameplayStop()),
  happytime: () => withGame((game) => game.happytime()),
  requestRewardedAd: (onSuccess, onError, onStart) => {
    const ad = initialized ? window.CrazyGames?.SDK?.ad : undefined;
    if (ad) {
      try {
        ad.requestAd("rewarded", {
          adStarted: onStart,
          adFinished: onSuccess,
          adError: (error, errorData) => {
            console.warn("Rewarded ad failed:", error, errorData);
            onError();
          }
        });
      } catch (err) {
        console.warn("Rewarded ad request threw:", err);
        onError();
      }
    } else {
      // Local development fallback
      onStart();
      console.log("Simulating rewarded ad...");
      setTimeout(() => {
        console.log("Simulated ad finished");
        onSuccess();
      }, 1000);
    }
  },
  requestMidgameAd: (onComplete, onStart) => {
    const ad = initialized ? window.CrazyGames?.SDK?.ad : undefined;
    if (ad) {
      try {
        ad.requestAd("midgame", {
          adStarted: onStart,
          adFinished: onComplete,
          adError: (error, errorData) => {
            console.warn("Midgame ad failed:", error, errorData);
            onComplete(); // proceed anyway if ad fails
          }
        });
      } catch (err) {
        console.warn("Midgame ad request threw:", err);
        onComplete();
      }
    } else {
      // Local development fallback
      onStart();
      console.log("Simulating midgame ad...");
      setTimeout(() => {
        console.log("Simulated midgame ad finished");
        onComplete();
      }, 500);
    }
  }
};
