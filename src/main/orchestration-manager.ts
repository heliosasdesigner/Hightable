import { EventEmitter } from "node:events";
import type {
  AgentId,
  PromptRound,
  PromptTarget,
  RoundMode,
  RoundProgressEvent,
  SendPromptInput,
  Unsubscribe,
} from "../shared/types.js";
import type { HightableStore } from "./sqlite-store.js";
import type { PtyManager } from "./pty-manager.js";
import type { RoomManager } from "./room-manager.js";
import type { TranscriptCapture, MarkerEvent } from "./transcript-capture.js";
import { captureGitDiff, formatGitDiffForPrompt } from "./git-diff.js";
import { cleanAgentResponse } from "../shared/text-cleanup.js";

// Inactivity window: if the PTY emits nothing for this long while a round is
// pending, flip the round to `needs_attention`. Activity-based rather than
// total-time because permission prompts and long tool-call chains are normal
// and should not count as "stuck".
const TRACKED_ROUND_INACTIVITY_MS = 180_000; // 3 min
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
// Claude Code's Ink-based input debounces keyboard input right after a paste
// commits. Sending the submit \r a moment later is the difference between
// "nothing happens" and "prompt submits".
const SUBMIT_ENTER_DELAY_MS = 150;

export interface OrchestrationManagerDeps {
  store: HightableStore;
  ptyManager: PtyManager;
  roomManager: RoomManager;
  transcript: TranscriptCapture;
}

export interface RoundUpdate {
  round: PromptRound;
}

interface PendingTargetEntry {
  ptyTerminalId: string;
  dbTerminalId: string;
  agent: AgentId;
  /** Cleaned-buffer offset captured right before the prompt was written. */
  startOffset: number;
  /** Captured once the matching DONE marker is seen. */
  doneOffset: number | null;
  /** Last prompt text written to this PTY, for PTY-death recovery. */
  lastPrompt: string;
}

interface PendingParallel {
  kind: "parallel";
  roundId: string;
  markerId: string;
  roomId: string;
  targets: Map<string, PendingTargetEntry>; // key = ptyTerminalId
  inactivityHandle: NodeJS.Timeout;
  /** Number of PTY-restart retries used for this round so far. */
  recoveryAttempts: number;
}

interface SequentialSideSlot {
  markerId: string;
  /** null until we write this side's prompt to the PTY. */
  startOffset: number | null;
  /** null until the DONE marker for this side arrives. */
  doneOffset: number | null;
  /** Cleaned response, populated when saved. */
  response: string;
  /** Whether the response message row has been persisted. */
  saved: boolean;
}

interface SequentialTurn {
  primary: SequentialSideSlot;
  reviewer: SequentialSideSlot;
}

interface PendingSequential {
  kind: "sequential";
  roundId: string;
  roomId: string;
  repoPath: string;
  userPrompt: string;
  /** Free-text end goal threaded into review/revise/re-review prompts. */
  endGoal: string | undefined;
  primary: { agent: AgentId; ptyTerminalId: string; dbTerminalId: string };
  reviewer: { agent: AgentId; ptyTerminalId: string; dbTerminalId: string };
  /** Upper bound on iterations; in endless mode this is the safety cap. */
  totalTurns: number;
  /**
   * Endless mode: keep iterating until the reviewer explicitly says the
   * end goal is met (or we hit `totalTurns` as a safety stop). Turns[]
   * is preallocated lazily as we advance.
   */
  endless: boolean;
  /** 0-based turn being filled right now. */
  currentTurnIndex: number;
  /** Which side we're waiting on for the current turn. */
  currentSide: "primary" | "reviewer";
  turns: SequentialTurn[];
  inactivityHandle: NodeJS.Timeout;
  /** Last prompt text written, by side, for PTY-death recovery. */
  lastPrompt: { primary?: string; reviewer?: string };
  /** Number of PTY-restart retries used for this round so far. */
  recoveryAttempts: number;
}

type Pending = PendingParallel | PendingSequential;

const MAX_SEQUENTIAL_TURNS = 3;
const DEFAULT_SEQUENTIAL_TURNS = 1;
/** Safety cap on endless-mode iterations to avoid a runaway loop. */
const ENDLESS_SAFETY_CAP = 10;

/**
 * Detects whether a reviewer response signals that the discussion's end
 * goal has been reached. The prompt asks for an explicit marker — we
 * accept a few phrasings because agents paraphrase.
 */
function reviewerSignalsConsensus(text: string): boolean {
  if (!text) return false;
  const compressed = text.replace(/\s+/g, " ").toLowerCase();
  return (
    /end goal status\s*[:—–-]?\s*met\b/.test(compressed) ||
    /\bthe end goal (?:is|has been) met\b/.test(compressed) ||
    /\bend goal:\s*met\b/.test(compressed)
  );
}

