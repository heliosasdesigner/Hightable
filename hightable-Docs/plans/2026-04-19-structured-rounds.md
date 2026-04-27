# Milestone 2 — Structured Rounds

**Goal:** Turn prompt sends into traceable orchestration rounds. Automated prompts are wrapped with `[HM_RUN_BEGIN:<id>]` / `[HM_RUN_DONE:<id>]`, the done marker is detected in cleaned terminal output, the cleaned response is extracted and persisted as a `direction: "response"` message, and the round flips to `completed`. Missing markers fall back to manual `Mark complete` and a timeout `needs_attention` state.

Spec: [mvp-plan.md:78-97](../mvp-plan.md#L78-L97), [architecture.md:210-220](../architecture.md#L210-L220).

## Task 1 — Marker detection in TranscriptCapture

**Files:** `src/main/transcript-capture.ts`, new `src/main/transcript-capture.test.ts`.

- Maintain a bounded rolling cleaned-text buffer per terminal (ANSI-stripped, cap 128 KB).
- On every `append`, strip ANSI and scan the delta for `\[HM_RUN_(BEGIN|DONE):<uuid>\]`.
- Expose `onMarker(listener)` returning an `Unsubscribe`. Event shape: `{ terminalId, agent, kind: "begin" | "done", markerId, bufferOffset }`.
- Expose `getCleanedText(terminalId): string` returning the current bounded buffer.
- Expose `snapshotOffset(terminalId): number` for capturing "start of this round" markers.
- Add a unit test covering: single-chunk match, cross-chunk match (marker split across two `append` calls), ANSI noise interspersed.

## Task 2 — Round tracker in OrchestrationManager

**Files:** `src/main/orchestration-manager.ts`, `src/shared/types.ts`.

- Add `track?: boolean` to `SendPromptInput`. Default `false` — preserves today's manual behaviour.
- When `track === true`:
  - Generate round id (reuse existing flow).
  - Build the wrapped prompt per `architecture.md`:
    ```
    [HM_RUN_BEGIN:<id>]
    <user prompt>
    When your final response is complete, end with: [HM_RUN_DONE:<id>]
    ```
  - Record the per-terminal cleaned-buffer offset at send time.
  - Write the wrapped prompt + `\r` to each targeted PTY.
  - Create a `messages` row per target with `direction: "prompt"` (unchanged).
  - Register the round in a per-manager `pending` map keyed by roundId, with expected terminal IDs.
  - Leave round status as `running` — do NOT auto-complete.
- Subscribe to `TranscriptCapture.onMarker`:
  - On `kind: "done"` with a matching `markerId`, extract cleaned text from the buffer slice for that terminal from the captured offset up to the DONE marker, strip the BEGIN block and the trailing "end with…" hint line, and persist a `messages` row with `direction: "response"`.
  - When all expected terminals have emitted their DONE markers, flip the round to `completed` and emit a round update.
- Add a 120s timeout per tracked round. If not all terminals have responded, mark the round `needs_attention` and emit.
- `markRoundComplete(roundId)` already exists; ensure it:
  - clears the pending entry if present,
  - saves whatever cleaned text is already buffered for each still-pending terminal,
  - flips to `completed`.

## Task 3 — Prompt bar toggle

**Files:** `src/renderer/components/PromptBar.tsx`, `src/renderer/App.tsx`.

- Add a small "Track" toggle to the prompt-actions row (pill-style, matching the target chips).
- Forward the boolean to `onSend`; plumb it through `App.tsx` → `window.hightable.sendPrompt`.
- Keep the mode selector showing "Manual" only. Tracked is a per-send flag, not a mode change — Compare / Review / Discussion get their own modes later.

## Task 4 — Timeline affordances

**Files:** `src/renderer/components/RoundTimeline.tsx` (already shows Mark complete on `running` / `needs_attention`, no change needed).

- Confirm `Mark complete` triggers `markRoundComplete` on a tracked round and the timeline row transitions correctly.
- Visually indicate a tracked round vs a manual one (small "tracked" tag in the mode cell is enough).

## Verification

Per [mvp-plan.md:92-97](../mvp-plan.md#L92-L97):

- [ ] Enable Track, send a prompt to Claude. Round stays `running` until Claude's output contains `[HM_RUN_DONE:<id>]`, then flips to `completed` and the timeline row shows the cleaned response.
- [ ] Same for Codex.
- [ ] Force a missed marker (e.g. send a tracked prompt then immediately Ctrl-C the CLI so it doesn't emit DONE). Confirm `Mark complete` manually completes the round and saves whatever cleaned text accumulated.
- [ ] Wait 120s on a no-response prompt. Confirm the round flips to `needs_attention`.

## Out of scope (next milestones)

- Compare mode (parallel tracked send, side-by-side extracted responses)
- Sequential Review (primary → reviewer prompt chain, git diff capture)
- Discussion mode
- Round detail drawer

These all sit on top of the marker infrastructure landed here.
