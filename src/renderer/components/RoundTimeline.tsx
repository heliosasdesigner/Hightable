import { useEffect, useState, type ReactElement } from "react";
import type { PromptRound, PromptTarget, RoundProgressEvent } from "../../shared/types";

export interface RoundTimelineProps {
  rounds: PromptRound[];
  /**
   * Live per-turn progress for running discussion rounds, keyed by roundId.
   * Rounds not present in the map either aren't in-flight or aren't a
   * discussion (parallel sends have no turn concept).
   */
  progress?: Map<string, RoundProgressEvent>;
  onMarkComplete: (roundId: string) => void;
  onOpenRound: (roundId: string) => void;
  onContinueDiscussion: (round: PromptRound) => void;
  onClose: () => void;
}

const MODE_LABEL: Record<PromptRound["mode"], string> = {
  manual: "Manual",
  compare: "Compare",
  discussion: "Discussion",
};

const STATUS_LABEL: Record<PromptRound["status"], string> = {
  queued: "Queued",
  running: "Submitted",
  needs_attention: "Needs attn",
  completed: "Completed",
  failed: "Failed",
};

const STATUS_CLASS: Record<PromptRound["status"], string> = {
  queued: "running",
  running: "running",
  needs_attention: "attention",
  completed: "completed",
  failed: "attention",
};

export function RoundTimeline({
  rounds,
  progress,
  onMarkComplete,
  onOpenRound,
  onContinueDiscussion,
  onClose,
}: RoundTimelineProps): ReactElement {
  return (
    <aside className="timeline" aria-label="Round timeline">
      <header>
        <h3>Round Timeline</h3>
        <button type="button" className="icon-btn" aria-label="Hide timeline" title="Hide timeline" onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="timeline-list">
        {rounds.length === 0 ? (
          <div className="timeline-empty">
            <p>No rounds yet.</p>
            <p className="timeline-hint">Manual terminal input isn't tracked as a round.</p>
          </div>
        ) : (
          rounds.map((round) => (
            <div
              key={round.id}
              className="timeline-row"
              role="button"
              tabIndex={0}
              onClick={() => onOpenRound(round.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpenRound(round.id);
                }
              }}
            >
              <span className="timeline-mode">{MODE_LABEL[round.mode]}</span>
              <span className={`timeline-state ${STATUS_CLASS[round.status]}`}>
                {STATUS_LABEL[round.status]}
              </span>
              <span className="timeline-target" aria-label="Targets">
                <TargetBadges mode={round.mode} target={round.target} />
              </span>
              <span className="timeline-preview">
                <span className="timeline-time">{formatTime(round.startedAt)} · </span>
                {round.prompt.length > 120 ? `${round.prompt.slice(0, 120)}…` : round.prompt}
              </span>
              {round.status === "running" && progress?.get(round.id) ? (
                <LiveProgress info={progress.get(round.id)!} />
              ) : null}
              {(round.status === "running" || round.status === "needs_attention") && (
                <button
                  type="button"
                  className="timeline-mark-complete"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMarkComplete(round.id);
                  }}
                >
                  Mark complete
                </button>
              )}
              {round.mode === "discussion" &&
              (round.target === "claude_to_codex" || round.target === "codex_to_claude") &&
              round.status !== "running" ? (
                <button
                  type="button"
                  className="timeline-continue"
                  onClick={(e) => {
                    e.stopPropagation();
                    onContinueDiscussion(round);
                  }}
                >
                  Continue
                </button>
              ) : null}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

export function TargetBadges({
  mode: _mode,
  target,
}: {
  mode: PromptRound["mode"];
  target: PromptTarget;
}): ReactElement {
  if (target === "claude_to_codex") {
    return <span className="target-badge seq">Claude → Codex</span>;
  }
  if (target === "codex_to_claude") {
    return <span className="target-badge seq">Codex → Claude</span>;
  }
  if (target === "both") {
    return (
      <>
        <span className="target-badge claude">Claude</span>
        <span className="target-badge codex">Codex</span>
      </>
    );
  }
  if (target === "claude") {
    return <span className="target-badge claude">Claude</span>;
  }
  return <span className="target-badge codex">Codex</span>;
}

function formatTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * "Turn 2 / ∞ · waiting for Codex · 42s" — ticker that re-renders every
 * second while a round is live. Resets its elapsed counter every time the
 * `turnStartedAt` prop changes, so the display reflects the current side's
 * elapsed time, not the whole-round elapsed time.
 */
function LiveProgress({ info }: { info: RoundProgressEvent }): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [info.turnStartedAt]);
  const elapsedMs = Math.max(0, now - new Date(info.turnStartedAt).getTime());
  const totalLabel = info.endless ? "∞" : String(info.totalTurns);
  const agentLabel = info.currentAgent === "claude" ? "Claude" : "Codex";
  const sideLabel = info.currentSide === "primary" ? "primary" : "reviewer";
  return (
    <span className="timeline-live" aria-live="polite">
      Turn {info.turnNumber} / {totalLabel} · {agentLabel} {sideLabel} ·{" "}
      <span className="timeline-live-elapsed">{formatElapsed(elapsedMs)}</span>
    </span>
  );
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