/**
 * Routes every prompt bar send into the user's interactive Claude/Codex PTY —
 * the same CLI session visible in the pane — and tracks completion via
 * `[HM_RUN_BEGIN:<id>]` / `[HM_RUN_DONE:<id>]` markers wrapped around the
 * prompt. This keeps the pane and the prompt bar as a unified session (what
 * the user sees is the single source of truth); the drawer shows a
 * best-effort cleaned extraction of the response between the markers.
 *
 * Round lifecycle:
 *   - `running` (labelled "Submitted" in the UI) while waiting for the DONE marker
 *   - `completed` once every targeted terminal emits DONE
 *   - `needs_attention` after 120 s with no DONE — manual `Mark complete` rescues it
 *   - `failed` if writing to the PTY throws mid-flight
 */
export class OrchestrationManager {
  private readonly store: HightableStore;
  private readonly ptyManager: PtyManager;
  private readonly roomManager: RoomManager;
  private readonly transcript: TranscriptCapture;
  private readonly emitter = new EventEmitter();
  private readonly pending = new Map<string, Pending>();

  constructor(deps: OrchestrationManagerDeps) {
    this.store = deps.store;
    this.ptyManager = deps.ptyManager;
    this.roomManager = deps.roomManager;
    this.transcript = deps.transcript;

    this.transcript.onMarker((event) => this.handleMarker(event));
    // Reset the inactivity timer for any pending round every time its PTY
    // produces new output. Keeps long-running, permission-gated runs from
    // tripping the timeout while the agent is clearly still alive.
    this.ptyManager.onData((event) => this.bumpActivity(event.terminalId));
    // PTY death recovery — if a pending round's PTY exits, try to restart
    // it once (with resume flag) and re-inject the last prompt. If the
    // restart fails or the PTY dies again, flip the round to needs_attention.
    this.ptyManager.onExit((event) => this.handlePtyExit(event.terminalId));
  }

  sendPrompt(input: SendPromptInput): PromptRound {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("Prompt is empty");

    if (input.mode === "discussion") {
      return this.beginDiscussion(input, prompt);
    }

    const effectiveTargets =
      input.mode === "compare" ? resolveTargets("both") : resolveTargets(input.target);

    const missing = effectiveTargets.filter(
      (agent) => !this.roomManager.getPtyTerminalId(input.roomId, agent),
    );
    if (missing.length > 0) {
      throw new Error(`No active terminal for: ${missing.join(", ")}. Open the room first.`);
    }

    const limited = effectiveTargets.filter((agent) => this.store.getActiveRateLimit(agent));
    if (limited.length > 0) {
      throw new Error(
        `Rate-limited: ${limited.join(", ")}. Clear the limit in the topbar to send again.`,
      );
    }

    const recordedTarget: PromptTarget = input.mode === "compare" ? "both" : input.target;

    this.supersedeConflicts(input.roomId, effectiveTargets);

    return this.sendTrackedPrompt(
      input.roomId,
      prompt,
      effectiveTargets,
      input.mode,
      recordedTarget,
    );
  }

  /** Close out any in-flight round that targets any of the supplied agents. */
  private supersedeConflicts(roomId: string, agents: AgentId[]): void {
    const conflictingPtyIds = new Set<string>();
    for (const agent of agents) {
      const ptyId = this.roomManager.getPtyTerminalId(roomId, agent);
      if (ptyId) conflictingPtyIds.add(ptyId);
    }
    for (const [roundId, pending] of this.pending) {
      const ptys = ptyIdsFor(pending);
      const hasConflict = ptys.some((id) => conflictingPtyIds.has(id));
      if (hasConflict) this.supersedePending(roundId);
    }
  }

  private supersedePending(roundId: string): void {
    const pending = this.pending.get(roundId);
    if (!pending) return;
    if (pending.kind === "parallel") {
      for (const target of pending.targets.values()) {
        if (target.doneOffset !== null) continue;
        this.saveParallelResponseSnapshot(roundId, target);
      }
    } else {
      this.flushSequentialPartial(pending);
    }
    this.clearPending(roundId);
    const updated = this.store.updateRoundStatus(roundId, "needs_attention");
    this.emit(updated);
  }

  markRoundComplete(roundId: string): PromptRound {
    const pending = this.pending.get(roundId);
    if (pending) {
      if (pending.kind === "parallel") {
        for (const target of pending.targets.values()) {
          if (target.doneOffset !== null) continue;
          this.saveParallelResponseSnapshot(roundId, target);
        }
      } else {
        this.flushSequentialPartial(pending);
      }
      this.clearPending(roundId);
    }
    const updated = this.store.completeRound(roundId);
    this.emit(updated);
    return updated;
  }

  /**
   * Soft-stop a running round: flushes whatever partial response is in the
   * PTY buffer, cancels the inactivity timer and any further primary↔
   * reviewer automation, and flips the round's status to `needs_attention`
   * so the user can resume it later via the Continue button (Discussion
   * rounds) or revisit it from the drawer.
   *
   * Pause is NOT a true "send SIGSTOP to the CLI" — the agent keeps running
   * inside its PTY and finishing whatever it's doing. What we stop is the
   * *orchestration* loop: no more primary↔reviewer hops will fire.
   */
  pauseRound(roundId: string): PromptRound {
    const pending = this.pending.get(roundId);
    if (pending) {
      if (pending.kind === "parallel") {
        for (const target of pending.targets.values()) {
          if (target.doneOffset !== null) continue;
          this.saveParallelResponseSnapshot(roundId, target);
        }
      } else {
        this.flushSequentialPartial(pending);
      }
      this.clearPending(roundId);
    }
    const updated = this.store.updateRoundStatus(roundId, "needs_attention");
    this.emit(updated);
    return updated;
  }

