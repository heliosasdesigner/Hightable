export type AgentId = "claude" | "codex";

export type TerminalStatus = "idle" | "starting" | "busy" | "needs_attention" | "failed" | "stopped";

export type RoundMode = "manual" | "compare" | "discussion";

export type RoundStatus = "queued" | "running" | "needs_attention" | "completed" | "failed";

export type PromptTarget =
  | AgentId
  | "both"
  /** Sequential Review: Claude answers first, Codex reviews. */
  | "claude_to_codex"
  /** Sequential Review: Codex answers first, Claude reviews. */
  | "codex_to_claude";

export interface HightableRoom {
  id: string;
  name: string;
  /** Local filesystem path selected for this room. SourceTree integration is intentionally unsupported. */
  repoPath: string;
  topic?: string;
  createdAt: string;
  lastUsedAt: string;
  /**
   * When true, newly-started PTYs in this room pass `--continue` / `resume`
   * to the CLI so the agent restores its prior session. Defaults to true for
   * rooms that already have prior rounds (opt-out), false for brand-new rooms.
   */
  resumeOnOpen: boolean;
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
  /** Which agent(s) the prompt was routed to — populated at round creation. */
  target: PromptTarget;
  prompt: string;
  /** Free-text end goal for a Discussion round (when set). */
  endGoal?: string;
  status: RoundStatus;
  startedAt: string;
  completedAt?: string;
}

export interface CreateRoomInput {
  name: string;
  /** Local filesystem path selected or entered by the user. */
  repoPath: string;
  topic?: string;
}

export interface OpenRoomInput {
  roomId: string;
}

export interface WriteTerminalInput {
  terminalId: string;
  data: string;
}

export interface ResizeTerminalInput {
  terminalId: string;
  cols: number;
  rows: number;
}

export interface SendPromptInput {
  roomId: string;
  prompt: string;
  mode: RoundMode;
  target: PromptTarget;
  /**
   * For `mode: "discussion"` — how many primary→reviewer pairs to run.
   *
   *   0 = Endless. The loop keeps iterating until both agents explicitly
   *       agree the end goal is met (reviewer emits `End goal status: met`)
   *       or a safety cap is reached. This is the default.
   *   1 = one-off review (classic primary → reviewer, no revision loop).
   *   2–3 = iterative: reviewer feedback goes back to primary, primary
   *       revises, reviewer re-reviews, and so on.
   *   Capped at 3 for explicit counts.
   */
  sequentialTurns?: number;
  /** Free-text end goal the agents aim for in a Discussion round. */
  endGoal?: string;
}

export interface MarkRoundCompleteInput {
  roundId: string;
}

export interface PauseRoundInput {
  roundId: string;
}

export interface TerminalDataEvent {
  terminalId: string;
  agent: AgentId;
  data: string;
}

export interface TerminalExitEvent {
  terminalId: string;
  agent: AgentId;
  exitCode: number;
  signal?: number;
}

export interface RoundUpdatedEvent {
  round: PromptRound;
}

/**
 * Per-turn progress snapshot for running discussion rounds. Emitted from
 * the main process whenever the state machine advances (primary → reviewer
 * → next primary …). Not persisted — UI-only liveness.
 */
export interface RoundProgressEvent {
  roundId: string;
  /** 1-based turn number currently in flight. */
  turnNumber: number;
  /** Upper bound; for endless rounds this is the safety cap. */
  totalTurns: number;
  endless: boolean;
  /** Which side we're currently waiting on. */
  currentSide: "primary" | "reviewer";
  /** Which agent the currentSide maps to, for UI labelling. */
  currentAgent: AgentId;
  /** ISO timestamp when this side started — UI derives elapsed time. */
  turnStartedAt: string;
}

export interface PickDirectoryResult {
  canceled: boolean;
  path?: string;
}

export interface AgentRateLimit {
  id: string;
  agent: AgentId;
  /** ISO timestamp at which the rate limit expires. */
  limitedUntil: string;
  note?: string;
  createdAt: string;
}

