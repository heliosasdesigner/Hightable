# Hightable UI Wireframes

## Design Intent

Hightable should feel like a focused local workbench: dense enough for engineering work, clear enough to avoid losing track of which CLI is acting, and transparent enough that the user always sees the real Claude and Codex terminals.

The UI must keep the terminals central. Extracted responses, timelines, and orchestration controls are supporting surfaces, not replacements for the terminal sessions.

## Primary Desktop Layout

```text
+------------------------------------------------------------------------------+
| Hightable  Room: [Congneva Router]  Repo: /Users/.../local-development       |
+---------------+--------------------------------------------------------------+
| Rooms         | Prompt                                                       |
|               | +--------------------------------------------------------+   |
| + New Room    | | Ask Claude and Codex...                                |   |
|               | +--------------------------------------------------------+   |
| Recent        | [Claude] [Codex] [Both] [Claude -> Codex*] [Codex -> Claude*]|
| - Congneva    | Mode: [Manual v]  Editing: [Read-only v]  [Send] [Stop]    |
| - AgentHub    +-------------------------------+------------------------------+
| - TradingHub  | Claude Code                   | Codex CLI                    |
|               | status: idle                  | status: busy                 |
|               | +---------------------------+ | +--------------------------+ |
|               | | terminal content          | | | terminal content         | |
|               | |                           | | |                          | |
|               | +---------------------------+ | +--------------------------+ |
|               +-------------------------------+------------------------------+
|               | Round Timeline                                               |
|               | 14:02 compare completed                                      |
|               | 14:10 claude -> codex needs attention                        |
|               +--------------------------------------------------------------+
+------------------------------------------------------------------------------+
```

## Layout Regions

### Top Bar

Purpose: show active context and global controls.

Content:

- app name
- active room name
- active repo path
- Claude binary status
- Codex binary status
- settings button

Behavior:

- repo path should truncate from the middle
- binary errors should be visible but not modal
- room name should be editable later, but static in MVP

### Room Sidebar

Purpose: switch between persistent work contexts.

Content:

- new room button
- recent room list
- room status indicators
- optional filter/search in a later milestone

Room row states:

```text
idle
busy
needs_attention
stopped
```

The sidebar should be collapsible after MVP, but visible by default.

### Prompt Bar

Purpose: compose a single prompt and choose how it routes.

Controls:

- multiline prompt field
- mode selector
- target buttons
- editing policy selector
- send button
- stop orchestration button

Target buttons:

```text
Claude
Codex
Both
Claude -> Codex (disabled until sequential review ships)
Codex -> Claude (disabled until sequential review ships)
Discuss (disabled until discussion mode ships)
```

Modes:

```text
Manual
Compare
Sequential Review
Discussion
```

Editing policies:

```text
Read-only
Primary may edit
Separate worktrees
```

MVP-live controls are `Claude`, `Codex`, and `Both` in manual routing. Sequential and discussion controls should render disabled or hidden until their milestones ship.

### Terminal Grid

Purpose: keep both real terminal sessions visible.

Each terminal panel includes:

- agent name
- status badge
- command display
- restart button
- mark complete button when busy
- terminal viewport

Panel states:

```text
Idle: normal border
Busy: accent border and spinner/indicator
Needs attention: warning border
Failed/stopped: muted panel with restart action
```

The terminal pane must not resize when status changes. Header height and action button sizes should be fixed.

Initial PTY dimensions should be `120x32`. After mount and on resize, the terminal pane should use the fit addon to compute visible rows and columns and send those dimensions to the main process.

### Round Timeline

Purpose: show what Hightable orchestrated, separate from raw terminal scrollback.

Each timeline item:

```text
time
mode
target agents
status
prompt preview
open extracted response
open raw log
open artifacts
```

Timeline states:

```text
queued
running
needs_attention
completed
failed
```

Clicking a round opens a detail drawer.

## Round Detail Drawer

```text
+----------------------------------------------+
| Round Detail                                 |
+----------------------------------------------+
| Mode: Compare                                |
| Status: Completed                            |
| Started: 2026-04-18 14:02                    |
| Completed: 2026-04-18 14:06                  |
+----------------------------------------------+
| Prompt                                       |
| ...                                          |
+-----------------------+----------------------+
| Claude Response       | Codex Response       |
| ...                   | ...                  |
+-----------------------+----------------------+
| Artifacts: raw logs, cleaned text, git diff  |
+----------------------------------------------+
```

For sequential review, the drawer should show:

```text
Primary response
Reviewer response
Git diff artifact if collected
Next action notes
```

For discussion, the drawer should show turns by round:

```text
Round 1 Claude
Round 1 Codex
Round 2 Claude response to Codex
Round 2 Codex response to Claude
Final synthesis
```

## New Room Flow