  onRoundUpdate(listener: (event: RoundUpdate) => void): Unsubscribe {
    this.emitter.on("update", listener);
    return () => this.emitter.off("update", listener);
  }

  onRoundProgress(listener: (event: RoundProgressEvent) => void): Unsubscribe {
    this.emitter.on("progress", listener);
    return () => this.emitter.off("progress", listener);
  }

  private emitProgress(pending: PendingSequential): void {
    const event: RoundProgressEvent = {
      roundId: pending.roundId,
      turnNumber: pending.currentTurnIndex + 1,
      totalTurns: pending.totalTurns,
      endless: pending.endless,
      currentSide: pending.currentSide,
      currentAgent:
        pending.currentSide === "primary"
          ? pending.primary.agent
          : pending.reviewer.agent,
      turnStartedAt: new Date().toISOString(),
    };
    this.emitter.emit("progress", event);
  }

  /**
   * Drop all pending rounds and cancel their inactivity timers without
   * touching the DB. Used on database reset — callers have already wiped
   * the underlying rows, so any follow-up writes from these timers would
   * fail the `messages.round_id` foreign key.
   */
  clearAll(): void {
    for (const roundId of Array.from(this.pending.keys())) {
      const pending = this.pending.get(roundId);
      if (!pending) continue;
      clearTimeout(pending.inactivityHandle);
      this.pending.delete(roundId);
    }
  }

  /**
   * Writes prompt text to a PTY using bracketed paste so embedded newlines
   * are treated as multi-line input rather than submit keystrokes, then
   * sends the real Enter after a brief delay — Claude Code's Ink input drops
   * input that arrives in the same burst as the paste-end escape.
   */
  private writePromptToPty(ptyId: string, text: string): void {
    this.ptyManager.write(ptyId, `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`);
    setTimeout(() => {
      try {
        this.ptyManager.write(ptyId, "\r");
      } catch {
        /* pty gone */
      }
    }, SUBMIT_ENTER_DELAY_MS);
  }

  private sendTrackedPrompt(
    roomId: string,
    prompt: string,
    targets: AgentId[],
    mode: RoundMode,
    target: PromptTarget,
  ): PromptRound {
    const round = this.store.createRound({
      roomId,
      mode,
      target,
      prompt,
      status: "running",
    });

    // Short marker id (first 8 hex chars of the round UUID) keeps the
    // injected `[HM_RUN_DONE:<id>]` tokens small enough not to wrap mid-id
    // in narrow terminal panes.
    const markerId = round.id.replace(/-/g, "").slice(0, 8);
    const pendingTargets = new Map<string, PendingTargetEntry>();
    const wrapped = buildWrappedPrompt(markerId, prompt);

    try {
      for (const agent of targets) {
        const ptyId = this.roomManager.getPtyTerminalId(roomId, agent);
        if (!ptyId) continue;
        const terminal = this.roomManager.findActiveTerminal(roomId, agent);
        const startOffset = this.transcript.snapshotOffset(ptyId);

        this.writePromptToPty(ptyId, wrapped);
        this.store.createMessage({
          roundId: round.id,
          terminalId: terminal?.id,
          agent,
          direction: "prompt",
          cleanedText: prompt,
        });

        pendingTargets.set(ptyId, {
          ptyTerminalId: ptyId,
          dbTerminalId: terminal?.id ?? ptyId,
          agent,
          startOffset,
          doneOffset: null,
          lastPrompt: wrapped,
        });
      }
    } catch (err) {
      const failed = this.store.updateRoundStatus(round.id, "failed");
      this.emit(failed);
      throw err;
    }

    const inactivityHandle = setTimeout(
      () => this.handleTimeout(round.id),
      TRACKED_ROUND_INACTIVITY_MS,
    );
    inactivityHandle.unref?.();

    this.pending.set(round.id, {
      kind: "parallel",
      roundId: round.id,
      markerId,
      roomId,
      targets: pendingTargets,
      inactivityHandle,
      recoveryAttempts: 0,
    });

    this.emit(round);
    return round;
  }

