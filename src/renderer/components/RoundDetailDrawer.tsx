import { useEffect, useState, type ReactElement } from "react";
import type { AgentId, RoundDetail, RoundMessage } from "../../shared/types";
import {
  cleanAgentResponse,
  collapseEmbeddedContext,
  scrubResiduals,
} from "../../shared/text-cleanup";
import { TargetBadges } from "./RoundTimeline";

export interface ChainFollowUp {
  prompt: string;
  target: AgentId;
}

export interface ContinueDiscussion {
  /** direction for the continuation — same as the round being continued */
  target: "claude_to_codex" | "codex_to_claude";
  endGoal?: string;
}

export interface RoundDetailDrawerProps {
  roundId: string;
  onClose: () => void;
  onMarkComplete: (roundId: string) => void;
  onChainFollowUp: (follow: ChainFollowUp) => void;
  onContinueDiscussion: (input: ContinueDiscussion) => void;
}

const MODE_LABEL: Record<RoundDetail["round"]["mode"], string> = {
  manual: "Manual",
  compare: "Compare",
  discussion: "Discussion",
};

const STATUS_LABEL: Record<RoundDetail["round"]["status"], string> = {
  queued: "Queued",
  running: "Submitted",
  needs_attention: "Needs attn",
  completed: "Completed",
  failed: "Failed",
};

const STATUS_CLASS: Record<RoundDetail["round"]["status"], string> = {
  queued: "running",
  running: "running",
  needs_attention: "attention",
  completed: "completed",
  failed: "attention",
};

