# Non-interactive tracked runners

**Goal:** Every tracked prompt (everything sent via the prompt bar) spawns a fresh `claude -p` / `codex exec` subprocess instead of being typed into the interactive PTY. Stdout of the subprocess IS the cleaned response — no TUI rendering, no marker tracking, no ANSI stripping needed. Raw logs of the interactive panes stay untouched; the panes remain available for ad-hoc manual typing.

Spec pointer: [mvp-plan.md:179](../mvp-plan.md#L179) ("Deferred Features: Non-interactive resume mode using `claude -p --resume` and `codex exec resume`"). This milestone implements the non-interactive part; `--resume` context threading is a deliberate follow-up.

## Why

Compare/Sequential/Discussion all need a clean primary response as input. Reading it out of a running Ink/Codex TUI means fighting screen redraws, spinner frames, welcome banners, and "[Pasted text #N]" placeholders — a losing battle even with best-effort cleaners. `claude -p` writes the response to stdout and exits. That's the clean signal we need.

## Scope

- Replace the tracked-PTY path in `OrchestrationManager.sendTrackedPrompt`.
- Keep interactive PTYs alive for manual typing.
- Drop marker-based completion (it stays in the codebase as dead code — no listener).
- Keep rate-limit gating and round lifecycle (Submitted → Completed / Needs attn / Failed).
- Preserve the 120s timeout and manual Mark-complete fallback.

Out of scope: streaming stdout to the drawer in real time (post-completion only for MVP), `--resume` context threading, non-interactive runs in Sequential Review or Discussion modes (those come next, building on this).

## Task 1 — Command builder for non-interactive

**Files:** `src/main/command-builder.ts`, `src/main/command-builder.test.ts`.

- Add `buildNonInteractiveCommand({ agent, repoPath, prompt }): BuiltCommand`.
  - Claude: executable `claude`, args `["-p", prompt]`, cwd `repoPath`.
  - Codex: executable `codex`, args `["exec", "-C", repoPath, prompt]`, cwd `repoPath`.
- The command-line prompt length cap isn't a concern (Darwin ARG_MAX is ~262 KB) — argv is fine for typical prompts. Long pastes can be piped via stdin in a later iteration.
- Tests: cover both agents, path-with-space handling, and empty-path rejection.

## Task 2 — NonInteractiveRunner

**Files:** new `src/main/non-interactive-runner.ts`.

- Class or function: `runAgentPrompt({ agent, repoPath, prompt, signal, onStderr? }): Promise<RunResult>`.
- Spawns the built command via `node:child_process.spawn(executable, args, { cwd, env: process.env })`.
- Collects stdout and stderr. Resolves when the child exits with `{ stdout, stderr, exitCode, signal }`.
- Enforces an 8 MB stdout cap; anything larger is truncated with a note.
- Supports `AbortSignal` for orchestration-driven cancellation (timeout or Mark-complete).

## Task 3 — Wire into OrchestrationManager

**Files:** `src/main/orchestration-manager.ts`, `src/main/main.ts`.

- Inject `nonInteractiveRunner` dependency.
- In `sendPrompt`, replace the PTY-write + marker-wait path with: spawn per targeted agent in parallel (compare mode) or one (single target).
- For each target:
  - Create a `messages` row with `direction: "prompt"` at the start (unchanged).
  - Spawn the subprocess.
  - On successful exit: save a `messages` row with `direction: "response"` and the full stdout as `cleanedText`.
  - On non-zero exit: save the stderr (truncated) as the response message's `cleanedText`, prefix it with "[exit code N]".
  - On abort (timeout or manual): save whatever stdout was captured so far.
- When all targets finish: flip round to `completed`.
- If any target aborts via timeout: flip round to `needs_attention`.
- `markRoundComplete` aborts still-running subprocesses, saves partial output, and closes the round.
- Remove the `transcript.onMarker` subscription and the `handleMarker` / `findPendingByMarkerId` helpers (marker-driven completion is no longer active; tests for marker parsing in TranscriptCapture stay green because the module itself is unchanged).

## Task 4 — Keep interactive panes healthy

No code change required. The user still types directly into the Claude / Codex panes; their PTYs are managed by RoomManager unchanged. The new runners spawn fully separate subprocesses that share the user's CLI auth but do not touch the interactive session state.

## Verification (manual, live)

- [ ] Send a Claude-only tracked prompt. The interactive Claude pane stays idle. The timeline row enters `Submitted`, flips to `Completed` once the subprocess exits. The drawer shows the clean response (no spinner frames, no welcome banner).
- [ ] Send a Codex-only tracked prompt. Same lifecycle.
- [ ] Send a Compare prompt. Both subprocesses run in parallel; row completes when the slower one finishes. Drawer shows side-by-side clean outputs.
- [ ] Manually `Mark complete` a running tracked round. The subprocess is killed; whatever stdout had arrived is saved as the response.
- [ ] Force a 120s timeout (e.g. feed an empty prompt that the CLI hangs on). Round flips to `Needs attn`; a subsequent `Mark complete` saves the partial output.
- [ ] Set Claude rate-limited in the topbar. Attempting a tracked Claude send is blocked with the existing UI disable + the main-process error.
- [ ] Type directly into the Claude pane — normal interactive behavior unchanged, no round created.

## Follow-ups

- **Resume threading** via `claude --continue` / `codex exec resume` so tracked rounds in the same room share context.
- **Streaming drawer** — pipe stdout chunks through IPC into the drawer as they arrive, so the user sees progress instead of a silent "Submitted" state for long responses.
- **Sequential Review** and **Discussion** build on the runner: primary prompt → runner → feed cleaned response into a reviewer-prompt template → runner → merge in drawer.