  private beginDiscussion(input: SendPromptInput, userPrompt: string): PromptRound {
    const target = input.target;
    if (target !== "claude_to_codex" && target !== "codex_to_claude") {
      throw new Error(
        `Discussion requires target 'claude_to_codex' or 'codex_to_claude' (got '${target}').`,
      );
    }
    const [primaryAgent, reviewerAgent]: [AgentId, AgentId] =
      target === "claude_to_codex" ? ["claude", "codex"] : ["codex", "claude"];

    const primaryPty = this.roomManager.getPtyTerminalId(input.roomId, primaryAgent);
    const reviewerPty = this.roomManager.getPtyTerminalId(input.roomId, reviewerAgent);
    if (!primaryPty || !reviewerPty) {
      const missing = [
        !primaryPty ? primaryAgent : null,
        !reviewerPty ? reviewerAgent : null,
      ].filter(Boolean);
      throw new Error(`No active terminal for: ${missing.join(", ")}. Open the room first.`);
    }

    const limited = [primaryAgent, reviewerAgent].filter((agent) =>
      this.store.getActiveRateLimit(agent),
    );
    if (limited.length > 0) {
      throw new Error(
        `Rate-limited: ${limited.join(", ")}. Clear the limit in the topbar to send again.`,
      );
    }

    const room = this.store.getRoom(input.roomId);
    if (!room) throw new Error(`Room not found: ${input.roomId}`);

    this.supersedeConflicts(input.roomId, [primaryAgent, reviewerAgent]);

    const requested = input.sequentialTurns ?? DEFAULT_SEQUENTIAL_TURNS;
    // `0` is the Endless sentinel — allocate up to the safety cap and the
    // state machine will stop early once the reviewer signals consensus.
    const endless = requested === 0;
    const totalTurns = endless
      ? ENDLESS_SAFETY_CAP
      : Math.max(1, Math.min(MAX_SEQUENTIAL_TURNS, requested));

    const round = this.store.createRound({
      roomId: input.roomId,
      mode: "discussion",
      target,
      prompt: userPrompt,
      endGoal: input.endGoal?.trim() || undefined,
      status: "running",
    });

    const primaryTerminal = this.roomManager.findActiveTerminal(input.roomId, primaryAgent);
    const reviewerTerminal = this.roomManager.findActiveTerminal(input.roomId, reviewerAgent);

    const roundHex = round.id.replace(/-/g, "");
    const turns: SequentialTurn[] = [];
    for (let i = 0; i < totalTurns; i++) {
      turns.push({
        primary: {
          markerId: seqMarker(roundHex, i, "primary"),
          startOffset: null,
          doneOffset: null,
          response: "",
          saved: false,
        },
        reviewer: {
          markerId: seqMarker(roundHex, i, "reviewer"),
          startOffset: null,
          doneOffset: null,
          response: "",
          saved: false,
        },
      });
    }

    // Kick off turn 0, primary side.
    const turn0 = turns[0];
    turn0.primary.startOffset = this.transcript.snapshotOffset(primaryPty);
    const trimmedEndGoal = input.endGoal?.trim() || undefined;
    const initialPrompt = buildInitialPrimaryPrompt({
      markerId: turn0.primary.markerId,
      userPrompt,
      endGoal: trimmedEndGoal,
      // Endless and multi-iteration both get the discussion framing so the
      // primary knows to produce substantive content the reviewer can iterate on.
      isDiscussion: endless || totalTurns > 1,
    });
    this.writePromptToPty(primaryPty, initialPrompt);
    this.store.createMessage({
      roundId: round.id,
      terminalId: primaryTerminal?.id,
      agent: primaryAgent,
      direction: "prompt",
      cleanedText: userPrompt,
    });

    const inactivityHandle = setTimeout(
      () => this.handleTimeout(round.id),
      TRACKED_ROUND_INACTIVITY_MS,
    );
    inactivityHandle.unref?.();

    this.pending.set(round.id, {
      kind: "sequential",
      roundId: round.id,
      roomId: input.roomId,
      repoPath: room.repoPath,
      userPrompt,
      endGoal: input.endGoal?.trim() || undefined,
      primary: {
        agent: primaryAgent,
        ptyTerminalId: primaryPty,
        dbTerminalId: primaryTerminal?.id ?? primaryPty,
      },
      reviewer: {
        agent: reviewerAgent,
        ptyTerminalId: reviewerPty,
        dbTerminalId: reviewerTerminal?.id ?? reviewerPty,
      },
      totalTurns,
      endless,
      currentTurnIndex: 0,
      currentSide: "primary",
      turns,
      inactivityHandle,
      lastPrompt: { primary: initialPrompt },
      recoveryAttempts: 0,
    });

    this.emit(round);
    const seeded = this.pending.get(round.id);
    if (seeded && seeded.kind === "sequential") this.emitProgress(seeded);
    return round;
  }

  /** Restart the inactivity timer for any pending round whose PTY just emitted data. */
  private bumpActivity(ptyTerminalId: string): void {
    for (const pending of this.pending.values()) {
      const ptys = ptyIdsFor(pending);
      if (!ptys.includes(ptyTerminalId)) continue;
      clearTimeout(pending.inactivityHandle);
      pending.inactivityHandle = setTimeout(
        () => this.handleTimeout(pending.roundId),
        TRACKED_ROUND_INACTIVITY_MS,
      );
      pending.inactivityHandle.unref?.();
    }
  }

