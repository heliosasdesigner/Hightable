import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  AgentId,
  AgentRateLimit,
  HightableRoom,
  HightableTerminal,
  MessageDirection,
  PromptRound,
  PromptTarget,
  RoundMessage,
  RoundMode,
  RoundStatus,
  TerminalStatus,
  TranscriptSearchResult,
} from "../shared/types.js";
import { ensureHightableStorage } from "./storage-paths.js";

interface RoomRow {
  id: string;
  name: string;
  repo_path: string;
  topic: string | null;
  created_at: string;
  last_used_at: string;
  resume_on_open: number | null;
}

interface TerminalRow {
  id: string;
  room_id: string;
  agent: AgentId;
  command: string;
  cwd: string;
  status: TerminalStatus;
  started_at: string;
  stopped_at: string | null;
}

interface RoundRow {
  id: string;
  room_id: string;
  mode: RoundMode;
  target: PromptTarget | null;
  prompt: string;
  end_goal: string | null;
  status: RoundStatus;
  started_at: string;
  completed_at: string | null;
}

/** RoundRow plus the derived list of agents that received the prompt. */
type RoundRowWithAgents = RoundRow & { prompt_agents: string | null };

interface MessageRow {
  id: string;
  round_id: string;
  terminal_id: string | null;
  agent: AgentId;
  direction: MessageDirection;
  raw_text_path: string | null;
  cleaned_text: string | null;
  created_at: string;
}

interface RateLimitRow {
  id: string;
  agent: AgentId;
  limited_until: string;
  note: string | null;
  created_at: string;
}

export interface CreateTerminalInput {
  id?: string;
  roomId: string;
  agent: AgentId;
  command: string;
  cwd: string;
  status: TerminalStatus;
}

export interface CreateRoundInput {
  roomId: string;
  mode: RoundMode;
  target: PromptTarget;
  prompt: string;
  endGoal?: string;
  status?: RoundStatus;
}

export class HightableStore {
  private readonly db: Database.Database;

  constructor(databasePath = ensureHightableStorage().databasePath) {
    this.db = new Database(databasePath);
    this.db.pragma("foreign_keys = ON");
    this.initializeSchema();
  }

