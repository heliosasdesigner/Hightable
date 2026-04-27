# Search across transcripts

**Goal:** A quick-access search box that matches user prompts + agent cleaned responses across all rooms. Hit `Cmd+K` (Ctrl+K on Win/Linux), type, see matching rounds, click to jump — switching rooms if needed.

Scope: SQLite-backed substring search only. Raw `.raw.log` files on disk are full of TUI noise and not indexed yet; leaving `ripgrep` against them to a future milestone.

## Task 1 — Store + types

**Files:** `src/main/sqlite-store.ts`, `src/shared/types.ts`.

- New type `TranscriptSearchResult`:
  ```ts
  {
    roundId; roomId; roomName; mode; target; status;
    startedAt; snippet: string; matchedIn: "prompt" | "response";
    agent?: AgentId; // only set when matchedIn = 'response'
  }
  ```
- `searchMessages(query, { limit = 50 })` — case-insensitive LIKE across `rounds.prompt` and `messages.cleaned_text`. Uses `DISTINCT` at the round level so a round with multiple matching messages doesn't appear twice. Query joins `rooms` for `roomName`. Orders by `started_at DESC`.
- Snippet: `substr(text, start, 200)` aligned to the first match — just enough context for the search list to feel useful.

## Task 2 — IPC + preload

**Files:** `src/shared/ipc.ts`, `src/shared/types.ts`, `src/preload/preload.ts`, `src/main/main.ts`.

- New channel `SearchTranscripts`. Handler reads from the store.
- API: `window.hightable.searchTranscripts({ query })`.

## Task 3 — Search overlay

**Files:** new `src/renderer/components/SearchOverlay.tsx`, `src/renderer/styles.css`.

- Modal overlay (reuses the dialog-backdrop treatment from `NewRoomDialog`).
- Input at top — debounced 150 ms query.
- Result list: per row shows the room name, mode + target badges, status, a monospace snippet with the matched substring highlighted, and the started-at timestamp. Keyboard navigation with ↑/↓ and Enter to open.
- Empty state: "Type to search across rounds in every room."

## Task 4 — Wire keyboard shortcut + navigation

**Files:** `src/renderer/App.tsx`.

- `Cmd+K` / `Ctrl+K` toggles `searchOpen`. `Escape` inside the overlay closes it.
- When a result is chosen: if the result's roomId matches the current session, just select that round. Otherwise, open the room first, then open the drawer on the selected round.
- A small pill in the topbar (`⌘K`) invites discovery.

## Verification

- [ ] Cmd+K opens the overlay; typing filters in real time.
- [ ] Clicking a result opens the drawer for that round — in the current room (no room switch) or by switching rooms first.
- [ ] Matches appear for both `prompts` you typed and `responses` the agents produced.
- [ ] Matches respect case-insensitivity.
- [ ] Large result counts (50+) render without jank; scroll works.

## Out of scope (follow-ups)

- Regex / phrase search.
- Raw-log (`.raw.log`) grep with ripgrep.
- Filter by agent / status / room / date range.
- FTS5-backed ranking.
