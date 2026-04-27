# Hightable Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build Heliomodo Hightable as a local desktop workbench that embeds persistent Claude Code CLI and Codex CLI terminals, sends prompts into either or both terminals, and records room-based prompt rounds.

**Architecture:** Hightable is an Electron app with a privileged main process for PTY, filesystem, SQLite, and git operations, plus a React renderer for terminal panes, prompt controls, room navigation, and round history. The app treats Claude and Codex as real terminal processes controlled through `node-pty`; structured orchestration is layered on top with prompt markers and transcript capture.

**Tech Stack:** Electron, React, TypeScript, Vite, `@xterm/xterm`, `node-pty`, SQLite, Node filesystem APIs.

---

## Preconditions

- Work from `/Users/heliosslso/Heliomodo/Internal/tools/hightable`.
- Confirm `claude` and `codex` are available on `PATH`.
- Keep implementation local-only.
- Do not use official Claude or Codex SDKs for the MVP.
- Keep Claude/Codex authentication owned by the user's existing terminal login.
- Require a user-selected local filesystem path for every room.
- Do not add SourceTree integration, import, sync, or repository discovery.
- Initialize this folder as a git repository before following commit steps, or explicitly skip commit steps when running in a non-git workspace.

## Task 1: Scaffold Desktop App

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.electron.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/main/main.ts`
- Create: `src/preload/preload.ts`
- Create: `src/renderer/App.tsx`
- Create: `src/renderer/main.tsx`
- Create: `src/renderer/styles.css`
- Create: `src/shared/types.ts`

**Step 1: Create package metadata**

Add an Electron + React + TypeScript package named `@heliomodo/hightable`.

Scripts:

```json
{
  "main": "dist-electron/main/main.js",
  "scripts": {
    "clean": "node -e \"const fs=require('node:fs');fs.rmSync('dist',{recursive:true,force:true});fs.rmSync('dist-electron',{recursive:true,force:true})\"",
    "dev": "npm run build:electron && npm run rebuild:electron && concurrently -k \"vite --host 127.0.0.1\" \"wait-on http://127.0.0.1:5300 && VITE_DEV_SERVER_URL=http://127.0.0.1:5300 electron dist-electron/main/main.js\"",
    "dev:renderer": "vite --host 127.0.0.1",
    "dev:electron": "npm run build:electron && VITE_DEV_SERVER_URL=http://127.0.0.1:5300 electron dist-electron/main/main.js",
    "build": "npm run clean && npm run typecheck && npm run build:electron && vite build",
    "build:electron": "tsc -p tsconfig.electron.json",
    "rebuild:native": "npm run rebuild:electron",
    "rebuild:electron": "electron-rebuild -f -w better-sqlite3,node-pty",
    "rebuild:node": "npm rebuild better-sqlite3 node-pty",
    "typecheck": "tsc --noEmit",
    "test": "npm run rebuild:node --silent && vitest run"
  }
}
```

**Step 2: Install dependencies**

Run:

```bash
npm install @vitejs/plugin-react vite typescript react react-dom electron
npm install @xterm/xterm @xterm/addon-fit node-pty better-sqlite3
npm install -D @types/node @types/react @types/react-dom vitest @electron/rebuild concurrently wait-on
npm run rebuild:electron
```

`node-pty` and `better-sqlite3` are native modules. `npm run dev` rebuilds them for Electron before launching the app. `npm test` rebuilds them back for the local Node/Vitest ABI before running tests. Run `npm run rebuild:electron` manually after dependency install or whenever the Electron version changes.

**Step 3: Create minimal renderer**

`src/renderer/App.tsx` should render the shell with placeholder regions:

```tsx
export function App() {
  return (
    <main className="app-shell">
      <aside className="sidebar">Rooms</aside>
      <section className="workspace">
        <header className="topbar">Heliomodo Hightable</header>
        <section className="prompt-bar">Prompt controls</section>
        <section className="terminal-grid">
          <div className="terminal-panel">Claude</div>
          <div className="terminal-panel">Codex</div>
        </section>
        <section className="timeline">Rounds</section>
      </section>
    </main>
  );
}
```

**Step 4: Verify typecheck**

Run:

```bash
npm run typecheck
```

Expected: TypeScript exits with code 0.

**Step 5: Initialize git if needed**

If `/Users/heliosslso/Heliomodo/Internal/tools/hightable` is not already a git repository, run:

```bash
git init
```

Expected: a new local git repository is initialized for Hightable.

**Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.electron.json vite.config.ts index.html src
git commit -m "feat: scaffold Hightable desktop app"
```

## Task 2: Define Shared Types and IPC Contract

**Files:**

- Modify: `src/shared/types.ts`
- Create: `src/shared/ipc.ts`
- Modify: `src/preload/preload.ts`