export function RoundDetailDrawer({
  roundId,
  onClose,
  onMarkComplete,
  onChainFollowUp,
  onContinueDiscussion,
}: RoundDetailDrawerProps): ReactElement {
  const [detail, setDetail] = useState<RoundDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchDetail(): Promise<void> {
      try {
        const next = await window.hightable.getRound({ roundId });
        if (!cancelled) setDetail(next);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    void fetchDetail();
    // Refresh when the round receives an update (e.g. completion / marker).
    const unsubscribe = window.hightable.onRoundUpdated((event) => {
      if (event.round.id === roundId) void fetchDetail();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [roundId]);

  if (error) {
    return (
      <aside className="timeline round-drawer" aria-label="Round detail">
        <header>
          <button type="button" className="btn-ghost" onClick={onClose}>
            ← Back
          </button>
        </header>
        <p className="dialog-error">{error}</p>
      </aside>
    );
  }

  if (!detail) {
    return (
      <aside className="timeline round-drawer" aria-label="Round detail">
        <header>
          <button type="button" className="btn-ghost" onClick={onClose}>
            ← Back
          </button>
        </header>
        <p className="timeline-empty">Loading…</p>
      </aside>
    );
  }

  const { round, messages } = detail;
  const isCompare = round.mode === "compare";
  const isDiscussion = round.mode === "discussion";
  const responses = messages.filter((m) => m.direction === "response");
  const statusPending = round.status === "running" || round.status === "needs_attention";

  // For discussion rounds, the primary is the first agent in the directional
  // target; the reviewer is the other one. Messages come back ordered by
  // created_at, so the Nth response per side corresponds to the Nth turn.
  const primaryAgent: AgentId | null = isDiscussion
    ? round.target === "claude_to_codex"
      ? "claude"
      : round.target === "codex_to_claude"
        ? "codex"
        : null
    : null;
  const reviewerAgent: AgentId | null =
    isDiscussion && primaryAgent ? (primaryAgent === "claude" ? "codex" : "claude") : null;

  interface SequentialTurnView {
    primary?: RoundMessage;
    reviewer?: RoundMessage;
  }
  const sequentialTurns: SequentialTurnView[] = [];
  if (isDiscussion && primaryAgent && reviewerAgent) {
    let pi = 0;
    let ri = 0;
    for (const m of responses) {
      if (m.agent === primaryAgent) {
        const slot = sequentialTurns[pi] ?? {};
        slot.primary = m;
        sequentialTurns[pi] = slot;
        pi += 1;
      } else if (m.agent === reviewerAgent) {
        const slot = sequentialTurns[ri] ?? {};
        slot.reviewer = m;
        sequentialTurns[ri] = slot;
        ri += 1;
      }
    }
  }

  async function exportMarkdown(): Promise<void> {
    try {
      const result = await window.hightable.exportRound({ roundId: round.id });
      if (!result.canceled && result.path) {
        console.log(`[hightable] round exported to ${result.path}`);
      }
    } catch (err) {
      console.error("[hightable] exportRound failed", err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <aside className="timeline round-drawer" aria-label="Round detail">
      <header>
        <button type="button" className="btn-ghost" onClick={onClose}>
          ← Back
        </button>
        <span className={`timeline-state ${STATUS_CLASS[round.status]}`}>
          {STATUS_LABEL[round.status]}
        </span>
        <button
          type="button"
          className="btn-ghost round-drawer-export"
          onClick={() => void exportMarkdown()}
          title="Export this round as a Markdown file"
        >
          Export .md
        </button>
      </header>

      <section className="round-drawer-meta">
        <p className="round-drawer-mode">{MODE_LABEL[round.mode]}</p>
        <div className="round-drawer-targets">
          <TargetBadges mode={round.mode} target={round.target} />
        </div>
        <p className="round-drawer-time">
          {formatTime(round.startedAt)}
          {round.completedAt ? ` → ${formatTime(round.completedAt)}` : ""}
        </p>
        {round.endGoal ? (
          <p className="round-drawer-end-goal">
            <span className="round-drawer-end-goal-label">End goal</span>
            <span>{round.endGoal}</span>
          </p>
        ) : null}
      </section>

      <section className="round-drawer-prompt">
        <p className="round-drawer-label">Prompt</p>
        <pre className="round-drawer-text">
          {scrubResiduals(collapseEmbeddedContext(round.prompt))}
        </pre>
      </section>

      {isCompare ? (
        <section className="round-drawer-compare">
          <ResponseBlock agent="claude" responses={responses} />
          <ResponseBlock agent="codex" responses={responses} />
        </section>
      ) : isDiscussion && primaryAgent && reviewerAgent ? (
        <section className="round-drawer-discussion">
          {sequentialTurns.length === 0 ? (
            <p className="round-drawer-missing">Waiting for first response…</p>
          ) : (
            sequentialTurns.map((turn, idx) => {
              const isFirst = idx === 0;
              const primarySuffix = isFirst ? " · primary" : " · revision";
              const reviewerSuffix = isFirst ? " · reviewer" : " · re-review";
              return (
                <div key={idx} className="round-drawer-turn">
                  <p className="round-drawer-label">Iteration {idx + 1}</p>
                  <div className="round-drawer-turn-grid">
                    <TurnResponse
                      agent={primaryAgent}
                      label={labelFor(primaryAgent) + primarySuffix}
                      message={turn.primary}
                    />
                    <TurnResponse
                      agent={reviewerAgent}
                      label={labelFor(reviewerAgent) + reviewerSuffix}
                      message={turn.reviewer}
                    />
                  </div>
                </div>
              );
            })
          )}
        </section>
      ) : (
        <section className="round-drawer-single">
          {responses.length === 0 ? (
            <p className="round-drawer-missing">No response recorded.</p>
          ) : (
            responses.map((m) => <ResponseBody key={m.id} message={m} />)
          )}
        </section>
      )}

      {statusPending ? (
        <footer className="round-drawer-footer">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => onMarkComplete(round.id)}
          >
            Mark complete
          </button>
          {isDiscussion && primaryAgent && reviewerAgent ? (
            <button
              type="button"
              className="btn-ghost"
              onClick={() =>
                onContinueDiscussion({
                  target:
                    round.target === "codex_to_claude"
                      ? "codex_to_claude"
                      : "claude_to_codex",
                  endGoal: round.endGoal,
                })
              }
            >
              Continue discussion anyway
            </button>
          ) : null}
        </footer>
      ) : isDiscussion && primaryAgent && reviewerAgent ? (
        <footer className="round-drawer-footer round-drawer-chain">
          <button
            type="button"
            className="btn-primary"
            onClick={() =>
              onContinueDiscussion({
                target:
                  round.target === "codex_to_claude"
                    ? "codex_to_claude"
                    : "claude_to_codex",
                endGoal: round.endGoal,
              })
            }
          >
            Continue discussion
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() =>
              onChainFollowUp(
                composeRevisionRequest(primaryAgent, reviewerAgent, responses),
              )
            }
          >
            Revise via {labelFor(primaryAgent)}
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() =>
              onChainFollowUp(composeReviewerFollowUp(reviewerAgent))
            }
          >
            Follow up with {labelFor(reviewerAgent)}
          </button>
        </footer>
      ) : null}
    </aside>
  );
}

function labelFor(agent: AgentId): string {
  return agent === "claude" ? "Claude" : "Codex";
}

function composeRevisionRequest(
  primary: AgentId,
  reviewer: AgentId,
  responses: RoundMessage[],
): ChainFollowUp {
  const reviewerResponse = responses.find((m) => m.agent === reviewer)?.cleanedText?.trim() ?? "";
  const preview = reviewerResponse.length > 8_000 ? reviewerResponse.slice(0, 8_000) + "\n…[truncated]" : reviewerResponse;
  const prompt =
    `Please revise your previous answer based on this feedback from ${labelFor(reviewer)}:\n\n` +
    `<review>\n${preview || "(empty)"}\n</review>\n\n` +
    `Keep what you got right; address the concrete improvements raised. If you disagree with any point, explain why briefly.`;
  return { prompt, target: primary };
}

function composeReviewerFollowUp(reviewer: AgentId): ChainFollowUp {
  return {
    prompt:
      "Anything else to add or any follow-up questions about the previous answer? " +
      "If the answer now looks good, say so explicitly.",
    target: reviewer,
  };
}

function ResponseBlock({
  agent,
  responses,
  labelSuffix,
}: {
  agent: AgentId;
  responses: RoundMessage[];
  labelSuffix?: string;
}): ReactElement {
  const message = responses.find((m) => m.agent === agent);
  const baseLabel = agent === "claude" ? "Claude" : "Codex";
  return (
    <div className={`round-drawer-agent ${agent}`}>
      <p className="round-drawer-label">
        {baseLabel}
        {labelSuffix ?? ""}
      </p>
      {message ? (
        <ResponseBody message={message} />
      ) : (
        <p className="round-drawer-missing">No response recorded.</p>
      )}
    </div>
  );
}

function ResponseBody({ message }: { message: RoundMessage }): ReactElement {
  // Run a render-time cleanup pass so legacy rows saved before the TUI
  // filter was hardened still display cleanly. No-op for fresh rows whose
  // stored cleanedText is already scrubbed.
  const text = cleanAgentResponse(message.cleanedText ?? "").trim();
  if (!text) return <p className="round-drawer-missing">Empty response.</p>;
  return <pre className="round-drawer-text">{text}</pre>;
}

function TurnResponse({
  agent,
  message,
  label,
}: {
  agent: AgentId;
  message: RoundMessage | undefined;
  label?: string;
}): ReactElement {
  return (
    <div className={`round-drawer-agent ${agent}`}>
      <p className="round-drawer-label">{label ?? (agent === "claude" ? "Claude" : "Codex")}</p>
      {message ? (
        <ResponseBody message={message} />
      ) : (
        <p className="round-drawer-missing">Waiting…</p>
      )}
    </div>
  );
}

function formatTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
