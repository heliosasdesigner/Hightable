# Hightable MVP Verification

Manual checklist for confirming the MVP builds, runs, and behaves as specified in `hightable-Docs/mvp-plan.md`. Run this end-to-end before shipping a release candidate.

## Prerequisites

- macOS, Linux, or WSL environment with a working Electron build toolchain.
- `claude` and `codex` CLIs installed and reachable on `PATH`.
- Both CLIs authenticated for the user account via their normal interactive flow.
- Repository checked out at `/Users/<you>/.../hightable` (or equivalent).

## Environment checks

```bash
node --version       # 20.x or 22.x
npm --version        # 10.x+
which claude
which codex
```

## Build + tooling

```bash
npm install
npm run rebuild:electron
npm run typecheck
npm run build
npm test
```

Expected:

- `typecheck` exits 0.
- `build` exits 0 and writes both `dist/` (renderer) and `dist-electron/` (main + preload).
- `test` rebuilds native modules for Node and passes all suites.

## Runtime binary detection

```bash
npm run dev
```

- [ ] App window opens.
- [ ] Main process log shows `claude found at …` and `codex found at …`.
- [ ] If either CLI is missing, the log warns instead of crashing.

## Empty-state behaviour

- [ ] On first launch with no rooms, the workspace shows "Create a room to attach Claude Code and Codex CLI terminals to a repository." and a `New Room` button.

## Room creation

1. Click `+ New Room` or the empty-state `New Room` button.
2. In the dialog:
   - [ ] Enter a name.
   - [ ] Click `Pick…` and select a local directory; the input updates with its path.
   - [ ] Alternatively paste a path manually.
   - [ ] Submitting with an empty name or path shows an inline error.
   - [ ] Submitting with a non-existent path shows a clear error ("Repo path does not exist: …").
   - [ ] Submitting with a file (not a directory) shows a clear error.
3. On success:
   - [ ] Dialog closes.
   - [ ] Room appears in the sidebar and becomes active.
   - [ ] Both terminal panes render.

## Terminal session

- [ ] Claude terminal shows the Claude Code prompt.
- [ ] Codex terminal shows the Codex CLI prompt.
- [ ] Typing in either pane routes keystrokes to the corresponding CLI.
- [ ] Terminal status pill reads `idle`; dots are amber (Claude) and cyan (Codex).

## Prompt bar manual sends

- [ ] Type a prompt, select `Claude`, click `Send`: text lands in the Claude terminal with a carriage return.
- [ ] Type a prompt, select `Codex`, click `Send`: text lands in the Codex terminal.
- [ ] Type a prompt, select `Both`, click `Send`: same text lands in both.
- [ ] `Cmd/Ctrl + Enter` submits.
- [ ] An empty prompt cannot be submitted.
- [ ] Sending without an open room is blocked.

## Round timeline

- [ ] Each send appears in the timeline sidebar as a manual round with mode `Manual` and status `Completed`.
- [ ] Timestamps reflect local time.
- [ ] The sidebar hide/show toggle works; refresh preserves the view.

## Transcript persistence

- [ ] After any terminal output, `~/.heliomodo/hightable/rooms/<room-id>/claude.raw.log` and `codex.raw.log` exist and accumulate content.
- [ ] Quit the app.
- [ ] Relaunch with `npm run dev`.
  - [ ] The last active room is re-opened automatically.
  - [ ] Raw log files from the previous session are preserved.
  - [ ] Prior rounds appear in the timeline.

## Persistence across restart

- [ ] Create two rooms with different paths.
- [ ] Quit and relaunch.
- [ ] Both rooms remain listed in the sidebar.
- [ ] Clicking the non-active room switches terminals to that repo's PTYs.

## Clean shutdown

- [ ] Quitting the app kills child PTYs (no orphan `claude` / `codex` processes in `ps`).

## Tracked rounds (Milestone 2)

Automated marker detection is live. With the Track chip active in the prompt bar:

- [ ] Prompt is wrapped with `[HM_RUN_BEGIN:<id>]` / `[HM_RUN_DONE:<id>]` markers before being written to the PTY.
- [ ] Round stays `running` until the CLI emits the DONE marker on its output.
- [ ] When all targeted terminals emit DONE, the round flips to `completed` and a cleaned `direction: "response"` message is stored per terminal.
- [ ] If a CLI skips the DONE marker, clicking `Mark complete` on the timeline row saves whatever cleaned text is buffered and closes the round.
- [ ] A 120-second silence flips the round to `needs_attention` automatically.

## Known MVP limitations

- `Claude → Codex`, `Codex → Claude`, Compare, Sequential Review, and Discussion modes are visible in the UI but disabled — they build on top of the marker infrastructure from Milestone 2.
- Round detail drawer (cleaned response view) is not wired yet; responses are in SQLite (`messages` table) and raw logs.
- No git diff capture yet.