**Step 1: Add domain types**

Define the core room, terminal, and round models:

```ts
export type AgentId = "claude" | "codex";
export type TerminalStatus = "idle" | "starting" | "busy" | "needs_attention" | "failed" | "stopped";
export type RoundMode = "manual" | "compare" | "sequential_review" | "discussion";

export interface HightableRoom {
  id: string;
  name: string;
  repoPath: string;
  topic?: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface HightableTerminal {
  id: string;
  roomId: string;
  agent: AgentId;
  command: string;
  cwd: string;
  status: TerminalStatus;
  startedAt: string;
  stoppedAt?: string;
}

export interface PromptRound {
  id: string;
  roomId: string;
  mode: RoundMode;
  prompt: string;
  status: "queued" | "running" | "needs_attention" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
}
```

**Step 2: Add IPC channel names**

Define typed channel constants for room creation, terminal output, terminal input, prompt send, and round status updates.

**Step 3: Expose preload API**

Expose a narrow `window.hightable` API:

```ts
window.hightable = {
  createRoom,
  listRooms,
  openRoom,
  writeTerminal,
  resizeTerminal,
  sendPrompt,
  markRoundComplete,
  onTerminalData,
  onRoundUpdated,
};
```

**Step 4: Verify typecheck**

Run:

```bash
npm run typecheck
```

Expected: TypeScript exits with code 0.

**Step 5: Commit**

```bash
git add src/shared src/preload
git commit -m "feat: define Hightable IPC contracts"
```

## Task 3: Implement Local Store

**Files:**

- Create: `src/main/sqlite-store.ts`
- Create: `src/main/storage-paths.ts`
- Test: `src/main/sqlite-store.test.ts`

**Step 1: Write store tests**

Cover:

- database initializes tables
- room can be created and listed
- terminal status can be updated
- round can be created and completed

**Step 2: Implement storage paths**

Use:

```text
~/.heliomodo/hightable/
  hightable.sqlite
  rooms/
```

**Step 3: Implement SQLite schema**

Implement tables from `hightable-Docs/architecture.md`:

- `rooms`
- `terminals`
- `rounds`
- `messages`
- `artifacts`

**Step 4: Run tests**

Run:

```bash
npm test -- sqlite-store
```

Expected: all local store tests pass.

**Step 5: Commit**

```bash
git add src/main/sqlite-store.ts src/main/storage-paths.ts src/main/sqlite-store.test.ts
git commit -m "feat: add local Hightable store"
```

## Task 4: Implement PTY Manager

**Files:**

- Create: `src/main/command-builder.ts`
- Create: `src/main/pty-manager.ts`
- Test: `src/main/command-builder.test.ts`

**Step 1: Write command builder tests**

Test expected commands:

```text
claude -> claude
codex -> codex --no-alt-screen -C <repo-path>
```

`codex --help` confirms `--no-alt-screen` and `-C, --cd <DIR>` for the interactive CLI. `codex exec --help` confirms `-C, --cd <DIR>` for non-interactive exec mode.

**Step 2: Implement command builder**

The command builder should return executable, args, cwd, and display command:

```ts
interface BuiltCommand {
  executable: string;
  args: string[];
  cwd: string;
  display: string;
}
```

**Step 3: Implement PTY process manager**

The PTY manager should:

- start a Claude terminal
- start a Codex terminal
- write input to a terminal
- resize terminal dimensions
- emit output events
- mark terminal stopped on exit

**Step 4: Add binary validation**

On app startup, check whether `claude` and `codex` are available. Missing binaries should become visible app diagnostics, not crashes.

**Step 5: Run tests**

Run:

```bash
npm test -- command-builder
npm run typecheck
```

Expected: command builder tests pass and TypeScript exits with code 0.

**Step 6: Commit**

```bash
git add src/main/command-builder.ts src/main/pty-manager.ts src/main/command-builder.test.ts
git commit -m "feat: manage Claude and Codex PTYs"
```

## Task 5: Render Embedded Terminals

**Files:**

- Create: `src/renderer/components/TerminalPane.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles.css`

**Step 1: Create TerminalPane**

Use `@xterm/xterm` plus fit addon. Props:

```ts
interface TerminalPaneProps {
  terminalId: string;
  title: string;
  status: TerminalStatus;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}
```

**Step 2: Wire terminal output**

Append main-process terminal output into the matching pane.

**Step 3: Wire terminal input**

Send user keystrokes back through IPC to the matching PTY.

**Step 4: Verify manually**

Run:

```bash
npm run dev
```

Expected:

- app opens
- both terminal panes render
- user can type into a pane
- output appears in the correct pane

**Step 5: Commit**

```bash
git add src/renderer
git commit -m "feat: render embedded terminal panes"
```

## Task 6: Implement Rooms

**Files:**

