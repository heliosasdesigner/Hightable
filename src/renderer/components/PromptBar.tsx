import { useEffect, useState, type FormEvent, type KeyboardEvent, type ReactElement } from "react";
import type { AgentId, PromptRound, PromptTarget, RoundMode } from "../../shared/types";

export interface PromptBarPrefill {
  /** Monotonically increasing — change to re-trigger prefill even with same contents. */
  token: number;
  prompt: string;
  target: PromptTarget;
  mode: RoundMode;
}

export interface PromptBarProps {
  disabled: boolean;
  limitedAgents: Record<AgentId, string | undefined>; // agent -> ISO time they unlock
  prefill?: PromptBarPrefill | null;
  /** Most recent non-running discussion round in this room, if any — drives the Continue button. */
  latestDiscussion?: PromptRound | null;
  /**
   * Running discussion round in this room, if any. Drives the Pause/Kill
   * buttons next to Discuss. Parallel-mode running rounds are not surfaced
   * here because there's nothing to "pause" in a one-shot send.
   */
  runningDiscussion?: PromptRound | null;
  onSend: (input: {
    prompt: string;
    target: PromptTarget;
    mode: RoundMode;
    sequentialTurns?: number;
    endGoal?: string;
  }) => Promise<void> | void;
  onContinueDiscussion?: (round: PromptRound) => Promise<void> | void;
  /** Soft-stop: flushes partial state, marks round needs_attention. */
  onPauseRound?: (roundId: string) => Promise<void> | void;
  /** Hard-stop: flushes partial state, marks round completed. */
  onKillRound?: (roundId: string) => Promise<void> | void;
}

interface TargetChoice {
  value: PromptTarget;
  label: string;
  /** Modes this target is valid in. */
  modes: RoundMode[];
  /** Which agents are required to be free of rate limits for this target. */
  agents: AgentId[];
}

const TARGET_CHOICES: TargetChoice[] = [
  { value: "claude", label: "Claude", modes: ["manual"], agents: ["claude"] },
  { value: "codex", label: "Codex", modes: ["manual"], agents: ["codex"] },
  { value: "both", label: "Both", modes: ["manual"], agents: ["claude", "codex"] },
  {
    value: "claude_to_codex",
    label: "Claude → Codex",
    modes: ["discussion"],
    agents: ["claude", "codex"],
  },
  {
    value: "codex_to_claude",
    label: "Codex → Claude",
    modes: ["discussion"],
    agents: ["claude", "codex"],
  },
];

function defaultTargetForMode(mode: RoundMode): PromptTarget {
  if (mode === "compare") return "both";
  if (mode === "discussion") return "claude_to_codex";
  return "claude";
}