export interface AgentUsageStats {
  agent: AgentId;
  today: number;
  week: number;
  limitedUntil?: string;
  note?: string;
}

export interface SetAgentRateLimitInput {
  agent: AgentId;
  limitedUntil: string;
  note?: string;
}

export interface ClearAgentRateLimitInput {
  agent: AgentId;
}

export interface AgentUsageUpdatedEvent {
  usage: AgentUsageStats[];
}

export type MessageDirection = "prompt" | "response";

export interface RoundMessage {
  id: string;
  roundId: string;
  terminalId?: string;
  agent: AgentId;
  direction: MessageDirection;
  cleanedText?: string;
  rawTextPath?: string;
  createdAt: string;
}

export interface RoundDetail {
  round: PromptRound;
  messages: RoundMessage[];
}

export interface GetRoundInput {
  roundId: string;
}

export interface ExportRoundInput {
  roundId: string;
}

export interface ExportRoundResult {
  canceled: boolean;
  path?: string;
}

export interface RestartTerminalInput {
  terminalId: string;
  /** When true, spawn the CLI with `--continue` / `resume` to restore the prior session. */
  resume: boolean;
}

export interface SetRoomResumePolicyInput {
  roomId: string;
  resumeOnOpen: boolean;
}

export interface ResetDatabaseResult {
  roomsDeleted: number;
  rawLogsDeleted: number;
}

export interface TranscriptSearchResult {
  roundId: string;
  roomId: string;
  roomName: string;
  mode: RoundMode;
  target: PromptTarget;
  status: RoundStatus;
  startedAt: string;
  snippet: string;
  matchedIn: "prompt" | "response";
  agent?: AgentId;
}

export interface SearchTranscriptsInput {
  query: string;
  limit?: number;
}

export interface OpenRoomResult {
  room: HightableRoom;
  terminals: HightableTerminal[];
  rounds: PromptRound[];
}

export type Unsubscribe = () => void;

export interface HightableApi {
  createRoom(input: CreateRoomInput): Promise<HightableRoom>;
  listRooms(): Promise<HightableRoom[]>;
  openRoom(input: OpenRoomInput): Promise<OpenRoomResult>;
  getRound(input: GetRoundInput): Promise<RoundDetail>;
  searchTranscripts(input: SearchTranscriptsInput): Promise<TranscriptSearchResult[]>;
  getAgentUsage(): Promise<AgentUsageStats[]>;
  setAgentRateLimit(input: SetAgentRateLimitInput): Promise<AgentRateLimit>;
  clearAgentRateLimit(input: ClearAgentRateLimitInput): Promise<void>;
  pickDirectory(): Promise<PickDirectoryResult>;
  writeTerminal(input: WriteTerminalInput): Promise<void>;
  resizeTerminal(input: ResizeTerminalInput): Promise<void>;
  sendPrompt(input: SendPromptInput): Promise<PromptRound>;
  markRoundComplete(input: MarkRoundCompleteInput): Promise<PromptRound>;
  pauseRound(input: PauseRoundInput): Promise<PromptRound>;
  exportRound(input: ExportRoundInput): Promise<ExportRoundResult>;
  restartTerminal(input: RestartTerminalInput): Promise<HightableTerminal>;
  setRoomResumePolicy(input: SetRoomResumePolicyInput): Promise<HightableRoom>;
  resetDatabase(): Promise<ResetDatabaseResult>;
  onTerminalData(callback: (event: TerminalDataEvent) => void): Unsubscribe;
  onTerminalExit(callback: (event: TerminalExitEvent) => void): Unsubscribe;
  onRoundUpdated(callback: (event: RoundUpdatedEvent) => void): Unsubscribe;
  onRoundProgress(callback: (event: RoundProgressEvent) => void): Unsubscribe;
  onAgentUsageUpdated(callback: (event: AgentUsageUpdatedEvent) => void): Unsubscribe;
}

declare global {
  interface Window {
    hightable: HightableApi;
  }
}