- Create: `src/main/room-manager.ts`
- Create: `src/renderer/components/RoomSwitcher.tsx`
- Modify: `src/main/main.ts`
- Modify: `src/renderer/App.tsx`

**Step 1: Add room creation flow**

The user should enter:

- room name
- repo path
- optional topic

The repo path must come from a local filesystem picker or manual path entry. Do not add SourceTree support.

**Step 2: Validate repo path**

Reject missing paths or non-directories. Store the error in the UI.
Do not query SourceTree for repository lists or working tree state.

**Step 3: Open room**

Opening a room should:

- create or reuse terminal records
- start Claude PTY
- start Codex PTY
- attach output streams to terminal panes

**Step 4: Verify manually**

Run:

```bash
npm run dev
```

Expected:

- create a room for a real repo
- Claude and Codex terminals launch for the room
- room remains listed after app reload

**Step 5: Commit**

```bash
git add src/main/room-manager.ts src/renderer/components/RoomSwitcher.tsx src/main/main.ts src/renderer/App.tsx
git commit -m "feat: add Hightable rooms"
```

## Task 7: Add Prompt Bar and Manual Sends

**Files:**

- Create: `src/renderer/components/PromptBar.tsx`
- Create: `src/main/orchestration-manager.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `src/main/main.ts`

**Step 1: Create prompt bar UI**

Controls:

- prompt text area
- send to Claude
- send to Codex
- send to both
- mode selector

**Step 2: Implement send action**

For MVP manual sends, write prompt text plus carriage return into the selected PTY.

**Step 3: Record prompt round**

Create a round row for each prompt bar send, even before structured marker parsing exists.

**Step 4: Verify manually**

Run:

```bash
npm run dev
```

Expected:

- prompt can be sent to Claude only
- prompt can be sent to Codex only
- prompt can be sent to both
- round row is created for each send

**Step 5: Commit**

```bash
git add src/renderer/components/PromptBar.tsx src/main/orchestration-manager.ts src/renderer/App.tsx src/main/main.ts
git commit -m "feat: send prompts into terminal rooms"
```

## Task 8: Add Transcript Capture

**Files:**

- Create: `src/main/transcript-capture.ts`
- Modify: `src/main/pty-manager.ts`
- Modify: `src/main/sqlite-store.ts`

**Step 1: Store raw logs**

For each terminal stream, append output to:

```text
~/.heliomodo/hightable/rooms/<room-id>/<agent>.raw.log
```

**Step 2: Store message metadata**

Create message rows that point to raw log paths and include cleaned text where available.

**Step 3: Add ANSI stripping**

Clean output for timeline display. Keep raw logs untouched.

**Step 4: Verify manually**

Run:

```bash
npm run dev
```

Expected:

- terminal output appears in UI
- raw log files are created
- raw log files keep output after app restart

**Step 5: Commit**

```bash
git add src/main/transcript-capture.ts src/main/pty-manager.ts src/main/sqlite-store.ts
git commit -m "feat: capture terminal transcripts"
```

## Task 9: Add Round Timeline

**Files:**

- Create: `src/renderer/components/RoundTimeline.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/main/orchestration-manager.ts`

**Step 1: Render rounds**

Show:

- mode
- prompt preview
- target agents
- status
- started/completed timestamps

**Step 2: Add state updates**

The main process should emit round updates through IPC.

**Step 3: Add manual completion**

Add a button to mark a round complete when marker detection is not available or fails.

**Step 4: Verify manually**

Run:

```bash
npm run dev
```

Expected:

- prompt sends appear in timeline
- status updates render
- manual completion changes round state

**Step 5: Commit**

```bash
git add src/renderer/components/RoundTimeline.tsx src/renderer/App.tsx src/main/orchestration-manager.ts
git commit -m "feat: show prompt round timeline"
```

## Task 10: Add MVP Verification Checklist

**Files:**

- Create: `hightable-Docs/verification.md`
- Modify: `README.md`

**Step 1: Document manual verification**

Include:

- binary detection
- room creation
- Claude terminal launch
- Codex terminal launch
- send to Claude
- send to Codex
- send to both
- log persistence
- app restart and room reload

**Step 2: Link verification from README**

Add the verification doc to the `hightable-Docs` list.

**Step 3: Run final checks**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both commands exit with code 0.

**Step 4: Commit**

```bash
git add hightable-Docs/verification.md README.md
git commit -m "docs: add Hightable verification checklist"
```

## Follow-Up Plan

After the MVP is working, implement these in order:

1. Structured prompt markers and done detection.
2. Compare mode with side-by-side extracted responses.
3. Sequential review mode with primary response and git diff attachment.
4. Discussion mode with bounded rounds.
5. Optional non-interactive resume mode for cleaner JSON output.
6. Git worktree isolation for parallel implementation.
