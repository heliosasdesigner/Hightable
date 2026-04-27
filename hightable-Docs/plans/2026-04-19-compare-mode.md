# Milestone 3 — Compare Mode

**Goal:** Let the user send the same prompt to Claude and Codex in parallel with tracked completion, and review the two extracted responses side-by-side in a round-detail drawer.

Spec: [mvp-plan.md:99-116](../mvp-plan.md#L99-L116).

Depends on the marker infrastructure landed in [2026-04-19-structured-rounds.md](2026-04-19-structured-rounds.md).

## Task 1 — Accept compare mode in orchestration

**Files:** `src/main/orchestration-manager.ts`, `src/shared/types.ts`.

- `sendPrompt` currently throws on any mode except `"manual"`. Allow `"compare"`:
  - Force `target` to `"both"` regardless of what the caller passed.
  - Force `track` to `true` — compare without tracking is meaningless.
  - Preserve the `mode: "compare"` in the created round row so the timeline shows the right label.
- Internal refactor: `sendTrackedPrompt` currently hard-codes `mode: "manual"` in its `createRound` call. Take the effective mode as a parameter so compare rounds store `"compare"`.

## Task 2 — Expose round detail (prompt + response messages)

**Files:** `src/shared/types.ts`, `src/shared/ipc.ts`, `src/main/sqlite-store.ts`, `src/preload/preload.ts`, `src/main/main.ts`.

- New type `RoundMessage` mirroring the `messages` row (id, roundId, terminalId?, agent, direction, cleanedText?, rawTextPath?, createdAt).
- New type `RoundDetail` = `{ round: PromptRound; messages: RoundMessage[] }`.
- Store: add `listMessages(roundId)` returning ordered messages for that round.
- IPC channel `GetRound` + `window.hightable.getRound(roundId): Promise<RoundDetail>`.
- Main handler reads round + messages and returns the detail.

## Task 3 — Round detail drawer

**Files:** new `src/renderer/components/RoundDetailDrawer.tsx`, `src/renderer/styles.css`.

- When the user clicks a timeline row, the timeline sidebar swaps to the drawer (same 340px width, no layout shift).
- Drawer contents:
  - Back button (returns to timeline list).
  - Prompt, mode, status, started/completed timestamps.
  - **Compare layout**: two stacked sections labelled "Claude" and "Codex" (each 1fr height), scrollable, monospace, showing the cleaned response text. Missing responses render a muted "no response recorded" placeholder.
  - **Non-compare layout**: single response section, same treatment.
- Fetches `getRound(roundId)` on mount and whenever that round receives an `onRoundUpdated` event.

## Task 4 — Timeline row click → drawer

**Files:** `src/renderer/components/RoundTimeline.tsx`, `src/renderer/App.tsx`.

- Add `onOpenRound(roundId)` prop to `RoundTimeline`; rows call it on click (already `role="button"`, just needs a handler).
- App owns `selectedRoundId` state. Selecting a row swaps the sidebar content; closing returns to the list.
- Clear `selectedRoundId` when the active room changes.

## Task 5 — Enable compare in the prompt bar

**Files:** `src/renderer/components/PromptBar.tsx`.

- Enable the `compare` option in the existing mode select.
- When `mode === "compare"`:
  - Target chips become inert visual indicators (both lit, no per-target selection).
  - Track chip forced on and disabled.
  - Send button label reads "Compare".
- Reverting to manual restores all the usual controls.

## Verification (manual, live)

Per [mvp-plan.md:112-116](../mvp-plan.md#L112-L116):

- [ ] Mode → Compare, prompt → "Summarize the MVP plan in one paragraph." Send. Claude and Codex both receive the wrapped prompt; the timeline row shows `Compare / Running`.
- [ ] Row flips to `Completed` only after both agents emit DONE.
- [ ] Click the row — drawer shows Claude's and Codex's responses side-by-side (stacked in the 340px sidebar).
- [ ] Force a missed DONE on one side (Ctrl-C Codex). `Mark complete` on the row saves whatever cleaned text was buffered for both sides and closes the round.
- [ ] Switch rooms; the drawer closes, timeline returns.

## Out of scope (next milestones)

- Synthesis prompt (send a follow-up round to a chosen CLI with the two responses as input) — left for Milestone 4 territory or a dedicated small follow-up.
- Agreement/difference diffing between the two responses.
- Round raw-log viewing inside the drawer (raw logs are still on disk for now).