  /**
   * PTY death recovery. Called when a PTY exits; if any pending round holds
   * that PTY, we get ONE chance to restart it (with the resume flag) and
   * re-inject the last prompt we wrote to it. If the restart fails or the
   * round's retry budget is exhausted, flush what we have and flip the
   * round to `needs_attention`.
   */
  private handlePtyExit(exitedPtyId: string): void {
    for (const pending of Array.from(this.pending.values())) {
      if (!ptyIdsFor(pending).includes(exitedPtyId)) continue;
      const giveUp = (): void => {
        if (pending.kind === "parallel") {
          for (const target of pending.targets.values()) {
            if (target.doneOffset !== null) continue;
            this.saveParallelResponseSnapshot(pending.roundId, target);
          }
        } else {
          this.flushSequentialPartial(pending);
        }
        this.clearPending(pending.roundId);
        try {
          const updated = this.store.updateRoundStatus(
            pending.roundId,
            "needs_attention",
          );
          this.emit(updated);
        } catch (err) {
          console.warn(
            `[orchestration] handlePtyExit: round ${pending.roundId} update failed: ${(err as Error).message}`,
          );
        }
      };

      if (pending.recoveryAttempts >= 1) {
        console.warn(
          `[orchestration] PTY ${exitedPtyId} died again for round ${pending.roundId} — giving up`,
        );
        giveUp();
        continue;
      }

      pending.recoveryAttempts += 1;
      try {
        const fresh = this.roomManager.restartTerminal(exitedPtyId, { resume: true });
        if (pending.kind === "parallel") {
          const entry = pending.targets.get(exitedPtyId);
          if (!entry) continue;
          // Reseat the entry under the new PTY id and replay the last prompt.
          pending.targets.delete(exitedPtyId);
          const startOffset = this.transcript.snapshotOffset(fresh.id);
          const replaced: PendingTargetEntry = {
            ...entry,
            ptyTerminalId: fresh.id,
            dbTerminalId: fresh.id,
            startOffset,
            doneOffset: null,
          };
          pending.targets.set(fresh.id, replaced);
          this.writePromptToPty(fresh.id, entry.lastPrompt);
          console.log(
            `[orchestration] parallel round ${pending.roundId}: re-injected prompt into restarted ${entry.agent} pty`,
          );
        } else {
          // Sequential: figure out which side this PTY belonged to.
          const isPrimary = pending.primary.ptyTerminalId === exitedPtyId;
          const side = isPrimary ? "primary" : "reviewer";
          const last = pending.lastPrompt[side];
          if (!last) {
            giveUp();
            continue;
          }
          const target = isPrimary ? pending.primary : pending.reviewer;
          target.ptyTerminalId = fresh.id;
          target.dbTerminalId = fresh.id;
          // Reset the current turn's slot offsets so the DONE-marker
          // detection doesn't match against stale buffer positions.
          const turn = pending.turns[pending.currentTurnIndex];
          const slot = side === "primary" ? turn.primary : turn.reviewer;
          slot.startOffset = this.transcript.snapshotOffset(fresh.id);
          slot.doneOffset = null;
          slot.saved = false;
          this.writePromptToPty(fresh.id, last);
          console.log(
            `[orchestration] sequential round ${pending.roundId}: re-injected ${side} prompt into restarted pty`,
          );
        }
        this.resetSequentialOrParallelInactivity(pending);
      } catch (err) {
        console.warn(
          `[orchestration] PTY restart failed for round ${pending.roundId}: ${(err as Error).message}`,
        );
        giveUp();
      }
    }
  }

  private resetSequentialOrParallelInactivity(pending: Pending): void {
    clearTimeout(pending.inactivityHandle);
    pending.inactivityHandle = setTimeout(
      () => this.handleTimeout(pending.roundId),
      TRACKED_ROUND_INACTIVITY_MS,
    );
    pending.inactivityHandle.unref?.();
  }

  private handleMarker(event: MarkerEvent): void {
    if (event.kind !== "done") return;
    for (const pending of this.pending.values()) {
      if (pending.kind === "parallel") {
        if (pending.markerId !== event.markerId) continue;
        const target = pending.targets.get(event.terminalId);
        if (!target || target.doneOffset !== null) continue;
        target.doneOffset = event.bufferOffset;
        this.saveParallelResponseSnapshot(pending.roundId, target);
        const allDone = Array.from(pending.targets.values()).every((t) => t.doneOffset !== null);
        if (!allDone) return;
        this.clearPending(pending.roundId);
        const completed = this.store.completeRound(pending.roundId);
        this.emit(completed);
        return;
      }
      // sequential: match the marker to (turn, side) of the current turn only.
      const currentTurn = pending.turns[pending.currentTurnIndex];
      const expectedSlot =
        pending.currentSide === "primary" ? currentTurn.primary : currentTurn.reviewer;
      const expectedPty =
        pending.currentSide === "primary"
          ? pending.primary.ptyTerminalId
          : pending.reviewer.ptyTerminalId;
      if (
        expectedSlot.markerId !== event.markerId ||
        expectedPty !== event.terminalId ||
        expectedSlot.doneOffset !== null
      ) {
        continue;
      }
      expectedSlot.doneOffset = event.bufferOffset;
      void this.advanceSequential(pending);
      return;
    }
  }

