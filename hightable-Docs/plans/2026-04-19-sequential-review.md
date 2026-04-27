# Sequential Review mode

**Goal:** Light up the `Claude → Codex` and `Codex → Claude` chips. One agent (the primary) answers the user's prompt. When its response arrives, we capture it, optionally capture the repo's `git status` + `git diff`, and feed both into a second prompt that the other agent (the reviewer) is asked to critique. The round is `Completed` only when the reviewer emits its DONE marker.

Spec: [mvp-plan.md:118-160](../mvp-plan.md#L118-L160). Review-prompt template is the one in that section.

Depends on the unified-session marker tracking that landed in [2026-04-19-structured-rounds.md](2026-04-19-structured-rounds.md).

## Task 1 — Types

**Files:** `src/shared/types.ts`.

- Extend `PromptTarget` with `"claude_to_codex"` and `"codex_to_claude"` so the enum carries both ordering choices. `resolveTargets` continues to be used for parallel modes only; sequential parses the target directly.

## Task 2 — Git diff capture

**Files:** new `src/main/git-diff.ts`.

- `captureGitDiff(repoPath): Promise<GitDiffArtifact>` runs `git status --short`, `git diff --stat`, and `git diff` inside the room's repo, each with a short timeout. Returns a `{ available: boolean; statusShort; diffStat; diff; note? }` shape.
- Returns `available: false` if the path isn't a git repo, or if git isn't on PATH. We still proceed with the review — the diff block becomes "(repository is not a git working tree)".
- Truncates each field at sensible caps (2 KB status, 64 KB diff) to avoid blowing up the reviewer's context.

## Task 3 — Orchestration state machine

**Files:** `src/main/orchestration-manager.ts`.

- `sendPrompt` recognises `mode === "sequential_review"`. Validates target is one of `claude_to_codex` or `codex_to_claude` and parses it into `{ primary, reviewer }`.
- Creates the round row with `mode: "sequential_review"`, `target` = the directional value.
- Writes the wrapped user prompt to the primary's PTY with a primary marker id (first 8 chars of round UUID).
- Tracks the round with a new pending shape:

  ```ts
  interface SequentialPending {
    roundId;
    primary: { agent; ptyId; dbTerminalId; markerId; startOffset; doneOffset?; response?; };
    reviewer: { agent; ptyId; dbTerminalId; markerId; startOffset?; doneOffset?; };
    phase: "primary" | "reviewer";
    userPrompt;
    repoPath;
    inactivityHandle;
  }
  ```

- On the primary's DONE marker:
  - Snapshot the cleaned primary response via the existing trim/filter pipeline.
  - Persist it as a `messages` row (`direction: "response"`, `agent: primary`).
  - Call `captureGitDiff(repoPath)`.
  - Build the review prompt (template in `mvp-plan.md`, with the primary response + diff injected). Use a second marker id.
  - Write the review prompt to the reviewer's PTY; persist a `direction: "prompt"` row on the reviewer side.
  - Flip `phase = "reviewer"`, record `reviewer.startOffset`, reset the inactivity timer.
- On the reviewer's DONE marker:
  - Snapshot reviewer response, persist as a `direction: "response"` message on the reviewer side.
  - `completeRound` + emit.
- Timeout / Mark-complete: snapshot whatever slice the current phase has; flip to `needs_attention` / `completed` as appropriate.

## Task 4 — Prompt bar

**Files:** `src/renderer/components/PromptBar.tsx`.

- Unify target chips: a single list marked with the modes each target supports.
  - `claude`, `codex`, `both` → manual / compare
  - `claude_to_codex`, `codex_to_claude` → sequential_review
- When mode changes, auto-pick a sane default target if the current selection isn't compatible.
- Enable the `Sequential Review` option in the mode dropdown.
- Rate-limit gating: a sequential target is disabled when *either* involved agent is rate-limited.
- Send button label reads "Review" for sequential_review.

## Task 5 — Timeline badges + drawer

**Files:** `src/renderer/components/RoundTimeline.tsx`, `src/renderer/components/RoundDetailDrawer.tsx`.

- `TargetBadges` gets two new cases that render "Claude → Codex" as one compact badge.
- Drawer layout for `sequential_review`:
  - Primary block (prompt + response).
  - Review block (review prompt + reviewer response).
  - Diff artifact block at the bottom if available.

## Task 6 — Verification

- [ ] Mode → Sequential Review, target → Claude → Codex. Send "What does this repo do?". Claude responds in its pane; round sits at `Submitted`. Once Claude emits DONE, the review prompt lands in the Codex pane automatically (visibly) with the cleaned Claude response and `git diff` pasted in. Codex responds; round flips to `Completed`.
- [ ] Opposite direction (Codex → Claude) works the same way.
- [ ] Drawer shows both responses in order plus the diff block.
- [ ] `Mark complete` on a stuck review round saves partial output.
- [ ] Rate-limit Claude → both sequential targets disabled with the tooltip.
- [ ] Open a non-git folder as the room's repo path — the review still fires and the diff block reads "(repository is not a git working tree)".

## Out of scope (follow-ups)

- Multi-reviewer chains (three-way review).
- Diff artifact file stored in `artifacts` table with a path to disk.
- Controls to edit the review template inline.
- Feeding a custom review instruction on top of the standard one.