function ContinuePromptButton({
  round,
  disabled,
  limitedTooltip,
  onContinue,
}: {
  round: PromptRound;
  disabled: boolean;
  limitedTooltip?: string;
  onContinue: (round: PromptRound) => Promise<void> | void;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const directionLabel =
    round.target === "codex_to_claude" ? "Codex → Claude" : "Claude → Codex";
  const title = limitedTooltip
    ? limitedTooltip
    : `Continue the latest Discussion (${directionLabel}) with one more primary→reviewer exchange.`;
  return (
    <button
      type="button"
      className="prompt-continue"
      disabled={disabled || busy}
      title={title}
      onClick={async () => {
        if (busy) return;
        setBusy(true);
        try {
          await onContinue(round);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Continuing…" : "Continue"}
    </button>
  );
}

function buildLimitedTooltip(limitedAgents: Record<AgentId, string | undefined>): string {
  const parts: string[] = [];
  for (const agent of ["claude", "codex"] as const) {
    const until = limitedAgents[agent];
    if (!until) continue;
    const date = new Date(until);
    const when = Number.isNaN(date.getTime())
      ? until
      : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    const label = agent === "claude" ? "Claude" : "Codex";
    parts.push(`${label} rate-limited until ${when}`);
  }
  return parts.length > 0
    ? parts.join(" · ") + ". Click the topbar pill to clear."
    : "Rate-limited.";
}

export function PromptBar({
  disabled,
  limitedAgents,
  prefill,
  latestDiscussion,
  runningDiscussion,
  onSend,
  onContinueDiscussion,
  onPauseRound,
  onKillRound,
}: PromptBarProps): ReactElement {
  const [prompt, setPrompt] = useState("");
  const [target, setTarget] = useState<PromptTarget>("claude_to_codex");
  const [mode, setMode] = useState<RoundMode>("discussion");
  // 0 = endless (loop until both agents agree). Default for Discussion.
  const [sequentialTurns, setSequentialTurns] = useState<number>(0);
  const [endGoal, setEndGoal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Apply a prefill whenever the caller rotates the token. We deliberately
  // don't auto-send — the user reviews the composed text first.
  useEffect(() => {
    if (!prefill) return;
    setPrompt(prefill.prompt);
    setTarget(prefill.target);
    setMode(prefill.mode);
    setError(null);
  }, [prefill?.token]);

  const isCompare = mode === "compare";
  const isDiscussion = mode === "discussion";
  // "Iterative" = the end-goal input should be shown. True for explicit
  // multi-turn discussions AND for endless mode (which uses the end goal
  // to detect consensus).
  const isEndless = isDiscussion && sequentialTurns === 0;
  const isIterative = isDiscussion && (sequentialTurns > 1 || isEndless);

  // Compare always targets both — target chips stay inert in that mode.
  const effectiveTarget: PromptTarget = isCompare ? "both" : target;

  // If the mode changes and the current target is no longer compatible, swap
  // to a sensible default for the new mode (otherwise we'd send a bogus combo).
  useEffect(() => {
    const current = TARGET_CHOICES.find((c) => c.value === effectiveTarget);
    if (!current || !current.modes.includes(mode)) {
      setTarget(defaultTargetForMode(mode));
    }
  }, [mode, effectiveTarget]);

  const claudeLimited = Boolean(limitedAgents.claude);
  const codexLimited = Boolean(limitedAgents.codex);

  function targetIsLimited(t: PromptTarget): boolean {
    const choice = TARGET_CHOICES.find((c) => c.value === t);
    if (!choice) return false;
    return choice.agents.some(
      (agent) => (agent === "claude" && claudeLimited) || (agent === "codex" && codexLimited),
    );
  }

  const activeTargetLimited = targetIsLimited(effectiveTarget);
  const limitedTooltip = buildLimitedTooltip(limitedAgents);

  async function submit(event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || disabled || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSend({
        prompt: trimmed,
        target: effectiveTarget,
        mode,
        sequentialTurns: isDiscussion ? sequentialTurns : undefined,
        endGoal: isIterative ? endGoal.trim() || undefined : undefined,
      });
      setPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
  }

  const sendLabel = submitting
    ? isCompare
      ? "Running…"
      : isDiscussion
        ? isEndless
          ? "Discussing…"
          : sequentialTurns > 1
            ? "Discussing…"
            : "Reviewing…"
        : "Sending…"
    : isCompare
      ? "Compare"
      : isDiscussion
        ? isEndless
          ? "Discuss"
          : sequentialTurns > 1
            ? "Discuss"
            : "Review"
        : "Send";

  const placeholder = disabled
    ? "Open a room to send prompts…"
    : isCompare
      ? "Ask the same question to Claude and Codex in parallel…"
      : isDiscussion
        ? isEndless
          ? "Topic for the two agents to discuss — they keep iterating until both agree the end goal is met…"
          : sequentialTurns > 1
            ? "Topic for the two agents to discuss — primary answers first, reviewer pushes back, they iterate…"
            : "Ask the primary agent — the reviewer will critique when it's done…"
        : "Ask Claude and Codex...";

  const visibleChoices = TARGET_CHOICES.filter((c) => c.modes.includes(mode));

  return (
    <form className="prompt-bar" aria-label="Prompt controls" onSubmit={submit}>
      <textarea
        placeholder={placeholder}
        rows={3}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
      />
      {isIterative ? (
        <input
          type="text"
          className="prompt-end-goal"
          placeholder={
            isEndless
              ? "End goal — required for endless mode. Both agents must agree it's met to stop."
              : "End goal — what success looks like (e.g. 'agree on an architecture for the docs pipeline')…"
          }
          value={endGoal}
          onChange={(e) => setEndGoal(e.target.value)}
          disabled={disabled}
          aria-label="Discussion end goal"
        />
      ) : null}
      <div className="prompt-actions">
        <div className="target-group" role="group" aria-label="Send target">
          {visibleChoices.map((choice) => {
            const limited = targetIsLimited(choice.value);
            const forced = isCompare; // Compare mode pins the target regardless.
            return (
              <button
                key={choice.value}
                type="button"
                className={`target-chip${effectiveTarget === choice.value ? " active" : ""}${
                  limited ? " limited" : ""
                }`}
                onClick={() => !forced && !limited && setTarget(choice.value)}
                disabled={disabled || forced || limited}
                title={limited ? limitedTooltip : undefined}
              >
                {choice.label}
              </button>
            );
          })}
        </div>
        <select
          className="mode-select"
          aria-label="Mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as RoundMode)}
          disabled={disabled}
        >
          <option value="manual">Manual</option>
          <option value="compare">Compare</option>
          <option value="discussion">Discussion</option>
        </select>
        {isDiscussion ? (
          <select
            className="mode-select"
            aria-label="Iterations"
            value={sequentialTurns}
            onChange={(e) => setSequentialTurns(Number(e.target.value))}
            disabled={disabled}
            title="Review = one primary → reviewer exchange. 2 / 3 iterations = the reviewer's feedback goes back to the primary for revision, and so on."
          >
            <option value={0}>Endless (until both agree)</option>
            <option value={1}>Review (1 iteration)</option>
            <option value={2}>2 iterations</option>
            <option value={3}>3 iterations</option>
          </select>
        ) : null}
        <div className="prompt-spacer" />
        {error ? <span className="prompt-error">{error}</span> : null}
        {isDiscussion && latestDiscussion && onContinueDiscussion ? (
          <ContinuePromptButton
            round={latestDiscussion}
            disabled={disabled || submitting || claudeLimited || codexLimited}
            limitedTooltip={claudeLimited || codexLimited ? limitedTooltip : undefined}
            onContinue={onContinueDiscussion}
          />
        ) : null}
        {isDiscussion && runningDiscussion && onPauseRound ? (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => void onPauseRound(runningDiscussion.id)}
            title="Stop the primary↔reviewer loop for the running discussion. Partial responses are preserved; you can Continue later."
          >
            Pause
          </button>
        ) : null}
        {isDiscussion && runningDiscussion && onKillRound ? (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => void onKillRound(runningDiscussion.id)}
            title="End the running discussion now. Partial responses are preserved and the round is marked completed."
          >
            Kill
          </button>
        ) : null}
        <button
          type="submit"
          className="btn-primary"
          disabled={disabled || submitting || !prompt.trim() || activeTargetLimited}
          title={activeTargetLimited ? limitedTooltip : undefined}
        >
          {sendLabel}
        </button>
      </div>
    </form>
  );
}
