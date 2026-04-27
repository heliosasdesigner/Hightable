# Discussion mode

**Goal:** Enable a bounded automated back-and-forth between Claude and Codex. User gives one topic; Hightable sends it to both agents in parallel, captures each response, then feeds each agent the other's last response as "continue the discussion", up to a user-selected turn cap (default 2, max 3). Round is `Completed` after the final turn's two DONE markers arrive.

Spec: [mvp-plan.md:162-175](../mvp-plan.md#L162-L175). Read-only editing policy implied — we don't instruct the agents to make changes.

## Task 1 — Types

- `SendPromptInput` gains an optional `discussionTurns?: number` (2 or 3; default 2). Only read when `mode === "discussion"`.

## Task 2 — Orchestration

**Files:** `src/main/orchestration-manager.ts`.

- New pending shape:
  ```ts
  interface DiscussionTurn {
    claude: { markerId; startOffset; doneOffset; saved: boolean; response?: string };
    codex:  { markerId; startOffset; doneOffset; saved: boolean; response?: string };
  }
  interface PendingDiscussion {
    kind: "discussion";
    roundId; roomId;
    userPrompt: string;
    totalTurns: number;
    currentTurn: number;
    turns: DiscussionTurn[];
    inactivityHandle;
    // PTY ids cached so bumpActivity / supersede can find us without rescans
    claudePty; codexPty;
    claudeTerminalDbId; codexTerminalDbId;
  }
  ```
- `sendPrompt` recognises `mode === "discussion"`, checks both PTYs present and neither rate-limited, then calls `beginDiscussion`.
- `beginDiscussion`:
  - Creates round with `mode: "discussion"`, `target: "both"`.
  - Generates per-turn markers (a short hex id per agent per turn, derived from round UUID + turn number + agent so each one is unique and short).
  - Writes the user's prompt to both PTYs concurrently with their turn-0 markers. Persists two `direction: "prompt"` messages.
- On marker DONE:
  - Match to `(turn, agent)` by markerId. Snapshot cleaned response via the existing filter. Persist as `direction: "response"` message. Record `turns[t].agent.saved`.
  - When both agents' responses have landed for the current turn:
    - If `currentTurn + 1 < totalTurns`: compose per-agent continuation prompt using the *other* agent's response. Write to both PTYs. Persist continuation `direction: "prompt"` messages (for the drawer to show what each side was fed). Advance `currentTurn`.
    - Else: `completeRound` + emit.
- Timeout / mark-complete / supersede reuse the same pattern as parallel rounds: snapshot partial current-turn responses, flip status, clear pending.

Composed continuation prompt (per agent):
```
Continue the discussion. Here is what <Other> just said:

<their_response>
<cleaned response text>
</their_response>

Respond to them: build on what they got right, push back where you disagree, keep it concise. Do not edit files. This is turn <N+1> of <total>.
```

Wrapped with the usual `[HM_RUN_BEGIN:<markerId>]` / `[HM_RUN_DONE:<markerId>]` framing.

## Task 3 — Prompt bar

**Files:** `src/renderer/components/PromptBar.tsx`.

- Enable the `Discussion` option in the mode dropdown.
- When `mode === "discussion"`: hide target chips (implicit `both`), show a small turn-count selector with `2` and `3`. Send button reads "Discuss".
- Pass the turn count through to `onSend` → `sendPrompt`.

## Task 4 — Drawer rendering

**Files:** `src/renderer/components/RoundDetailDrawer.tsx`.

- For `mode === "discussion"` rounds, group response messages per agent by chronological index (N-th response from an agent = turn N).
- Render a vertical stack of turn sections; each turn shows Claude and Codex side-by-side. A header `Turn 1`, `Turn 2`, etc.
- Skip the per-turn prompt messages in the drawer (they're available in the DB if we want them later); this keeps the drawer readable.

## Task 5 — Timeline badge

`TargetBadges` already returns `Discuss` when mode is discussion. No change needed, but confirm it still fires for the new rounds.

## Verification

- [ ] Mode → Discussion, turns = 2. Send "Which database model fits a single-page Next.js marketing site?" Both panes receive the prompt in parallel. Round sits at `Submitted`.
- [ ] When both respond (both emit DONE), each pane automatically receives a continuation prompt with the other's response.
- [ ] Round completes after turn 2 for both agents. Drawer shows **Turn 1 / Claude / Codex** then **Turn 2 / Claude / Codex**.
- [ ] Mark-complete mid-discussion saves the partial responses and closes the round.
- [ ] Setting turns = 3 runs three exchanges before completing.

## Out of scope

- Synthesizer step (ask one agent to summarise at the end). Follow-up.
- Per-turn editing-policy override (always read-only here).
- Streaming intermediate turns into the drawer as they complete (drawer only refreshes on round updates; we do emit a round update between turns so it does refresh).