  private handleTimeout(roundId: string): void {
    const pending = this.pending.get(roundId);
    if (!pending) return;
    if (pending.kind === "parallel") {
      for (const target of pending.targets.values()) {
        if (target.doneOffset !== null) continue;
        this.saveParallelResponseSnapshot(roundId, target);
      }
    } else {
      this.flushSequentialPartial(pending);
    }
    this.clearPending(roundId);
    // If the round itself was deleted (e.g. by a database reset) between
    // the timer firing and the status update, swallow the FK error — the
    // app shouldn't crash because a stale timer tried to write.
    try {
      const updated = this.store.updateRoundStatus(roundId, "needs_attention");
      this.emit(updated);
    } catch (err) {
      console.warn(
        `[orchestration] handleTimeout: round ${roundId} vanished before status update: ${(err as Error).message}`,
      );
    }
  }

  private saveParallelResponseSnapshot(roundId: string, target: PendingTargetEntry): void {
    const end = target.doneOffset ?? this.transcript.snapshotOffset(target.ptyTerminalId);
    const raw = this.transcript.getCleanedSlice(target.ptyTerminalId, target.startOffset, end);
    const cleaned = cleanAgentResponse(raw);
    try {
      this.store.createMessage({
        roundId,
        terminalId: target.dbTerminalId,
        agent: target.agent,
        direction: "response",
        cleanedText: cleaned,
      });
    } catch (err) {
      console.warn(
        `[orchestration] saveParallelResponseSnapshot: write for round ${roundId} dropped: ${(err as Error).message}`,
      );
    }
  }

  /** Save one sequential side's cleaned response into the store and return its text. */
  private saveSequentialSide(
    pending: PendingSequential,
    turnIndex: number,
    side: "primary" | "reviewer",
  ): string {
    const turn = pending.turns[turnIndex];
    const slot = turn[side];
    if (slot.saved) return slot.response;
    const ptyId =
      side === "primary" ? pending.primary.ptyTerminalId : pending.reviewer.ptyTerminalId;
    const dbTerminalId =
      side === "primary" ? pending.primary.dbTerminalId : pending.reviewer.dbTerminalId;
    const agent = side === "primary" ? pending.primary.agent : pending.reviewer.agent;
    if (slot.startOffset === null) {
      slot.saved = true;
      return "";
    }
    const end = slot.doneOffset ?? this.transcript.snapshotOffset(ptyId);
    const raw = this.transcript.getCleanedSlice(ptyId, slot.startOffset, end);
    const cleaned = cleanAgentResponse(raw);
    slot.response = cleaned;
    try {
      this.store.createMessage({
        roundId: pending.roundId,
        terminalId: dbTerminalId,
        agent,
        direction: "response",
        cleanedText: cleaned,
      });
    } catch (err) {
      console.warn(
        `[orchestration] saveSequentialSide: write for round ${pending.roundId} dropped: ${(err as Error).message}`,
      );
    }
    slot.saved = true;
    return cleaned;
  }

  /** Drive the sequential state machine forward after a DONE marker lands. */
  private async advanceSequential(pending: PendingSequential): Promise<void> {
    const turnIndex = pending.currentTurnIndex;
    const side = pending.currentSide;
    this.saveSequentialSide(pending, turnIndex, side);

    if (side === "primary") {
      // Transition: primary → reviewer (same turn). Build the review prompt.
      // The git diff is captured fresh each turn so the reviewer sees the
      // latest repo state if anything changed between iterations.
      let diffBlock = "(repository is not a git working tree)";
      try {
        const artifact = await captureGitDiff(pending.repoPath);
        diffBlock = formatGitDiffForPrompt(artifact);
      } catch (err) {
        diffBlock = `(git capture failed: ${err instanceof Error ? err.message : String(err)})`;
      }
      if (!this.pending.has(pending.roundId)) return;

      const turn = pending.turns[turnIndex];
      const primaryResponse = turn.primary.response;
      const reviewPrompt =
        turnIndex === 0
          ? buildInitialReviewPrompt({
              reviewerMarkerId: turn.reviewer.markerId,
              primaryAgent: pending.primary.agent,
              userPrompt: pending.userPrompt,
              primaryResponse,
              diffBlock,
              endGoal: pending.endGoal,
            })
          : buildReReviewPrompt({
              reviewerMarkerId: turn.reviewer.markerId,
              primaryAgent: pending.primary.agent,
              primaryResponse,
              diffBlock,
              turnNumber: turnIndex + 1,
              endGoal: pending.endGoal,
            });

      turn.reviewer.startOffset = this.transcript.snapshotOffset(
        pending.reviewer.ptyTerminalId,
      );
      this.store.createMessage({
        roundId: pending.roundId,
        terminalId: pending.reviewer.dbTerminalId,
        agent: pending.reviewer.agent,
        direction: "prompt",
        cleanedText: reviewPrompt,
      });
      this.writePromptToPty(pending.reviewer.ptyTerminalId, reviewPrompt);
      pending.lastPrompt.reviewer = reviewPrompt;
      pending.currentSide = "reviewer";
      this.resetSequentialInactivity(pending);
      this.emitProgress(pending);
      this.emitRoundSnapshot(pending.roundId);
      return;
    }

    // side === "reviewer". Decide whether to loop again or stop.
    //   - Explicit-count mode: stop when nextTurnIndex >= totalTurns.
    //   - Endless mode: stop when the reviewer has signalled consensus,
    //     OR we've hit the safety cap (totalTurns = ENDLESS_SAFETY_CAP).
    const reviewerResponseJustSaved = pending.turns[turnIndex].reviewer.response;
    const nextTurnIndex = turnIndex + 1;
    const hitSafetyCap = nextTurnIndex >= pending.totalTurns;
    const endlessResolved =
      pending.endless && reviewerSignalsConsensus(reviewerResponseJustSaved);

    if (hitSafetyCap || endlessResolved) {
      this.clearPending(pending.roundId);
      const completed = this.store.completeRound(pending.roundId);
      this.emit(completed);
      return;
    }

    const nextTurn = pending.turns[nextTurnIndex];
    const reviseePrompt = buildRevisePrompt({
      primaryMarkerId: nextTurn.primary.markerId,
      reviewerAgent: pending.reviewer.agent,
      reviewerResponse: reviewerResponseJustSaved,
      turnNumber: nextTurnIndex + 1,
      endGoal: pending.endGoal,
    });

    nextTurn.primary.startOffset = this.transcript.snapshotOffset(pending.primary.ptyTerminalId);
    this.store.createMessage({
      roundId: pending.roundId,
      terminalId: pending.primary.dbTerminalId,
      agent: pending.primary.agent,
      direction: "prompt",
      cleanedText: reviseePrompt,
    });
    this.writePromptToPty(pending.primary.ptyTerminalId, reviseePrompt);
    pending.lastPrompt.primary = reviseePrompt;
    pending.currentTurnIndex = nextTurnIndex;
    pending.currentSide = "primary";
    this.resetSequentialInactivity(pending);
    this.emitProgress(pending);
    this.emitRoundSnapshot(pending.roundId);
  }

