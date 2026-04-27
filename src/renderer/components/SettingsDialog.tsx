import { useState, type ReactElement } from "react";

export type ThemeMode = "light" | "dark";

export interface SettingsDialogProps {
  theme: ThemeMode;
  timelineOpenOnStartup: boolean;
  onThemeChange: (next: ThemeMode) => void;
  onTimelineStartupChange: (next: boolean) => void;
  onClearRateLimits: () => Promise<void> | void;
  onResetDatabase: () => Promise<void> | void;
  onClose: () => void;
}

type Busy = null | "clearing-rate-limits" | "resetting";

export function SettingsDialog(props: SettingsDialogProps): ReactElement {
  const {
    theme,
    timelineOpenOnStartup,
    onThemeChange,
    onTimelineStartupChange,
    onClearRateLimits,
    onResetDatabase,
    onClose,
  } = props;

  const [busy, setBusy] = useState<Busy>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function clearRateLimits(): Promise<void> {
    setBusy("clearing-rate-limits");
    setError(null);
    try {
      await onClearRateLimits();
      setStatus("Rate limits cleared for both agents.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function resetDatabase(): Promise<void> {
    setBusy("resetting");
    setError(null);
    try {
      await onResetDatabase();
      setStatus("Database reset. All rooms, rounds, and transcripts are gone.");
      setConfirmReset(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
    >
      <div className="dialog settings-dialog">
        <header className="dialog-header">
          <h2 id="settings-title">Settings</h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close settings"
          >
            ✕
          </button>
        </header>

        <section className="settings-section">
          <p className="settings-section-label">Theme</p>
          <div className="settings-theme-group" role="radiogroup" aria-label="Theme">
            <button
              type="button"
              role="radio"
              aria-checked={theme === "light"}
              className={`settings-theme-chip${theme === "light" ? " active" : ""}`}
              onClick={() => onThemeChange("light")}
            >
              <span className="settings-theme-swatch light" aria-hidden="true" />
              Light
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={theme === "dark"}
              className={`settings-theme-chip${theme === "dark" ? " active" : ""}`}
              onClick={() => onThemeChange("dark")}
            >
              <span className="settings-theme-swatch dark" aria-hidden="true" />
              Dark
            </button>
          </div>
        </section>

        <section className="settings-section">
          <p className="settings-section-label">Interface</p>
          <label className="settings-toggle-row">
            <input
              type="checkbox"
              checked={timelineOpenOnStartup}
              onChange={(e) => onTimelineStartupChange(e.target.checked)}
            />
            <span>
              <span className="settings-toggle-title">Show timeline sidecar on startup</span>
              <span className="settings-toggle-sub">
                Remembers the last state you set with the topbar toggle.
              </span>
            </span>
          </label>
        </section>

        <section className="settings-section">
          <p className="settings-section-label">Data</p>

          <div className="settings-data-row">
            <div className="settings-data-copy">
              <span className="settings-data-title">Clear all rate limits</span>
              <span className="settings-data-sub">
                Removes every active limit on Claude and Codex. Counts are
                preserved.
              </span>
            </div>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => void clearRateLimits()}
              disabled={busy !== null}
            >
              {busy === "clearing-rate-limits" ? "Clearing…" : "Clear"}
            </button>
          </div>

          <div className="settings-data-row destructive">
            <div className="settings-data-copy">
              <span className="settings-data-title">Reset database</span>
              <span className="settings-data-sub">
                Deletes every room, round, message, transcript log, and rate-limit
                row. The app returns to an empty state. Cannot be undone.
              </span>
            </div>
            {confirmReset ? (
              <div className="settings-reset-confirm">
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setConfirmReset(false)}
                  disabled={busy !== null}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary settings-reset-confirm-btn"
                  onClick={() => void resetDatabase()}
                  disabled={busy !== null}
                >
                  {busy === "resetting" ? "Resetting…" : "Yes, wipe everything"}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn-primary settings-danger"
                onClick={() => setConfirmReset(true)}
                disabled={busy !== null}
              >
                Reset…
              </button>
            )}
          </div>
        </section>

        {status ? <p className="settings-status">{status}</p> : null}
        {error ? <p className="dialog-error">{error}</p> : null}

        <footer className="dialog-footer">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
