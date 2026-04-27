import { EventEmitter } from "node:events";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";
import type { AgentId, HightableTerminal, Unsubscribe } from "../shared/types.js";
import { stripAnsi } from "./ansi.js";
import { detectRateLimit } from "./rate-limit-patterns.js";

const MAX_CLEAN_BUFFER = 128 * 1024;
// Require the marker to be alone on its line (only whitespace around it) to
// avoid false positives when the prompt's own instruction line is echoed by
// the CLI. Line boundaries accept either CR or LF — Claude Code's output uses
// `\r\r\n` line endings, so a `\n`-only boundary check misses its markers.
// The marker-id portion allows embedded whitespace (including newlines) so
// that a narrow TUI that wraps the marker mid-id still matches. The captured
// id is stripped of whitespace before being emitted.
const MARKER_PATTERN =
  /(?:^|[\r\n])[ \t]*\[HM_RUN_(BEGIN|DONE):([0-9a-fA-F][0-9a-fA-F\-\s]*?)\][ \t]*(?=[\r\n]|$)/g;

export interface TranscriptCaptureInput {
  roomsDir: string;
}

export interface MarkerEvent {
  terminalId: string;
  agent: AgentId;
  kind: "begin" | "done";
  markerId: string;
  /** Index into the cleaned buffer at which the marker starts. */
  bufferOffset: number;
}

export interface RateLimitEvent {
  terminalId: string;
  agent: AgentId;
  until: Date;
  note: string;
  match: string;
}

const RATE_LIMIT_DEDUPE_MS = 60_000;

interface TerminalStreamEntry {
  stream: WriteStream;
  rawLogPath: string;
  roomId: string;
  agent: AgentId;
  cleaned: string;
  /** Running offset — grows monotonically even as `cleaned` is trimmed. */
  absoluteOffset: number;
  /** Last ms epoch at which a rate-limit was auto-emitted, for dedupe. */
  lastRateLimitAt: number;
}

/**
 * Appends raw PTY output to per-room log files, keeps a bounded cleaned
 * buffer per terminal, and emits marker events when `[HM_RUN_BEGIN:<id>]`
 * or `[HM_RUN_DONE:<id>]` appears in the cleaned stream.
 *
 * Offsets returned from `snapshotOffset` are absolute — they remain valid
 * for slicing via `getCleanedSlice` even after the buffer is trimmed.
 */
export class TranscriptCapture {
  private readonly roomsDir: string;
  private readonly streams = new Map<string, TerminalStreamEntry>();
  private readonly emitter = new EventEmitter();

  constructor(input: TranscriptCaptureInput) {
    this.roomsDir = input.roomsDir;
  }

  attach(terminal: HightableTerminal): string {
    const existing = this.streams.get(terminal.id);
    if (existing) return existing.rawLogPath;

    const roomDir = path.join(this.roomsDir, terminal.roomId);
    // 0o700 on the room dir + 0o600 on the raw log file — transcripts contain
    // whatever the agent CLI emits, which can include project contents,
    // prompt text, and API responses. Keep them user-only on multi-user boxes.
    mkdirSync(roomDir, { recursive: true, mode: 0o700 });
    const rawLogPath = path.join(roomDir, `${terminal.agent}.raw.log`);
    const stream = createWriteStream(rawLogPath, { flags: "a", mode: 0o600 });
    stream.on("error", (err) => {
      console.warn(`[transcript] ${rawLogPath}: ${err.message}`);
    });

    this.streams.set(terminal.id, {
      stream,
      rawLogPath,
      roomId: terminal.roomId,
      agent: terminal.agent,
      cleaned: "",
      absoluteOffset: 0,
      lastRateLimitAt: 0,
    });
    return rawLogPath;
  }