```text
+----------------------------------------------+
| New Room                                     |
+----------------------------------------------+
| Name                                         |
| [ Congneva Router Review                  ]  |
| Repo Path                                    |
| [ /Users/heliosslso/Heliomodo/...   ][Pick]  |
| Topic optional                               |
| [ Review router and onboarding flow       ]  |
|                                              |
| [Cancel]                         [Create]    |
+----------------------------------------------+
```

Validation:

- repo path is required
- repo path must exist
- repo path must be a directory
- repo path is selected from the local filesystem or entered manually
- SourceTree import/sync/discovery is not supported
- missing Claude/Codex binaries should warn but not block room creation

## Empty State

Before a room exists:

```text
+----------------------------------------------+
| Heliomodo Hightable                          |
|                                              |
| Create a room to attach Claude Code and      |
| Codex CLI terminals to a repository.         |
|                                              |
| [New Room]                                   |
+----------------------------------------------+
```

Do not use marketing-style hero content. This is a tool; the first screen should get the user into a room.

## Responsive Behavior

Desktop wide:

```text
sidebar | prompt + two terminal columns + timeline
```

Narrow desktop:

```text
sidebar collapsed | prompt + terminal tabs + timeline
```

Minimum useful width:

```text
topbar
prompt
segmented control: Claude | Codex | Timeline
active terminal
```

Hightable is not optimized for phone use. If opened below the minimum practical width, show a compact single-column operator view rather than trying to preserve two terminal panes.

## Interaction Rules

- The user can always type manually into an idle or busy terminal.
- When an automated round is busy, sending another automated prompt to that terminal should be blocked.
- Manual typing during an automated round should mark that terminal as "manual intervention detected" for the round.
- Stop orchestration should stop Hightable's wait state, not kill the CLI process by default.
- Restart terminal should require confirmation when the terminal is busy.
- Mark complete should be available when marker detection fails.

## Visual Style

Hightable uses the **Aurora Glass** design system from Atlas-Dock (`Atlas-Dock-Docs/10-design-system.md`), adapted for a terminal workbench.

Adopted from Aurora Glass:

- single frosted glass shell (97vw × 97vh) is the only element with `backdrop-filter`
- animated background: five orbs, four hairline rings, three glow dots, grain overlay, atmospheric gradient
- colorless neutral text scale (`--text-primary` / `--text-secondary` / `--text-tertiary`)
- accent color is reserved for interactive affordances (focus ring, selected chip, primary button glow, agent status dot) — never for text
- Playfair Display italic for room titles; DM Sans for all UI text; monospace inside terminal canvas
- pill-shaped segmented controls for prompt targets; pill primary button
- MVP ships the Aurora dark palette. Palette system (Aurora, Ocean, Cosmos, Sunset, etc.) carries over for later milestones.

Hightable-specific adaptations:

- **Terminal canvas exception.** Terminal viewports (`.terminal-canvas`) use an opaque solid surface inside each panel. xterm needs a legible background and cannot render cleanly on frosted glass. This is the one permitted inner fill; all other inner elements stay `background: transparent`.
- **ANSI colors live inside the terminal.** The colorless-text rule applies to chrome only. Terminal output renders with the CLI's own ANSI palette unchanged.
- **Agent accents.** Claude panel uses warm amber (`#D96C15`, orb 5). Codex panel uses cyan-blue (`#0D9BE0`, Ocean accent). Shown as agent status dots and glows only — not as text color.
- **Density over cinema.** Shell radius stays at 40px, but inner components (48px topbar, compact prompt bar, timeline rows) keep the workbench dense. The aurora backdrop is ambient, not central.
- **Reduced motion.** All background animations disable under `prefers-reduced-motion: reduce`. Orbs remain as static gradients at 50% opacity.

Avoid:

- nesting glass surfaces (no `backdrop-filter` inside the shell)
- accent-colored text
- marketing-style hero layouts
- card-inside-card nesting
- layout that shifts on status change (status badges swap color, not size)

Use fixed-height controls, stable terminal panes, pill-shaped segmented controls, and compact status pills.

## Keyboard Shortcuts

MVP shortcuts:

```text
Cmd+Enter: send prompt using selected route
Cmd+1: focus Claude terminal
Cmd+2: focus Codex terminal
Cmd+3: focus prompt
Esc: close drawer or modal
```

Deferred shortcuts:

```text
Cmd+Shift+C: send to Claude
Cmd+Shift+X: send to Codex
Cmd+Shift+B: send to both
Cmd+Shift+S: stop orchestration wait
```

## MVP Screen Checklist

- [ ] Empty state creates a room.
- [ ] Room sidebar lists created rooms.
- [ ] Active repo path is visible.
- [ ] Prompt bar can target Claude, Codex, or both.
- [ ] Claude terminal renders in a stable pane.
- [ ] Codex terminal renders in a stable pane.
- [ ] Terminal status is visible.
- [ ] Round timeline records prompt sends.
- [ ] A round detail drawer can show prompt and captured output.
- [ ] Busy state prevents duplicate automated sends.
