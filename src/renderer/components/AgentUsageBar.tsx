import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { AgentId, AgentUsageStats } from "../../shared/types";

export interface AgentUsageBarProps {
  usage: AgentUsageStats[];
  onSetLimit: (input: { agent: AgentId; limitedUntil: string; note?: string }) => Promise<void> | void;
  onClearLimit: (agent: AgentId) => Promise<void> | void;
}

const AGENT_ORDER: AgentId[] = ["claude", "codex"];
const AGENT_LABEL: Record<AgentId, string> = { claude: "Claude", codex: "Codex" };

export function AgentUsageBar({
  usage,
  onSetLimit,
  onClearLimit,
}: AgentUsageBarProps): ReactElement {
  const [openAgent, setOpenAgent] = useState<AgentId | null>(null);
  const now = useMinuteTick();

  const byAgent = useMemo(() => {
    const map = new Map<AgentId, AgentUsageStats>();
    for (const entry of usage) map.set(entry.agent, entry);
    return map;
  }, [usage]);

  return (
    <div className="agent-usage-bar">
      {AGENT_ORDER.map((agent) => {
        const stats = byAgent.get(agent);
        const limited = stats?.limitedUntil && new Date(stats.limitedUntil).getTime() > now;
        const countdown =
          limited && stats?.limitedUntil ? formatCountdown(stats.limitedUntil, now) : null;
        return (
          <div key={agent} className={`agent-usage-slot ${agent}`}>
            <button
              type="button"
              className={`agent-usage-pill${limited ? " limited" : ""}${
                openAgent === agent ? " open" : ""
              }`}
              onClick={() => setOpenAgent((cur) => (cur === agent ? null : agent))}
              aria-haspopup="menu"
              aria-expanded={openAgent === agent}
            >
              <span className="agent-usage-dot" aria-hidden="true" />
              <span className="agent-usage-label">{AGENT_LABEL[agent]}</span>
              <span className="agent-usage-count">{stats?.today ?? 0}</span>
              {countdown ? <span className="agent-usage-countdown">⏸ {countdown}</span> : null}
            </button>
            {openAgent === agent ? (
              <UsagePopover
                stats={stats ?? emptyStats(agent)}
                now={now}
                onClose={() => setOpenAgent(null)}
                onSetLimit={async (input) => {
                  await onSetLimit(input);
                  setOpenAgent(null);
                }}
                onClearLimit={async () => {
                  await onClearLimit(agent);
                  setOpenAgent(null);
                }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function emptyStats(agent: AgentId): AgentUsageStats {
  return { agent, today: 0, week: 0 };
}

interface UsagePopoverProps {
  stats: AgentUsageStats;
  now: number;
  onClose: () => void;
  onSetLimit: (input: { agent: AgentId; limitedUntil: string; note?: string }) => Promise<void> | void;
  onClearLimit: () => Promise<void> | void;
}

function UsagePopover({
  stats,
  now,
  onClose,
  onSetLimit,
  onClearLimit,
}: UsagePopoverProps): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const [customValue, setCustomValue] = useState<string>(defaultCustomValue);
  const limited = stats.limitedUntil && new Date(stats.limitedUntil).getTime() > now;

  useEffect(() => {
    function handleDocClick(event: MouseEvent): void {
      if (!ref.current || event.target instanceof Node === false) return;
      if (!ref.current.contains(event.target as Node)) onClose();
    }
    function handleKey(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleDocClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleDocClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  function submitPreset(kind: "m15" | "h1" | "h4" | "tomorrow9"): void {
    const when = computePresetTime(kind);
    void onSetLimit({ agent: stats.agent, limitedUntil: when });
  }

  function submitCustom(): void {
    if (!customValue) return;
    const parsed = new Date(customValue);
    if (Number.isNaN(parsed.getTime())) return;
    void onSetLimit({ agent: stats.agent, limitedUntil: parsed.toISOString() });
  }

  return (
    <div ref={ref} className="agent-usage-popover" role="menu">
      <header className="agent-usage-popover-header">
        <div>
          <p className="agent-usage-popover-title">{AGENT_LABEL[stats.agent]} usage</p>
          <p className="agent-usage-popover-sub">
            Today {stats.today} · This week {stats.week}
          </p>
        </div>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>

      {limited ? (
        <section className="agent-usage-popover-limit active">
          <p className="round-drawer-label">Rate-limited</p>
          <p className="agent-usage-popover-limit-time">
            Until {formatAbsolute(stats.limitedUntil!)} ({formatCountdown(stats.limitedUntil!, now)}{" "}
            remaining)
          </p>
          {stats.note ? <p className="agent-usage-popover-note">{stats.note}</p> : null}
          <button type="button" className="btn-ghost" onClick={() => void onClearLimit()}>
            Clear limit
          </button>
        </section>
      ) : (
        <section className="agent-usage-popover-limit">
          <p className="round-drawer-label">Mark rate-limited until…</p>
          <div className="agent-usage-preset-row">
            <button type="button" className="btn-ghost" onClick={() => submitPreset("m15")}>
              +15 min
            </button>
            <button type="button" className="btn-ghost" onClick={() => submitPreset("h1")}>
              +1 hr
            </button>
            <button type="button" className="btn-ghost" onClick={() => submitPreset("h4")}>
              +4 hr
            </button>
            <button type="button" className="btn-ghost" onClick={() => submitPreset("tomorrow9")}>
              Tomorrow 9 am
            </button>
          </div>
          <div className="agent-usage-custom-row">
            <input
              type="datetime-local"
              value={customValue}
              onChange={(e) => setCustomValue(e.target.value)}
            />
            <button type="button" className="btn-primary" onClick={submitCustom}>
              Set
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function computePresetTime(kind: "m15" | "h1" | "h4" | "tomorrow9"): string {
  const now = new Date();
  if (kind === "m15") now.setMinutes(now.getMinutes() + 15);
  else if (kind === "h1") now.setHours(now.getHours() + 1);
  else if (kind === "h4") now.setHours(now.getHours() + 4);
  else {
    now.setDate(now.getDate() + 1);
    now.setHours(9, 0, 0, 0);
  }
  return now.toISOString();
}

function defaultCustomValue(): string {
  const d = new Date();
  d.setHours(d.getHours() + 1);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

function formatCountdown(iso: string, nowMs: number): string {
  const deltaMs = new Date(iso).getTime() - nowMs;
  if (deltaMs <= 0) return "0m";
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return `${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}
