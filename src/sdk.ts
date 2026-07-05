// Integration of the CrazyGames SDK v3.

declare global {
  interface Window {
    CrazyGames?: {
      SDK: {
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

export const sdk: PlatformSdk = {
  init: async () => {
    // SDK v3 initializes automatically via the script tag in index.html.
  },
  gameplayStart: () => {
    if (window.CrazyGames?.SDK?.game) {
      window.CrazyGames.SDK.game.gameplayStart();
    }
  },
  gameplayStop: () => {
    if (window.CrazyGames?.SDK?.game) {
      window.CrazyGames.SDK.game.gameplayStop();
    }
  },
  happytime: () => {
    if (window.CrazyGames?.SDK?.game) {
      window.CrazyGames.SDK.game.happytime();
    }
  },
  requestRewardedAd: (onSuccess, onError, onStart) => {
    if (window.CrazyGames?.SDK?.ad) {
      window.CrazyGames.SDK.ad.requestAd("rewarded", {
        adStarted: onStart,
        adFinished: onSuccess,
        adError: (error, errorData) => {
          console.warn("Rewarded ad failed:", error, errorData);
          onError();
        }
      });
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
    if (window.CrazyGames?.SDK?.ad) {
      window.CrazyGames.SDK.ad.requestAd("midgame", {
        adStarted: onStart,
        adFinished: onComplete,
        adError: (error, errorData) => {
          console.warn("Midgame ad failed:", error, errorData);
          onComplete(); // proceed anyway if ad fails
        }
      });
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
