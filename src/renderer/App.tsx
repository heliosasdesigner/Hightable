import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TerminalPane } from "./components/TerminalPane";
import { RoomSwitcher } from "./components/RoomSwitcher";
import { NewRoomDialog } from "./components/NewRoomDialog";
import { PromptBar, type PromptBarPrefill } from "./components/PromptBar";
import { RoundTimeline } from "./components/RoundTimeline";
import {
  RoundDetailDrawer,
  type ChainFollowUp,
  type ContinueDiscussion,
} from "./components/RoundDetailDrawer";
import { AgentUsageBar } from "./components/AgentUsageBar";
import { SearchOverlay } from "./components/SearchOverlay";
import { SettingsDialog, type ThemeMode } from "./components/SettingsDialog";
import type {
  AgentId,
  AgentUsageStats,
  HightableRoom,
  HightableTerminal,
  PromptRound,
  PromptTarget,
  RoundMode,
  RoundProgressEvent,
} from "../shared/types";
import { cleanAgentResponse, collapseEmbeddedContext } from "../shared/text-cleanup";

const LAST_ROOM_KEY = "hightable.lastRoomId";
const THEME_KEY = "hightable.theme";
const TIMELINE_OPEN_KEY = "hightable.timelineOpen";

function readTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "dark" || v === "light") return v;
  } catch {
    /* storage unavailable */
  }
  // Neo-brutalism is a dark-first system; default to dark regardless of OS
  // preference. Users can switch via Settings.
  return "dark";
}

function saveTheme(theme: ThemeMode): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage unavailable */
  }
}

function readTimelineOpen(defaultValue: boolean): boolean {
  try {
    const v = localStorage.getItem(TIMELINE_OPEN_KEY);
    if (v === "true") return true;
    if (v === "false") return false;
  } catch {
    /* storage unavailable */
  }
  return defaultValue;
}

function saveTimelineOpen(open: boolean): void {
  try {
    localStorage.setItem(TIMELINE_OPEN_KEY, String(open));
  } catch {
    /* storage unavailable */
  }
}

function saveLastRoom(roomId: string | null): void {
  try {
    if (roomId) localStorage.setItem(LAST_ROOM_KEY, roomId);
    else localStorage.removeItem(LAST_ROOM_KEY);
  } catch {
    /* storage unavailable */
  }
}

function readLastRoom(): string | null {
  try {
    return localStorage.getItem(LAST_ROOM_KEY);
  } catch {
    return null;
  }
}

/**
 * Continuation prompt text. Explicit about "this session" so Claude Code's
 * memory/file heuristics don't kick in and send it searching for external
 * context. Embeds the most recent substantive reply to give the agent a
 * concrete anchor — nested `<last_response>` / `<primary_response>` blocks
 * from earlier continuations are collapsed so the text doesn't grow
 * quadratically, and the resulting block is cleaned of TUI noise.
 */
function composeContinuationPrompt(lastResponse: string): string {
  const cleaned = cleanAgentResponse(collapseEmbeddedContext(lastResponse)).trim();
  const cap = 2_500;
  // Prefer the tail — most actionable content is at the end of the response.
  const preview = cleaned.length > cap ? "…[earlier omitted]\n" + cleaned.slice(-cap) : cleaned;
  const header =
    "Continue the conversation we just had in this session. The context you need is in your own prior messages in this same CLI session — do NOT look for external files, memory directories, or stored notes.";
  const recap = preview
    ? `\n\nMost recent exchange (for reminder only — do not re-embed in your reply):\n\n<last_response>\n${preview}\n</last_response>`
    : "";
  const footer =
    "\n\nPick up from the last exchange, address any points still unresolved, and move toward the end goal. Do not restart from scratch.";
  return header + recap + footer;
}

interface ActiveSession {
  room: HightableRoom;
  terminals: HightableTerminal[];
  rounds: PromptRound[];
}

function terminalFor(session: ActiveSession, agent: "claude" | "codex"): HightableTerminal | undefined {
  return session.terminals.find((t) => t.agent === agent);
}

