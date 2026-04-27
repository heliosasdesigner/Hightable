import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type { TranscriptSearchResult } from "../../shared/types";
import { TargetBadges } from "./RoundTimeline";

export interface SearchOverlayProps {
  onClose: () => void;
  onOpenResult: (result: TranscriptSearchResult) => void;
}

const DEBOUNCE_MS = 150;

export function SearchOverlay({ onClose, onOpenResult }: SearchOverlayProps): ReactElement {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TranscriptSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced search. Each query-change kicks off a fresh search after a
  // short delay; earlier in-flight requests' results are discarded.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const next = await window.hightable.searchTranscripts({ query: trimmed });
        if (cancelled) return;
        setResults(next);
        setHighlighted(0);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query]);

  const openIndex = useCallback(
    (idx: number): void => {
      const target = results[idx];
      if (!target) return;
      onOpenResult(target);
    },
    [onOpenResult, results],
  );

  const onKey = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlighted((h) => Math.min(h + 1, Math.max(0, results.length - 1)));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlighted((h) => Math.max(h - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        openIndex(highlighted);
      }
    },
    [highlighted, onClose, openIndex, results.length],
  );

  const needle = query.trim().toLowerCase();

  return (
    <div
      className="dialog-backdrop search-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Search transcripts"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onKey}
      tabIndex={-1}
    >
      <div className="search-panel">
        <input
          ref={inputRef}
          className="search-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search prompts and responses across every room…"
          aria-label="Search query"
        />
        <div className="search-results">
          {error ? (
            <p className="dialog-error">{error}</p>
          ) : !query.trim() ? (
            <p className="timeline-empty">
              Type to search across rounds in every room.
            </p>
          ) : loading ? (
            <p className="timeline-empty">Searching…</p>
          ) : results.length === 0 ? (
            <p className="timeline-empty">No matches.</p>
          ) : (
            results.map((result, idx) => (
              <SearchRow
                key={`${result.roundId}:${result.matchedIn}`}
                result={result}
                needle={needle}
                active={idx === highlighted}
                onClick={() => openIndex(idx)}
                onMouseEnter={() => setHighlighted(idx)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

interface SearchRowProps {
  result: TranscriptSearchResult;
  needle: string;
  active: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}

function SearchRow({
  result,
  needle,
  active,
  onClick,
  onMouseEnter,
}: SearchRowProps): ReactElement {
  const marked = useMemo(() => highlight(result.snippet, needle), [result.snippet, needle]);
  const time = new Date(result.startedAt);
  const when = Number.isNaN(time.getTime())
    ? ""
    : time.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
  return (
    <button
      type="button"
      className={`search-row${active ? " active" : ""}`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
    >
      <div className="search-row-meta">
        <span className="search-row-room">{result.roomName}</span>
        <TargetBadges mode={result.mode} target={result.target} />
        <span className="search-row-source">
          {result.matchedIn === "prompt"
            ? "prompt"
            : `response · ${result.agent === "claude" ? "Claude" : "Codex"}`}
        </span>
        <span className="search-row-time">{when}</span>
      </div>
      <p className="search-row-snippet">{marked}</p>
    </button>
  );
}

function highlight(text: string, needle: string): ReactElement[] {
  if (!needle) return [<span key="0">{text}</span>];
  const out: ReactElement[] = [];
  const lower = text.toLowerCase();
  let cursor = 0;
  let key = 0;
  while (cursor < text.length) {
    const idx = lower.indexOf(needle, cursor);
    if (idx < 0) {
      out.push(<span key={key++}>{text.slice(cursor)}</span>);
      break;
    }
    if (idx > cursor) out.push(<span key={key++}>{text.slice(cursor, idx)}</span>);
    out.push(
      <mark key={key++} className="search-row-mark">
        {text.slice(idx, idx + needle.length)}
      </mark>,
    );
    cursor = idx + needle.length;
  }
  return out;
}
