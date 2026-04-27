# Hightable MVP Plan

## Goal

Build the smallest useful version of Heliomodo Hightable: a local desktop app with two persistent embedded terminals, one prompt bar, room-based repo context, and basic transcript logging.

## Success Criteria

- User can create a room for a repository.
- User must select or enter a local path for each room.
- App launches one Claude terminal and one Codex terminal for that room.
- User can manually type in both terminals.
- User can send the same prompt to Claude, Codex, or both from one prompt bar.
- App stores raw terminal logs for both terminals.
- App records prompt rounds with status and timestamps.
- App can restart and show previous rooms and logs.
- App does not integrate with SourceTree.

## Milestone 1: Terminal Workbench

**Files to create during implementation:**

This list is the MVP target file set. Individual tasks in the implementation plan introduce the files in phases.

```text
package.json
package-lock.json
tsconfig.json
tsconfig.electron.json
vite.config.ts
index.html
src/main/main.ts
src/main/pty-manager.ts
src/main/room-manager.ts
src/main/command-builder.ts
src/main/orchestration-manager.ts
src/main/transcript-capture.ts
src/main/sqlite-store.ts
src/main/storage-paths.ts
src/preload/preload.ts
src/renderer/App.tsx
src/renderer/main.tsx
src/renderer/styles.css
src/renderer/components/TerminalPane.tsx
src/renderer/components/PromptBar.tsx
src/renderer/components/RoomSwitcher.tsx
src/renderer/components/RoundTimeline.tsx
src/shared/types.ts
src/shared/ipc.ts
```

Tasks:

- [ ] Scaffold Electron + React + TypeScript.
- [ ] Add `@xterm/xterm` terminal panes.
- [ ] Add `node-pty` process manager.
- [ ] Launch Claude terminal with `claude`.
- [ ] Launch Codex terminal with `codex --no-alt-screen -C <repo-path>`.
- [ ] Implement room creation with `name`, `repoPath`, and optional `topic`.
- [ ] Require a manually selected local filesystem path for each room.
- [ ] Do not add SourceTree import, SourceTree sync, or SourceTree repository discovery.
- [ ] Store room metadata in SQLite.
- [ ] Store raw PTY output under `~/.heliomodo/hightable/rooms/<room-id>/`.
- [ ] Add prompt bar actions: send to Claude, send to Codex, send to both.

Verification:

- [ ] Start the app.
- [ ] Create a room for a real repo.
- [ ] Confirm both terminals render and accept manual input.
- [ ] Send one prompt to Claude only.
- [ ] Send one prompt to Codex only.
- [ ] Send one prompt to both.
- [ ] Quit and restart app.
- [ ] Confirm the room is still listed.
- [ ] Confirm raw log files exist.

## Milestone 2: Structured Rounds

Goal: turn prompt sends into traceable orchestration rounds.

Tasks:

- [x] Generate a unique `roundId` for each prompt bar action.
- [x] Wrap automated prompts with `[HM_RUN_BEGIN:<round-id>]` and `[HM_RUN_DONE:<round-id>]`.
- [x] Parse cleaned terminal text from raw PTY streams.
- [x] Detect done markers and mark terminals idle.
- [x] Add a manual "mark complete" action.
- [x] Show round history in a timeline.
- [x] Store cleaned extracted responses per round.

Verification (manual — run against a live `npm run dev` instance):

- [ ] With the Track chip active, send a prompt to Claude; round stays `running` until the DONE marker arrives, then flips to `completed` with a stored cleaned response.
- [ ] Same for Codex.
- [ ] Missed marker (e.g. Ctrl-C the CLI mid-response) can be recovered via the timeline `Mark complete` button.
- [ ] A tracked round with no DONE marker flips to `needs_attention` after 120s.

## Milestone 3: Compare Mode

Goal: support independent answers from both CLIs.

Tasks:

- [x] Add a compare mode in the prompt bar.
- [x] Send the same prompt to Claude and Codex in parallel.
- [x] Track each terminal's busy state separately.
- [x] Show side-by-side extracted responses.
- [ ] Add optional synthesis prompt sent to the selected CLI. *(deferred — users can manually copy+paste a tracked follow-up for now.)*

Verification (manual — run against a live `npm run dev` instance):

- [ ] Select Compare mode, send "Summarize this repo in one paragraph." Both Claude and Codex receive the wrapped prompt.
- [ ] Timeline row shows `Compare / Running` until both DONE markers arrive, then flips to `Completed`.
- [ ] Clicking the row opens the drawer showing Claude and Codex responses side-by-side.
- [ ] `Mark complete` on a stuck compare round saves whatever cleaned text is buffered for both sides.

## Milestone 4: Sequential Review Mode

Goal: let one CLI produce work and the other review it.

Tasks:

- [ ] Add primary/reviewer selector.
- [ ] Send initial prompt to primary.
- [ ] After primary completion, collect primary response.
- [ ] Optionally collect `git diff` from the repo.
- [ ] Build review prompt for reviewer.
- [ ] Send review prompt to reviewer.
- [ ] Show primary result, review result, and diff artifact.

Review prompt template:

```text
[HM_RUN_BEGIN:<round-id>]

Review the following work from <primary-agent>.

Focus on bugs, incorrect assumptions, missed edge cases, and concrete improvements.
Do not edit files unless explicitly instructed.

<primary_response>
...
</primary_response>

<git_diff>
...
</git_diff>

End your final response with:
[HM_RUN_DONE:<round-id>]
```

Verification:

- [ ] Run Claude first, Codex review.
- [ ] Run Codex first, Claude review.
- [ ] Confirm reviewer receives the primary response.
- [ ] Confirm reviewer does not receive unrelated raw terminal noise.
- [ ] Confirm diff artifact is attached when repo has changes.

## Milestone 5: Discussion Mode

Goal: support bounded Claude/Codex discussion.

Tasks:

- [ ] Add discussion mode with max rounds.
- [ ] Send the same initial topic to both terminals.
- [ ] Feed each terminal the other terminal's previous response.
- [ ] Stop automatically at max rounds.
- [ ] Ask selected synthesizer for final summary.

Defaults:

```text
default_rounds: 2
max_rounds: 3
default_synthesizer: user_selected
default_editing_policy: read_only
```

Verification:

- [ ] Run a two-round design discussion.
- [ ] Confirm the app does not exceed the configured round cap.
- [ ] Confirm each follow-up prompt includes only the previous extracted response, not full raw logs.
- [ ] Confirm final synthesis is stored as a separate artifact.

## Deferred Features

- Non-interactive resume mode using `claude -p --resume` and `codex exec resume`.
- Git worktree isolation for parallel implementation.
- Search across transcripts.
- Per-room model/profile settings.
- Keyboard shortcuts.
- Export a round bundle as Markdown.
- Web-based remote access.

## Implementation Notes

- Keep the first version local only.
- Prefer explicit state over clever terminal inference.
- Store raw logs before parsing.
- Treat terminal parsing as best-effort.
- Keep orchestration prompts short and clearly marked.
- Never send a new automated prompt to a busy terminal.