  listTableNames(): string[] {
    return this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => (row as { name: string }).name);
  }

  createRoom(input: { name: string; repoPath: string; topic?: string }): HightableRoom {
    const now = new Date().toISOString();
    const room: HightableRoom = {
      id: randomUUID(),
      name: input.name,
      repoPath: input.repoPath,
      topic: input.topic,
      createdAt: now,
      lastUsedAt: now,
      resumeOnOpen: false,
    };

    this.db
      .prepare(
        `INSERT INTO rooms (id, name, repo_path, topic, created_at, last_used_at, resume_on_open)
         VALUES (@id, @name, @repoPath, @topic, @createdAt, @lastUsedAt, 0)`,
      )
      .run({
        ...room,
        topic: room.topic ?? null,
      });

    return room;
  }

  setRoomResumePolicy(roomId: string, resumeOnOpen: boolean): HightableRoom {
    this.db
      .prepare("UPDATE rooms SET resume_on_open = ? WHERE id = ?")
      .run(resumeOnOpen ? 1 : 0, roomId);
    const room = this.getRoom(roomId);
    if (!room) throw new Error(`Room not found: ${roomId}`);
    return room;
  }

  listRooms(): HightableRoom[] {
    return this.db
      .prepare("SELECT * FROM rooms ORDER BY last_used_at DESC, rowid DESC")
      .all()
      .map((row) => mapRoom(row as RoomRow));
  }

  getRoom(roomId: string): HightableRoom | undefined {
    const row = this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
    return row ? mapRoom(row as RoomRow) : undefined;
  }

  touchRoom(roomId: string): HightableRoom {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE rooms SET last_used_at = ? WHERE id = ?").run(now, roomId);
    const room = this.getRoom(roomId);
    if (!room) throw new Error(`Room not found: ${roomId}`);
    return room;
  }

  createTerminal(input: CreateTerminalInput): HightableTerminal {
    const terminal: HightableTerminal = {
      id: input.id ?? randomUUID(),
      roomId: input.roomId,
      agent: input.agent,
      command: input.command,
      cwd: input.cwd,
      status: input.status,
      startedAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `INSERT INTO terminals (id, room_id, agent, command, cwd, status, started_at, stopped_at)
         VALUES (@id, @roomId, @agent, @command, @cwd, @status, @startedAt, NULL)`,
      )
      .run(terminal);

    return terminal;
  }

  listTerminals(roomId: string): HightableTerminal[] {
    return this.db
      .prepare("SELECT * FROM terminals WHERE room_id = ? ORDER BY started_at ASC, rowid ASC")
      .all(roomId)
      .map((row) => mapTerminal(row as TerminalRow));
  }

  updateTerminalStatus(terminalId: string, status: TerminalStatus): HightableTerminal {
    const stoppedAt = status === "stopped" || status === "failed" ? new Date().toISOString() : null;
    this.db
      .prepare("UPDATE terminals SET status = ?, stopped_at = COALESCE(?, stopped_at) WHERE id = ?")
      .run(status, stoppedAt, terminalId);

    const row = this.db.prepare("SELECT * FROM terminals WHERE id = ?").get(terminalId);
    if (!row) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }
    return mapTerminal(row as TerminalRow);
  }

  createRound(input: CreateRoundInput): PromptRound {
    const round: PromptRound = {
      id: randomUUID(),
      roomId: input.roomId,
      mode: input.mode,
      target: input.target,
      prompt: input.prompt,
      endGoal: input.endGoal,
      status: input.status ?? "queued",
      startedAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `INSERT INTO rounds (id, room_id, mode, target, prompt, end_goal, status, started_at, completed_at)
         VALUES (@id, @roomId, @mode, @target, @prompt, @endGoal, @status, @startedAt, NULL)`,
      )
      .run({ ...round, endGoal: round.endGoal ?? null });

    return round;
  }

  listRounds(roomId: string): PromptRound[] {
    return this.db
      .prepare(
        `SELECT r.*, (
           SELECT GROUP_CONCAT(DISTINCT agent)
           FROM messages WHERE round_id = r.id AND direction = 'prompt'
         ) AS prompt_agents
         FROM rounds r WHERE r.room_id = ?
         ORDER BY r.started_at DESC, r.rowid DESC`,
      )
      .all(roomId)
      .map((row) => mapRound(row as RoundRowWithAgents));
  }

  completeRound(roundId: string): PromptRound {
    return this.updateRoundStatus(roundId, "completed");
  }

  updateRoundStatus(roundId: string, status: RoundStatus): PromptRound {
    const completedAt =
      status === "completed" || status === "failed" ? new Date().toISOString() : null;
    this.db
      .prepare("UPDATE rounds SET status = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?")
      .run(status, completedAt, roundId);

    const row = this.db
      .prepare(
        `SELECT r.*, (
           SELECT GROUP_CONCAT(DISTINCT agent)
           FROM messages WHERE round_id = r.id AND direction = 'prompt'
         ) AS prompt_agents
         FROM rounds r WHERE r.id = ?`,
      )
      .get(roundId);
    if (!row) throw new Error(`Round not found: ${roundId}`);
    return mapRound(row as RoundRowWithAgents);
  }

  createMessage(input: {
    roundId: string;
    terminalId?: string;
    agent: AgentId;
    direction: "prompt" | "response";
    rawTextPath?: string;
    cleanedText?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, round_id, terminal_id, agent, direction, raw_text_path, cleaned_text, created_at)
         VALUES (@id, @roundId, @terminalId, @agent, @direction, @rawTextPath, @cleanedText, @createdAt)`,
      )
      .run({
        id: randomUUID(),
        roundId: input.roundId,
        terminalId: input.terminalId ?? null,
        agent: input.agent,
        direction: input.direction,
        rawTextPath: input.rawTextPath ?? null,
        cleanedText: input.cleanedText ?? null,
        createdAt: new Date().toISOString(),
      });
  }

  getRound(roundId: string): PromptRound | undefined {
    const row = this.db
      .prepare(
        `SELECT r.*, (
           SELECT GROUP_CONCAT(DISTINCT agent)
           FROM messages WHERE round_id = r.id AND direction = 'prompt'
         ) AS prompt_agents
         FROM rounds r WHERE r.id = ?`,
      )
      .get(roundId);
    return row ? mapRound(row as RoundRowWithAgents) : undefined;
  }

  listMessages(roundId: string): RoundMessage[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE round_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(roundId)
      .map((row) => mapMessage(row as MessageRow));
  }

  countPromptsSince(agent: AgentId, since: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as n FROM messages WHERE direction = 'prompt' AND agent = ? AND created_at >= ?",
      )
      .get(agent, since) as { n: number };
    return row.n;
  }

  createRateLimit(input: { agent: AgentId; limitedUntil: string; note?: string }): AgentRateLimit {
    const limit: AgentRateLimit = {
      id: randomUUID(),
      agent: input.agent,
      limitedUntil: input.limitedUntil,
      note: input.note,
      createdAt: new Date().toISOString(),
    };
    // Only one live rate-limit per agent: clear the previous row, then insert.
    this.db.prepare("DELETE FROM rate_limits WHERE agent = ?").run(input.agent);
    this.db
      .prepare(
        `INSERT INTO rate_limits (id, agent, limited_until, note, created_at)
         VALUES (@id, @agent, @limitedUntil, @note, @createdAt)`,
      )
      .run({ ...limit, note: limit.note ?? null });
    return limit;
  }

  clearRateLimits(agent: AgentId): void {
    this.db.prepare("DELETE FROM rate_limits WHERE agent = ?").run(agent);
  }

  /** Delete rate-limit rows whose `note` matches a LIKE pattern. Used for housekeeping. */
  clearRateLimitsWhereNoteLike(pattern: string): number {
    const result = this.db.prepare("DELETE FROM rate_limits WHERE note LIKE ?").run(pattern);
    return Number(result.changes ?? 0);
  }

  getActiveRateLimit(agent: AgentId): AgentRateLimit | undefined {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        "SELECT * FROM rate_limits WHERE agent = ? AND limited_until > ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(agent, now);
    return row ? mapRateLimit(row as RateLimitRow) : undefined;
  }

  searchTranscripts(query: string, limit = 50): TranscriptSearchResult[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const pattern = `%${trimmed.replace(/[\\%_]/g, "\\$&")}%`;
    const results: TranscriptSearchResult[] = [];

    // Matches against a round's user prompt (direction='prompt' messages
    // mirror this field, so pulling it straight from `rounds` is cleanest).
    const promptRows = this.db
      .prepare(
        `SELECT r.id AS round_id, r.room_id, rooms.name AS room_name,
                r.mode, r.target, r.status, r.started_at, r.prompt
         FROM rounds r JOIN rooms ON rooms.id = r.room_id
         WHERE r.prompt LIKE ? ESCAPE '\\'
         ORDER BY r.started_at DESC
         LIMIT ?`,
      )
      .all(pattern, limit);
    for (const row of promptRows) {
      const r = row as PromptSearchRow;
      results.push({
        roundId: r.round_id,
        roomId: r.room_id,
        roomName: r.room_name,
        mode: r.mode,
        target: (r.target ?? "both") as PromptTarget,
        status: r.status,
        startedAt: r.started_at,
        snippet: buildSnippet(r.prompt, trimmed),
        matchedIn: "prompt",
      });
    }

    // Matches against agent responses. Pick the first matching response per
    // round so the result set stays round-level.
    const responseRows = this.db
      .prepare(
        `SELECT r.id AS round_id, r.room_id, rooms.name AS room_name,
                r.mode, r.target, r.status, r.started_at,
                m.agent, m.cleaned_text, m.created_at
         FROM messages m
         JOIN rounds r ON r.id = m.round_id
         JOIN rooms ON rooms.id = r.room_id
         WHERE m.direction = 'response'
           AND m.cleaned_text IS NOT NULL
           AND m.cleaned_text LIKE ? ESCAPE '\\'
         ORDER BY r.started_at DESC
         LIMIT ?`,
      )
      .all(pattern, limit);
    const seenRoundIds = new Set(results.map((r) => r.roundId));
    for (const row of responseRows) {
      const r = row as ResponseSearchRow;
      if (seenRoundIds.has(r.round_id)) continue;
      seenRoundIds.add(r.round_id);
      results.push({
        roundId: r.round_id,
        roomId: r.room_id,
        roomName: r.room_name,
        mode: r.mode,
        target: (r.target ?? "both") as PromptTarget,
        status: r.status,
        startedAt: r.started_at,
        snippet: buildSnippet(r.cleaned_text ?? "", trimmed),
        matchedIn: "response",
        agent: r.agent,
      });
    }

    return results
      .sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1))
      .slice(0, limit);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Wipe every row from every app table while preserving the schema.
   * Foreign-key dependents go first; order matters. Returns the number of
   * rooms that were removed — the caller uses this to reset UI state.
   */
  resetAll(): { roomsDeleted: number } {
    const roomsDeleted = this.db.prepare("SELECT COUNT(*) as n FROM rooms").get() as { n: number };
    // Run as a single transaction — either it all clears or nothing does.
    const clear = this.db.transaction(() => {
      this.db.exec(`
        DELETE FROM artifacts;
        DELETE FROM messages;
        DELETE FROM rounds;
        DELETE FROM rate_limits;
        DELETE FROM terminals;
        DELETE FROM rooms;
      `);
    });
    clear();
    return { roomsDeleted: roomsDeleted.n };
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        topic TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        resume_on_open INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS terminals (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        stopped_at TEXT,
        FOREIGN KEY (room_id) REFERENCES rooms(id)
      );

      CREATE TABLE IF NOT EXISTS rounds (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        target TEXT,
        prompt TEXT NOT NULL,
        end_goal TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (room_id) REFERENCES rooms(id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        round_id TEXT NOT NULL,
        terminal_id TEXT,
        agent TEXT NOT NULL,
        direction TEXT NOT NULL,
        raw_text_path TEXT,
        cleaned_text TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (round_id) REFERENCES rounds(id),
        FOREIGN KEY (terminal_id) REFERENCES terminals(id)
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        round_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (round_id) REFERENCES rounds(id)
      );

      CREATE TABLE IF NOT EXISTS rate_limits (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        limited_until TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL
      );
    `);
    // Lightweight migrations for pre-existing databases. Both ALTER TABLE
    // ADD COLUMN and the UPDATE are cheap for the row counts we work with.
    const roundsCols = this.db.prepare("PRAGMA table_info(rounds)").all() as Array<{
      name: string;
    }>;
    if (!roundsCols.some((c) => c.name === "target")) {
      this.db.exec("ALTER TABLE rounds ADD COLUMN target TEXT");
    }
    if (!roundsCols.some((c) => c.name === "end_goal")) {
      this.db.exec("ALTER TABLE rounds ADD COLUMN end_goal TEXT");
    }
    const roomsCols = this.db.prepare("PRAGMA table_info(rooms)").all() as Array<{
      name: string;
    }>;
    if (!roomsCols.some((c) => c.name === "resume_on_open")) {
      this.db.exec("ALTER TABLE rooms ADD COLUMN resume_on_open INTEGER NOT NULL DEFAULT 0");
    }
    // Legacy rounds used the `sequential_review` mode name before we unified
    // it with Discussion; normalise so queries stay consistent.
    this.db
      .prepare("UPDATE rounds SET mode = 'discussion' WHERE mode = 'sequential_review'")
      .run();
  }
}