  /** Called on timeout / mark-complete / supersede for sequential rounds. */
  private flushSequentialPartial(pending: PendingSequential): void {
    const turn = pending.turns[pending.currentTurnIndex];
    const slot = pending.currentSide === "primary" ? turn.primary : turn.reviewer;
    if (slot.doneOffset === null && slot.startOffset !== null) {
      this.saveSequentialSide(pending, pending.currentTurnIndex, pending.currentSide);
    }
  }

  private resetSequentialInactivity(pending: PendingSequential): void {
    clearTimeout(pending.inactivityHandle);
    pending.inactivityHandle = setTimeout(
      () => this.handleTimeout(pending.roundId),
      TRACKED_ROUND_INACTIVITY_MS,
    );
    pending.inactivityHandle.unref?.();
  }

  private emitRoundSnapshot(roundId: string): void {
    const snapshot = this.store.getRound(roundId);
    if (snapshot) this.emit(snapshot);
  }

  private clearPending(roundId: string): void {
    const pending = this.pending.get(roundId);
    if (!pending) return;
    clearTimeout(pending.inactivityHandle);
    this.pending.delete(roundId);
  }

  private emit(round: PromptRound): void {
    const event: RoundUpdate = { round };
    this.emitter.emit("update", event);
  }
}

function resolveTargets(target: SendPromptInput["target"]): AgentId[] {
  switch (target) {
    case "claude":
      return ["claude"];
    case "codex":
      return ["codex"];
    case "both":
      return ["claude", "codex"];
    case "claude_to_codex":
    case "codex_to_claude":
      throw new Error(
        `Target '${target}' is a directional Discussion target and cannot be resolved to a parallel target list. This is a bug — callers should route directional sends through beginDiscussion.`,
      );
    default: {
      const unreachable: never = target;
      throw new Error(`Unknown prompt target: ${String(unreachable)}`);
    }
  }
}

function buildWrappedPrompt(markerId: string, prompt: string): string {
  return (
    `[HM_RUN_BEGIN:${markerId}]\n` +
    `${prompt}\n\n` +
    `When your final response is complete, place the closing token on its own line with no other text: ` +
    `[HM_RUN_DONE:${markerId}]`
  );
}

function ptyIdsFor(pending: Pending): string[] {
  if (pending.kind === "parallel") return Array.from(pending.targets.keys());
  return [pending.primary.ptyTerminalId, pending.reviewer.ptyTerminalId];
}

function seqMarker(roundHex: string, turnIdx: number, side: "primary" | "reviewer"): string {
  // 8 hex-ish chars unique per (round, turn, side). Short enough to avoid
  // wrapping mid-id in narrow terminal panes, long enough to not collide
  // within a session.
  const tag = (turnIdx * 2 + (side === "primary" ? 0 : 1)).toString(16).padStart(2, "0");
  return roundHex.slice(0, 6) + tag;
}