export function App() {
  const [timelineOpen, setTimelineOpenState] = useState(() => readTimelineOpen(true));
  const [theme, setThemeState] = useState<ThemeMode>(() => readTheme());

  const [rooms, setRooms] = useState<HightableRoom[]>([]);
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedRoundId, setSelectedRoundId] = useState<string | null>(null);
  const [usage, setUsage] = useState<AgentUsageStats[]>([]);
  const [prefill, setPrefill] = useState<PromptBarPrefill | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const openRoomToken = useRef(0);

  // Apply the theme to <html> so CSS vars cascade to everything, and persist.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    saveTheme(theme);
  }, [theme]);

  const setTimelineOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)): void => {
      setTimelineOpenState((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        saveTimelineOpen(resolved);
        return resolved;
      });
    },
    [],
  );

  const refreshRooms = useCallback(async (): Promise<HightableRoom[]> => {
    const list = await window.hightable.listRooms();
    setRooms(list);
    return list;
  }, []);

  const openRoom = useCallback(async (roomId: string): Promise<void> => {
    // Guard against fast room-switches: if a newer openRoom call has started
    // before this one resolves, discard the stale result.
    const token = ++openRoomToken.current;
    try {
      const result = await window.hightable.openRoom({ roomId });
      if (token !== openRoomToken.current) return;
      setSession({ room: result.room, terminals: result.terminals, rounds: result.rounds });
      saveLastRoom(result.room.id);
      setLoadError(null);
      setSelectedRoundId(null);
      await refreshRooms();
    } catch (err) {
      if (token !== openRoomToken.current) return;
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [refreshRooms]);

  useEffect(() => {
    let cancelled = false;
    async function boot(): Promise<void> {
      try {
        const list = await refreshRooms();
        if (cancelled) return;
        const preferred = readLastRoom();
        const candidate = (preferred && list.find((r) => r.id === preferred)) ?? list[0];
        if (candidate) await openRoom(candidate.id);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, [openRoom, refreshRooms]);

  useEffect(() => {
    const unsubscribe = window.hightable.onRoundUpdated((event) => {
      setSession((current) => {
        if (!current || event.round.roomId !== current.room.id) return current;
        const existing = current.rounds.findIndex((r) => r.id === event.round.id);
        const nextRounds =
          existing >= 0
            ? current.rounds.map((r) => (r.id === event.round.id ? event.round : r))
            : [event.round, ...current.rounds];
        // Clear progress for rounds that just left `running`.
        if (event.round.status !== "running") {
          setRoundProgress((prev) => {
            if (!prev.has(event.round.id)) return prev;
            const next = new Map(prev);
            next.delete(event.round.id);
            return next;
          });
        }
        return { ...current, rounds: nextRounds };
      });
    });
    return unsubscribe;
  }, []);

  // Per-turn liveness events for running discussion rounds — drives the
  // "Turn N · waiting for X · 42s" readout on the timeline row.
  const [roundProgress, setRoundProgress] = useState<Map<string, RoundProgressEvent>>(
    () => new Map(),
  );
  useEffect(() => {
    const unsubscribe = window.hightable.onRoundProgress((event) => {
      setRoundProgress((prev) => {
        const next = new Map(prev);
        next.set(event.roundId, event);
        return next;
      });
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.hightable.getAgentUsage().then((next) => {
      if (!cancelled) setUsage(next);
    });
    const unsubscribe = window.hightable.onAgentUsageUpdated((event) => {
      setUsage(event.usage);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const setAgentRateLimit = useCallback(
    async (input: { agent: AgentId; limitedUntil: string; note?: string }): Promise<void> => {
      await window.hightable.setAgentRateLimit(input);
    },
    [],
  );

  const clearAgentRateLimit = useCallback(async (agent: AgentId): Promise<void> => {
    await window.hightable.clearAgentRateLimit({ agent });
  }, []);

  // Cmd+K / Ctrl+K toggles search. Ignored while a text input / textarea
  // already owns focus so users can still type literal "K".
  useEffect(() => {
    function handleKey(event: KeyboardEvent): void {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      setSearchOpen((open) => !open);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const jumpToRound = useCallback(
    async (roomId: string, roundId: string): Promise<void> => {
      if (session?.room.id !== roomId) {
        await openRoom(roomId);
      }
      setSelectedRoundId(roundId);
      setTimelineOpen(true);
      setSearchOpen(false);
    },
    [session?.room.id, openRoom],
  );

  const continueDiscussion = useCallback(
    async (round: PromptRound | { id: string; target: PromptTarget; endGoal?: string }): Promise<void> => {
      if (!session) return;
      const target = round.target === "codex_to_claude" ? "codex_to_claude" : "claude_to_codex";
      // Pull the last response from this round and inline it as context so the
      // primary agent can anchor on concrete text — without this, it tends to
      // interpret "previous discussion" as external memory/files and look in
      // the wrong place.
      let lastResponse = "";
      try {
        const detail = await window.hightable.getRound({ roundId: round.id });
        const responses = detail.messages.filter((m) => m.direction === "response");
        lastResponse = responses[responses.length - 1]?.cleanedText?.trim() ?? "";
      } catch (err) {
        console.warn("[hightable] continueDiscussion: getRound failed", err);
      }
      const prompt = composeContinuationPrompt(lastResponse);
      await window.hightable.sendPrompt({
        roomId: session.room.id,
        mode: "discussion",
        target,
        prompt,
        sequentialTurns: 1,
        endGoal: round.endGoal,
      });
    },
    [session],
  );

  // Latest non-running Discussion round in this room — drives the Continue
  // button that lives in the prompt bar.
  const latestDiscussion = useMemo(() => {
    const rounds = session?.rounds ?? [];
    return (
      rounds.find(
        (r) =>
          r.mode === "discussion" &&
          (r.target === "claude_to_codex" || r.target === "codex_to_claude") &&
          r.status !== "running",
      ) ?? null
    );
  }, [session?.rounds]);

  // Currently running discussion round (if any) — drives the Pause / Kill
  // buttons. Only directional discussion rounds qualify (parallel sends are
  // one-shot and nothing to "stop").
  const runningDiscussion = useMemo(() => {
    const rounds = session?.rounds ?? [];
    return (
      rounds.find(
        (r) =>
          r.mode === "discussion" &&
          (r.target === "claude_to_codex" || r.target === "codex_to_claude") &&
          r.status === "running",
      ) ?? null
    );
  }, [session?.rounds]);

  const limitedAgents: Record<AgentId, string | undefined> = useMemo(() => {
    const now = Date.now();
    const map: Record<AgentId, string | undefined> = { claude: undefined, codex: undefined };
    for (const entry of usage) {
      if (entry.limitedUntil && new Date(entry.limitedUntil).getTime() > now) {
        map[entry.agent] = entry.limitedUntil;
      }
    }
    return map;
  }, [usage]);

  const sendPrompt = useCallback(
    async (input: {
      prompt: string;
      target: PromptTarget;
      mode: RoundMode;
      sequentialTurns?: number;
      endGoal?: string;
    }): Promise<void> => {
      if (!session) return;
      await window.hightable.sendPrompt({
        roomId: session.room.id,
        prompt: input.prompt,
        target: input.target,
        mode: input.mode,
        sequentialTurns: input.sequentialTurns,
        endGoal: input.endGoal,
      });
    },
    [session],
  );

  const markComplete = useCallback(async (roundId: string): Promise<void> => {
    try {
      await window.hightable.markRoundComplete({ roundId });
    } catch (err) {
      console.error("markRoundComplete", err);
    }
  }, []);

  const pauseRound = useCallback(async (roundId: string): Promise<void> => {
    try {
      await window.hightable.pauseRound({ roundId });
    } catch (err) {
      console.error("pauseRound", err);
    }
  }, []);

  const restartTerminal = useCallback(
    async (terminalId: string, resume: boolean): Promise<void> => {
      try {
        const fresh = await window.hightable.restartTerminal({ terminalId, resume });
        setSession((current) => {
          if (!current) return current;
          const others = current.terminals.filter((t) => t.agent !== fresh.agent);
          return { ...current, terminals: [...others, fresh] };
        });
      } catch (err) {
        console.error("restartTerminal", err);
      }
    },
    [],
  );

  const clearAllRateLimits = useCallback(async (): Promise<void> => {
    await Promise.all([
      window.hightable.clearAgentRateLimit({ agent: "claude" }),
      window.hightable.clearAgentRateLimit({ agent: "codex" }),
    ]);
  }, []);

  const resetDatabase = useCallback(async (): Promise<void> => {
    await window.hightable.resetDatabase();
    // Wipe local view of sessions/rounds; the backend has already killed
    // PTYs and cleared rows so there's nothing to re-render.
    openRoomToken.current += 1;
    setSession(null);
    setRooms([]);
    setSelectedRoundId(null);
    setPrefill(null);
    try {
      localStorage.removeItem(LAST_ROOM_KEY);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const toggleRoomResume = useCallback(async (): Promise<void> => {
    if (!session) return;
    try {
      const updated = await window.hightable.setRoomResumePolicy({
        roomId: session.room.id,
        resumeOnOpen: !session.room.resumeOnOpen,
      });
      setSession((current) => (current ? { ...current, room: updated } : current));
    } catch (err) {
      console.error("setRoomResumePolicy", err);
    }
  }, [session]);

  const claudeTerminal = session ? terminalFor(session, "claude") : undefined;
  const codexTerminal = session ? terminalFor(session, "codex") : undefined;

  return (
    <>
      <div className="viewport">
        <div className={`shell${timelineOpen ? " timeline-open" : ""}`}>
          <RoomSwitcher
            rooms={rooms}
            activeRoomId={session?.room.id ?? null}
            onSelect={(id) => void openRoom(id)}
            onNewRoom={() => setDialogOpen(true)}
          />

          <section className="workspace">
            <header className="hs-topbar">
              <div className="room-context">
                <h2 className="room-title">{session?.room.name ?? "Hightable"}</h2>
                <button
                  type="button"
                  className="settings-trigger"
                  onClick={() => setSettingsOpen(true)}
                  title="Settings"
                  aria-label="Open settings"
                >
                  <svg
                    viewBox="0 0 20 20"
                    width="16"
                    height="16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="10" cy="10" r="2.5" />
                    <path d="M10 1.5v3M10 15.5v3M1.5 10h3M15.5 10h3M4.1 4.1l2.1 2.1M13.8 13.8l2.1 2.1M15.9 4.1l-2.1 2.1M6.2 13.8l-2.1 2.1" />
                  </svg>
                </button>
              </div>
              <div className="repo-path" title={session?.room.repoPath ?? ""}>
                {session?.room.repoPath ?? "No room opened"}
              </div>
              <AgentUsageBar
                usage={usage}
                onSetLimit={setAgentRateLimit}
                onClearLimit={clearAgentRateLimit}
              />
              {session ? (
                <button
                  type="button"
                  className={`topbar-resume-toggle${session.room.resumeOnOpen ? " active" : ""}`}
                  onClick={() => void toggleRoomResume()}
                  title={
                    session.room.resumeOnOpen
                      ? "Resume-on-open is ON — new PTYs spawn with the CLI's resume flag. Click to turn off."
                      : "Resume-on-open is OFF — new PTYs start fresh sessions. Click to turn on."
                  }
                  aria-pressed={session.room.resumeOnOpen}
                >
                  {session.room.resumeOnOpen ? "↺ Resume on" : "↺ Resume off"}
                </button>
              ) : null}
              <button
                type="button"
                className="topbar-search-trigger"
                onClick={() => setSearchOpen(true)}
                title="Search across all rounds (⌘K)"
              >
                ⌘K
              </button>
              <button
                type="button"
                className={`icon-btn timeline-toggle${timelineOpen ? " open" : ""}`}
                aria-label={timelineOpen ? "Hide sidecar" : "Show sidecar"}
                aria-pressed={timelineOpen}
                title={timelineOpen ? "Hide sidecar" : "Show sidecar"}
                onClick={() => setTimelineOpen((v) => !v)}
              >
                <svg
                  viewBox="0 0 16 16"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <rect x="1.75" y="2.5" width="12.5" height="11" rx="1.5" />
                  <line x1="10.5" y1="2.5" x2="10.5" y2="13.5" />
                </svg>
              </button>
            </header>

            {session ? (
              <section className="terminal-grid" aria-label="Terminals">
                <TerminalPanel
                  title="Claude Code"
                  agentClass="claude-panel"
                  terminal={claudeTerminal}
                  onRestart={(resume) =>
                    claudeTerminal ? void restartTerminal(claudeTerminal.id, resume) : undefined
                  }
                />
                <TerminalPanel
                  title="Codex CLI"
                  agentClass="codex-panel"
                  terminal={codexTerminal}
                  onRestart={(resume) =>
                    codexTerminal ? void restartTerminal(codexTerminal.id, resume) : undefined
                  }
                />
              </section>
            ) : (
              <section className="terminal-grid empty-room" aria-label="Empty state">
                <div className="empty-room-inner">
                  <h3>Create a room to attach Claude Code and Codex CLI terminals to a repository.</h3>
                  {loadError ? <p className="dialog-error">{loadError}</p> : null}
                  <button type="button" className="btn-primary" onClick={() => setDialogOpen(true)}>
                    New Room
                  </button>
                </div>
              </section>
            )}

            <PromptBar
              disabled={!session}
              limitedAgents={limitedAgents}
              prefill={prefill}
              latestDiscussion={latestDiscussion}
              runningDiscussion={runningDiscussion}
              onSend={sendPrompt}
              onContinueDiscussion={(round) => continueDiscussion(round)}
              onPauseRound={(id) => void pauseRound(id)}
              onKillRound={(id) => void markComplete(id)}
            />
          </section>

          {timelineOpen ? (
            selectedRoundId ? (
              <RoundDetailDrawer
                roundId={selectedRoundId}
                onClose={() => setSelectedRoundId(null)}
                onMarkComplete={(id) => void markComplete(id)}
                onChainFollowUp={(follow: ChainFollowUp) => {
                  setPrefill({
                    token: Date.now(),
                    prompt: follow.prompt,
                    target: follow.target,
                    mode: "manual",
                  });
                  setSelectedRoundId(null);
                }}
                onContinueDiscussion={(input: ContinueDiscussion) => {
                  void continueDiscussion({
                    id: selectedRoundId,
                    target: input.target,
                    endGoal: input.endGoal,
                  });
                  setSelectedRoundId(null);
                }}
              />
            ) : (
              <RoundTimeline
                rounds={session?.rounds ?? []}
                progress={roundProgress}
                onMarkComplete={(id) => void markComplete(id)}
                onOpenRound={(id) => setSelectedRoundId(id)}
                onContinueDiscussion={(round) => void continueDiscussion(round)}
                onClose={() => setTimelineOpen(false)}
              />
            )
          ) : null}
        </div>
      </div>

      {dialogOpen ? (
        <NewRoomDialog
          onClose={() => setDialogOpen(false)}
          onCreated={async (room) => {
            setDialogOpen(false);
            await refreshRooms();
            await openRoom(room.id);
          }}
        />
      ) : null}

      {searchOpen ? (
        <SearchOverlay
          onClose={() => setSearchOpen(false)}
          onOpenResult={(result) => void jumpToRound(result.roomId, result.roundId)}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsDialog
          theme={theme}
          timelineOpenOnStartup={timelineOpen}
          onThemeChange={setThemeState}
          onTimelineStartupChange={setTimelineOpen}
          onClearRateLimits={clearAllRateLimits}
          onResetDatabase={resetDatabase}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </>
  );
}

function TerminalPanel({
  title,
  agentClass,
  terminal,
  onRestart,
}: {
  title: string;
  agentClass: string;
  terminal: HightableTerminal | undefined;
  onRestart?: (resume: boolean) => void;
}) {
  return (
    <article className={`terminal-panel ${agentClass}`}>
      <header>
        <div className="terminal-ident">
          <span className="agent-dot" aria-hidden="true" />
          <h3>{title}</h3>
          <span className={`status-pill ${terminal?.status ?? "idle"}`}>
            {terminal?.status ?? "starting"}
          </span>
        </div>
        <div className="terminal-panel-actions">
          <button
            type="button"
            className="icon-btn"
            aria-label="Resume last session"
            title="Kill this terminal and restart with the CLI's resume flag — picks up the last session on disk."
            onClick={() => onRestart?.(true)}
            disabled={!terminal || !onRestart}
          >
            ↺
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Restart terminal fresh"
            title="Kill this terminal and restart with a fresh session."
            onClick={() => onRestart?.(false)}
            disabled={!terminal || !onRestart}
          >
            ↻
          </button>
        </div>
      </header>
      {terminal ? (
        <TerminalPane
          terminalId={terminal.id}
          agent={terminal.agent}
          title={title}
          status={terminal.status}
        />
      ) : (
        <div className="terminal-canvas">Starting terminal…</div>
      )}
    </article>
  );
}