function mapRateLimit(row: RateLimitRow): AgentRateLimit {
  return {
    id: row.id,
    agent: row.agent,
    limitedUntil: row.limited_until,
    note: row.note ?? undefined,
    createdAt: row.created_at,
  };
}

function mapRoom(row: RoomRow): HightableRoom {
  return {
    id: row.id,
    name: row.name,
    repoPath: row.repo_path,
    topic: row.topic ?? undefined,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    resumeOnOpen: !!row.resume_on_open,
  };
}

function mapTerminal(row: TerminalRow): HightableTerminal {
  return {
    id: row.id,
    roomId: row.room_id,
    agent: row.agent,
    command: row.command,
    cwd: row.cwd,
    status: row.status,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at ?? undefined,
  };
}

function mapRound(row: RoundRow | RoundRowWithAgents): PromptRound {
  // Prefer the agent list derived from actual prompt messages — it's always
  // in sync with what was really sent. Fall back to the stored target
  // column, then to "both" for rounds predating either source.
  const agentsCsv = "prompt_agents" in row ? row.prompt_agents : null;
  const agents = agentsCsv ? agentsCsv.split(",").filter((a) => a === "claude" || a === "codex") : [];
  let target: PromptTarget;
  if (row.target === "claude_to_codex" || row.target === "codex_to_claude") {
    // Preserve directional targets for Discussion rounds; message-agents only
    // tells us "both participated", not who went first.
    target = row.target;
  } else if (agents.includes("claude") && agents.includes("codex")) {
    target = "both";
  } else if (agents.includes("claude")) {
    target = "claude";
  } else if (agents.includes("codex")) {
    target = "codex";
  } else {
    target = (row.target ?? "both") as PromptTarget;
  }
  // Back-compat: older rows used the legacy `sequential_review` mode name.
  const mode = (row.mode as string) === "sequential_review" ? "discussion" : row.mode;
  return {
    id: row.id,
    roomId: row.room_id,
    mode,
    target,
    prompt: row.prompt,
    endGoal: row.end_goal ?? undefined,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
  };
}

interface PromptSearchRow {
  round_id: string;
  room_id: string;
  room_name: string;
  mode: RoundMode;
  target: PromptTarget | null;
  status: RoundStatus;
  started_at: string;
  prompt: string;
}

interface ResponseSearchRow {
  round_id: string;
  room_id: string;
  room_name: string;
  mode: RoundMode;
  target: PromptTarget | null;
  status: RoundStatus;
  started_at: string;
  agent: AgentId;
  cleaned_text: string | null;
  created_at: string;
}

function buildSnippet(text: string, query: string): string {
  if (!text) return "";
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx < 0) return text.slice(0, 200);
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + needle.length + 140);
  const slice = text.slice(start, end).replace(/\s+/g, " ").trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${slice}${suffix}`;
}

function mapMessage(row: MessageRow): RoundMessage {
  return {
    id: row.id,
    roundId: row.round_id,
    terminalId: row.terminal_id ?? undefined,
    agent: row.agent,
    direction: row.direction,
    cleanedText: row.cleaned_text ?? undefined,
    rawTextPath: row.raw_text_path ?? undefined,
    createdAt: row.created_at,
  };
}