  append(terminalId: string, data: string): void {
    const entry = this.streams.get(terminalId);
    if (!entry) return;
    entry.stream.write(data);

    const cleanedDelta = stripAnsi(data);
    if (!cleanedDelta) return;

    // To handle markers that straddle append boundaries, keep a small
    // backlap of the prior buffer and scan it plus the new delta.
    const overlap = Math.min(entry.cleaned.length, 128);
    const scanRegion = entry.cleaned.slice(entry.cleaned.length - overlap) + cleanedDelta;
    const scanRegionStartAbs = entry.absoluteOffset + (entry.cleaned.length - overlap);

    entry.cleaned += cleanedDelta;
    if (entry.cleaned.length > MAX_CLEAN_BUFFER) {
      const trimBy = entry.cleaned.length - MAX_CLEAN_BUFFER;
      entry.cleaned = entry.cleaned.slice(trimBy);
      entry.absoluteOffset += trimBy;
    }

    // Emit any match whose END falls inside the newly-appended region.
    // Markers that ended in the prior buffer were already emitted; markers
    // that straddle the boundary end in the new delta and are new.
    const newDeltaStartAbs = entry.absoluteOffset + entry.cleaned.length - cleanedDelta.length;

    MARKER_PATTERN.lastIndex = 0;
    for (let m = MARKER_PATTERN.exec(scanRegion); m !== null; m = MARKER_PATTERN.exec(scanRegion)) {
      const matchStartAbs = scanRegionStartAbs + m.index;
      const matchEndAbs = matchStartAbs + m[0].length;
      if (matchEndAbs <= newDeltaStartAbs) continue;
      const kindToken = m[1] === "BEGIN" ? "begin" : "done";
      const markerId = m[2].replace(/\s+/g, "");
      this.emitter.emit("marker", {
        terminalId,
        agent: entry.agent,
        kind: kindToken,
        markerId,
        bufferOffset: matchStartAbs,
      });
    }

    // Rate-limit detection: scan the same region for known error wording.
    // Dedupe per terminal with a 60 s window so a single error rendered many
    // times by TUI redraws does not spam the event bus.
    const nowMs = Date.now();
    if (nowMs - entry.lastRateLimitAt > RATE_LIMIT_DEDUPE_MS) {
      const detection = detectRateLimit(entry.agent, cleanedDelta, new Date(nowMs));
      if (detection) {
        entry.lastRateLimitAt = nowMs;
        const event: RateLimitEvent = {
          terminalId,
          agent: detection.agent,
          until: detection.until,
          note: detection.note,
          match: detection.match,
        };
        this.emitter.emit("rate-limit", event);
      }
    }
  }

  snapshotOffset(terminalId: string): number {
    const entry = this.streams.get(terminalId);
    if (!entry) return 0;
    return entry.absoluteOffset + entry.cleaned.length;
  }

  /**
   * Return cleaned text between two absolute offsets. Any portion that has
   * already been trimmed from the ring buffer is returned as an empty prefix.
   */
  getCleanedSlice(terminalId: string, fromOffset: number, toOffset: number): string {
    const entry = this.streams.get(terminalId);
    if (!entry) return "";
    const bufferStartAbs = entry.absoluteOffset;
    const bufferEndAbs = bufferStartAbs + entry.cleaned.length;
    const start = Math.max(fromOffset, bufferStartAbs) - bufferStartAbs;
    const end = Math.min(toOffset, bufferEndAbs) - bufferStartAbs;
    if (end <= start) return "";
    return entry.cleaned.slice(start, end);
  }

  onMarker(listener: (event: MarkerEvent) => void): Unsubscribe {
    this.emitter.on("marker", listener);
    return () => this.emitter.off("marker", listener);
  }

  onRateLimit(listener: (event: RateLimitEvent) => void): Unsubscribe {
    this.emitter.on("rate-limit", listener);
    return () => this.emitter.off("rate-limit", listener);
  }

  detach(terminalId: string): void {
    const entry = this.streams.get(terminalId);
    if (!entry) return;
    entry.stream.end();
    this.streams.delete(terminalId);
  }

  pathFor(terminalId: string): string | undefined {
    return this.streams.get(terminalId)?.rawLogPath;
  }

  closeAll(): void {
    for (const { stream } of this.streams.values()) {
      stream.end();
    }
    this.streams.clear();
  }
}
