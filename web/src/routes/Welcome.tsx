import { AppWindow, Lock, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { saveOnboardingCompleted } from "../lib/onboarding";

/** First-run orientation, shown as a modal over the dashboard when the URL carries `?firstRun=1`
 *  (see `RootSearch.firstRun` in router.tsx) rather than as its own page. Purely informational: what
 *  Argus is, where to find it, and that everything stays local by default. No setup steps here —
 *  those live in Settings. Dismissing just hides this layer (local state) without touching the URL
 *  or reloading. `argus serve --open` adds `firstRun=1` itself when `state.onboardingCompleted`
 *  isn't set yet (see `startServer` in `api/serve.ts`), so seeing this modal at all means onboarding
 *  hasn't been marked complete yet: mark it on mount so it doesn't show again next startup. */
export function WelcomeModal() {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    void saveOnboardingCompleted(true).catch(() => {});
  }, []);

  if (dismissed) return null;

  return (
    <div className="welcome-backdrop">
      <div className="welcome-card">
        <div className="welcome-grid">
          <div className="welcome-text">
            <h1 className="welcome-title">Welcome to Argus</h1>
            <p className="welcome-lede">
              Argus turns your local Claude Code, Claude Cowork, Claude Chat, Codex and Gemini
              CLI sessions into a view of your usage, cost and habits.
            </p>

            <div className="welcome-points">
              <div className="welcome-point">
                <Lock className="welcome-point-icon" size={20} strokeWidth={1.75} aria-hidden />
                <div>
                  <div className="welcome-point-title">Local by default</div>
                  <div className="welcome-point-body">
                    Everything is read and stored on this Mac. Nothing is sent anywhere by
                    default.
                  </div>
                </div>
              </div>

              <div className="welcome-point">
                <Search className="welcome-point-icon" size={20} strokeWidth={1.75} aria-hidden />
                <div>
                  <div className="welcome-point-title">Finds sessions automatically</div>
                  <div className="welcome-point-body">
                    Argus finds and indexes every session it can as soon as it's saved, no setup
                    required.
                  </div>
                </div>
              </div>

              <div className="welcome-point">
                <AppWindow className="welcome-point-icon" size={20} strokeWidth={1.75} aria-hidden />
                <div>
                  <div className="welcome-point-title">Lives in the menu bar</div>
                  <div className="welcome-point-body">
                    Argus has no dock icon. Look for it in the menu bar at the top of the screen.
                  </div>
                </div>
              </div>
            </div>
          </div>

          <figure className="welcome-shot">
            <img src="/images/mac-menu.png" alt="The Argus menu in the macOS menu bar, showing Open Argus, Stop, Check for updates, About Argus, and Quit Argus" />
          </figure>
        </div>

        <div className="welcome-actions">
          <button type="button" className="welcome-cta" onClick={() => setDismissed(true)}>
            Continue to Argus
          </button>
        </div>
      </div>
    </div>
  );
}
