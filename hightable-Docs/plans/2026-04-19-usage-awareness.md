# Usage Awareness — per-agent counts + manual rate-limit gating

**Goal:** Show how many prompts each agent has received today / this week, and let the user explicitly flag an agent as rate-limited until a given time so Hightable prevents further sends and surfaces a countdown.

Rationale: Claude Code (weekly Max quota) and Codex (per-request billing) have very different usage models and neither CLI exposes quota information programmatically. The user asked either to record next-available times or update state per prompt — this plan does both in the simplest useful form.

Non-goals: auto-detecting rate-limit hits from CLI error strings (deferred; see "follow-up #3" at the bottom).

## Data model

New SQLite table:

```sql
CREATE TABLE IF NOT EXISTS rate_limits (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  limited_until TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
```

One row per "the user flagged a rate limit". Reads filter by `limited_until > now()` and pick the latest row per agent.

Usage counts are derived from the existing `messages` table (where `direction = 'prompt'`) grouped by `agent` and `created_at` window. No new table needed.

## Task 1 — Store additions

**Files:** `src/main/sqlite-store.ts`, `src/shared/types.ts`.

- Schema: add `rate_limits` table to `initializeSchema`.
- Types: `AgentRateLimit` (id, agent, limitedUntil, note?, createdAt) and `AgentUsageStats` (agent, today, week, limitedUntil?).
- Methods:
  - `createRateLimit({ agent, limitedUntil, note? }): AgentRateLimit`
  - `clearRateLimits(agent)` — deletes all rows for that agent; simpler than an "active" flag and avoids duplicate-row ambiguity.
  - `getActiveRateLimit(agent): AgentRateLimit | undefined` — latest row with `limited_until > now()`.
  - `countPromptsSince(agent, since: string): number` — messages where `direction='prompt' AND agent=? AND created_at >= ?`.

## Task 2 — IPC + handlers

**Files:** `src/shared/ipc.ts`, `src/shared/types.ts`, `src/preload/preload.ts`, `src/main/main.ts`.

- New channels: `GetAgentUsage`, `SetAgentRateLimit`, `ClearAgentRateLimit`.
- New event: `AgentUsageUpdated` (broadcast after any change so the renderer keeps both terminals in sync).
- API additions on `window.hightable`:
  - `getAgentUsage(): Promise<AgentUsageStats[]>`
  - `setAgentRateLimit({ agent, limitedUntil, note? }): Promise<AgentRateLimit>`
  - `clearAgentRateLimit({ agent }): Promise<void>`
  - `onAgentUsageUpdated(cb): Unsubscribe`
- Main process:
  - Handlers call into the store.
  - `OrchestrationManager.sendPrompt` broadcasts `AgentUsageUpdated` after the round is recorded so counts refresh without manual polling.
  - `sendPrompt` also throws if any target agent currently has an active rate-limit row — defensive gate on top of the UI disable.

## Task 3 — Topbar usage pills

**Files:** new `src/renderer/components/AgentUsageBar.tsx`, `src/renderer/App.tsx`, `src/renderer/styles.css`.

- Replaces the current `.binary-status` slot.
- One pill per agent: `• Claude  47` or, when limited, `• Claude  ⏸ 2h 15m`.
- Click a pill → small popover with:
  - Counts: today / week.
  - Quick "Limit until" buttons: +15 min, +1 hour, +4 hours, "tomorrow 9 am", custom datetime input.
  - If currently limited: "Clear limit" button and the stored note.
- Popover closes on outside click or Escape.
- Countdown for `⏸ …` label refreshes once a minute; when `limitedUntil` passes, it clears locally and the next `getAgentUsage` refresh confirms.

## Task 4 — Prompt bar enforcement

**Files:** `src/renderer/components/PromptBar.tsx`.

- Accepts `limitedAgents: Set<AgentId>` via props.
- When a target's agent is in that set, its chip is disabled with a tooltip: "Claude rate-limited until HH:MM. Click the topbar pill to clear."
- Compare mode disables send entirely when either agent is limited.

## Task 5 — Wiring and refresh

**Files:** `src/renderer/App.tsx`.

- App maintains `usage: AgentUsageStats[]` state.
- Load on mount via `getAgentUsage()`.
- Refresh on `onAgentUsageUpdated` broadcast.
- Derives `limitedAgents` set from `usage` entries whose `limitedUntil` is in the future.
- Passes both down to `AgentUsageBar` and `PromptBar`.

## Verification (manual)

- [ ] Send a prompt to Claude. Topbar pill for Claude increments (`0` → `1`). Codex stays at `0`.
- [ ] Send a compare prompt. Both pills increment by 1.
- [ ] Click Claude's pill, hit "+1 hour". Pill shows `⏸ 59m`. In the prompt bar the Claude target chip is disabled with the resume time in its tooltip. Compare button is also disabled.
- [ ] Click Claude's pill, hit "Clear limit". Disable state lifts.
- [ ] Kill the app, relaunch. Usage counts and active rate-limit persist.
- [ ] Wait for a short (+1 min) rate-limit to expire naturally. Pill clears on its next tick.

## Follow-ups (not this milestone)

1. Detect known rate-limit error strings in cleaned PTY output and auto-populate a rate-limit entry with the parsed reset time. Pattern library lives next to `ansi.ts`.
2. Weekly / monthly usage view in the drawer area.
3. Multi-account awareness — if Heliomodo eventually runs multiple Claude or Codex accounts, the rate-limit key needs to include account id.