function clipForPrompt(text: string, cap = 8_000): string {
  return text.length > cap ? text.slice(0, cap) + "\n…[truncated]" : text;
}
/**
 * Cap for "cross-agent" embeds (primary↔reviewer echoes). Tighter than the
 * default so iteration N+1's revise/re-review prompt doesn't inflate the
 * context linearly with every turn — each agent already has its own prior
 * messages in its own CLI session, so we only need enough of the other
 * side's response to anchor the current turn.
 */
const CROSS_AGENT_CAP = 3_500;

function endGoalBlock(endGoal: string | undefined): string {
  if (!endGoal) return "";
  // The explicit `End goal status: met` / `End goal status: not met` marker
  // is required so endless-mode orchestration can detect consensus and stop
  // the loop. Keep the instruction short — agents follow contracts better
  // when the required output is a single line with a fixed phrase.
  return (
    `\n\n<discussion_end_goal>\n${clipForPrompt(endGoal, 2_000)}\n</discussion_end_goal>\n\n` +
    `Conclude every response with a single line exactly of the form:\n` +
    `  End goal status: met\n` +
    `  End goal status: not met\n` +
    `If you write "met", the discussion stops here. If "not met", continue the discussion substantively and explain what's still missing.`
  );
}

/**
 * Initial prompt sent to the primary. For a single-exchange Review this is
 * essentially the user's prompt. For a multi-iteration Discussion we also
 * inject the end goal up front so the primary knows what we're aiming at.
 */
function buildInitialPrimaryPrompt(input: {
  markerId: string;
  userPrompt: string;
  endGoal: string | undefined;
  isDiscussion: boolean;
}): string {
  const body = input.isDiscussion
    ? `${input.userPrompt}${endGoalBlock(input.endGoal)}`
    : input.userPrompt;
  return buildWrappedPrompt(input.markerId, body);
}

/** Review prompt used on the very first primary → reviewer transition. */
function buildInitialReviewPrompt(input: {
  reviewerMarkerId: string;
  primaryAgent: AgentId;
  userPrompt: string;
  primaryResponse: string;
  diffBlock: string;
  endGoal: string | undefined;
}): string {
  const primaryLabel = input.primaryAgent === "claude" ? "Claude" : "Codex";
  const body =
    `Review the following work from ${primaryLabel}.\n\n` +
    `The user asked:\n---\n${input.userPrompt}\n---\n\n` +
    `Focus on bugs, incorrect assumptions, missed edge cases, and concrete improvements. ` +
    `Do not edit files unless explicitly instructed.\n\n` +
    `<primary_response>\n${clipForPrompt(input.primaryResponse) || "(empty)"}\n</primary_response>\n\n` +
    `<git_diff>\n${input.diffBlock}\n</git_diff>` +
    endGoalBlock(input.endGoal);
  return buildWrappedPrompt(input.reviewerMarkerId, body);
}

/**
 * Re-review prompt used on subsequent primary → reviewer transitions.
 *
 * Compacted: the reviewer's previous review is NOT re-embedded. The reviewer
 * has its own CLI session and remembers what it said last turn — sending it
 * back grows the context quadratically over an endless-mode run without
 * adding signal. Only the revised response + fresh git diff + end goal are
 * injected.
 */
function buildReReviewPrompt(input: {
  reviewerMarkerId: string;
  primaryAgent: AgentId;
  primaryResponse: string;
  diffBlock: string;
  turnNumber: number;
  endGoal: string | undefined;
}): string {
  const primaryLabel = input.primaryAgent === "claude" ? "Claude" : "Codex";
  const body =
    `Turn ${input.turnNumber}. ${primaryLabel} has posted a revised answer. ` +
    `Re-review it below. Your own previous feedback is in your CLI session — no need to re-read it; focus on what's new.\n\n` +
    `<revised_response>\n${clipForPrompt(input.primaryResponse, CROSS_AGENT_CAP) || "(empty)"}\n</revised_response>\n\n` +
    `<git_diff>\n${input.diffBlock}\n</git_diff>` +
    endGoalBlock(input.endGoal);
  return buildWrappedPrompt(input.reviewerMarkerId, body);
}

/**
 * Continuation prompt fed to the primary after a reviewer response on a
 * multi-turn round. Compacted: we still need to relay the reviewer's latest
 * feedback (it's cross-agent signal the primary cannot see from its own
 * session), but the cap is tightened so the prompt doesn't grow with each
 * iteration.
 */
function buildRevisePrompt(input: {
  primaryMarkerId: string;
  reviewerAgent: AgentId;
  reviewerResponse: string;
  turnNumber: number;
  endGoal: string | undefined;
}): string {
  const reviewerLabel = input.reviewerAgent === "claude" ? "Claude" : "Codex";
  const body =
    `Turn ${input.turnNumber}. ${reviewerLabel} just reviewed your previous answer. ` +
    `Your own prior answer is in your CLI session — no need to repeat it. ` +
    `Revise based on the feedback below; if you disagree with any point, say so briefly. Do not edit files unless explicitly instructed.\n\n` +
    `<review>\n${clipForPrompt(input.reviewerResponse, CROSS_AGENT_CAP) || "(empty)"}\n</review>` +
    endGoalBlock(input.endGoal);
  return buildWrappedPrompt(input.primaryMarkerId, body);
}

