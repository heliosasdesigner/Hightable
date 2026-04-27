import fs from "node:fs";
import path from "node:path";
import type {
  AgentId,
  CreateRoomInput,
  HightableRoom,
  HightableTerminal,
  OpenRoomResult,
} from "../shared/types.js";
import type { HightableStore } from "./sqlite-store.js";
import type { PtyManager } from "./pty-manager.js";
import type { TranscriptCapture } from "./transcript-capture.js";

export interface RoomManagerDeps {
  store: HightableStore;
  ptyManager: PtyManager;
  transcript: TranscriptCapture;
}

interface ActiveTerminalEntry {
  roomId: string;
  agent: AgentId;
  terminalRecordId: string;
  ptyTerminalId: string;
}

/**
 * Connects rooms to terminals:
 *   - validates repo paths before creating rooms
 *   - starts or reuses Claude/Codex PTYs when a room opens
 *   - persists terminal rows and keeps their status in sync with PTY lifecycle
 *   - pipes PTY output through TranscriptCapture for raw-log storage
 */
export class RoomManager {
  private readonly store: HightableStore;
  private readonly ptyManager: PtyManager;
  private readonly transcript: TranscriptCapture;
  private readonly active = new Map<string, ActiveTerminalEntry>(); // key: ptyTerminalId

  constructor(deps: RoomManagerDeps) {
    this.store = deps.store;
    this.ptyManager = deps.ptyManager;
    this.transcript = deps.transcript;

    this.ptyManager.onData((event) => {
      this.transcript.append(event.terminalId, event.data);
    });

    this.ptyManager.onExit((event) => {
      const entry = this.active.get(event.terminalId);
      if (!entry) return;
      this.active.delete(event.terminalId);
      this.transcript.detach(event.terminalId);
      try {
        this.store.updateTerminalStatus(entry.terminalRecordId, "stopped");
      } catch (err) {
        console.warn(`[room] terminal status update failed: ${(err as Error).message}`);
      }
    });
  }

  listRooms(): HightableRoom[] {
    return this.store.listRooms();
  }

  createRoom(input: CreateRoomInput): HightableRoom {
    const name = input.name.trim();
    if (!name) throw new Error("Room name is required");
    const resolved = validateRepoPath(input.repoPath);
    return this.store.createRoom({
      name,
      repoPath: resolved,
      topic: input.topic?.trim() || undefined,
    });
  }

  openRoom(roomId: string): OpenRoomResult {
    const room = this.store.getRoom(roomId);
    if (!room) throw new Error(`Room not found: ${roomId}`);
    const resolved = validateRepoPath(room.repoPath);

    const touched = this.store.touchRoom(roomId);

    // Prior-session terminal rows with no live PTY are orphans; mark stopped.
    const activeIds = new Set(Array.from(this.active.values(), (e) => e.terminalRecordId));
    for (const record of this.store.listTerminals(roomId)) {
      if (record.status === "stopped" || record.status === "failed") continue;
      if (!activeIds.has(record.id)) {
        this.store.updateTerminalStatus(record.id, "stopped");
      }
    }

    const terminals: HightableTerminal[] = [];
    for (const agent of ["claude", "codex"] as const) {
      terminals.push(
        this.ensureTerminalForAgent(touched, agent, resolved, {
          resume: touched.resumeOnOpen,
        }),
      );
    }

    const rounds = this.store.listRounds(roomId);
    return { room: touched, terminals, rounds };
  }

  /**
   * Kill the PTY for a terminal row and spawn a fresh one in its place.
   * Used by the per-pane Restart / Resume buttons — the DB terminal row is
   * replaced, the old PTY exits, the caller should re-subscribe by id.
   */
  restartTerminal(terminalId: string, options: { resume: boolean }): HightableTerminal {
    const entry = this.active.get(terminalId);
    let resolvedRoomId = entry?.roomId;
    let agent: AgentId | undefined = entry?.agent;
    if (!resolvedRoomId || !agent) {
      // Terminal row may belong to a room we haven't cached; walk rooms.
      for (const room of this.store.listRooms()) {
        const t = this.store.listTerminals(room.id).find((r) => r.id === terminalId);
        if (t) {
          resolvedRoomId = room.id;
          agent = t.agent;
          break;
        }
      }
    }
    if (!resolvedRoomId || !agent) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }
    const room = this.store.getRoom(resolvedRoomId);
    if (!room) throw new Error(`Room not found: ${resolvedRoomId}`);

    // Kill the existing PTY; the onExit handler tears down active state,
    // detaches the transcript, and marks the row stopped.
    if (entry) {
      try {
        this.ptyManager.kill(entry.ptyTerminalId);
      } catch {
        /* already gone */
      }
      this.active.delete(entry.ptyTerminalId);
    }

    return this.ensureTerminalForAgent(room, agent, room.repoPath, {
      resume: options.resume,
      forceNew: true,
    });
  }

  findActiveTerminal(roomId: string, agent: AgentId): HightableTerminal | undefined {
    for (const entry of this.active.values()) {
      if (entry.roomId === roomId && entry.agent === agent) {
        const terminals = this.store.listTerminals(roomId);
        return terminals.find((t) => t.id === entry.terminalRecordId);
      }
    }
    return undefined;
  }

  getPtyTerminalId(roomId: string, agent: AgentId): string | undefined {
    for (const entry of this.active.values()) {
      if (entry.roomId === roomId && entry.agent === agent) {
        return entry.ptyTerminalId;
      }
    }
    return undefined;
  }

  private ensureTerminalForAgent(
    room: HightableRoom,
    agent: AgentId,
    resolvedRepoPath: string,
    options: { resume?: boolean; forceNew?: boolean } = {},
  ): HightableTerminal {
    if (!options.forceNew) {
      const existing = this.findActiveTerminalEntry(room.id, agent);
      if (existing) {
        const terminals = this.store.listTerminals(room.id);
        const record = terminals.find((t) => t.id === existing.terminalRecordId);
        if (record) return record;
      }
    }

    const handle = this.ptyManager.start({
      roomId: room.id,
      agent,
      repoPath: resolvedRepoPath,
      resume: options.resume,
    });

    // Use the PTY terminal id as the DB record id so data/exit events
    // routed by id line up across the IPC bridge.
    const record = this.store.createTerminal({
      id: handle.terminalId,
      roomId: room.id,
      agent,
      command: handle.command.display,
      cwd: handle.command.cwd,
      status: "idle",
    });

    this.active.set(handle.terminalId, {
      roomId: room.id,
      agent,
      terminalRecordId: record.id,
      ptyTerminalId: handle.terminalId,
    });

    this.transcript.attach(record);
    return record;
  }

  private findActiveTerminalEntry(roomId: string, agent: AgentId): ActiveTerminalEntry | undefined {
    for (const entry of this.active.values()) {
      if (entry.roomId === roomId && entry.agent === agent) return entry;
    }
    return undefined;
  }
}

/**
 * Directories that are NEVER a legitimate project root. Pointing a room
 * at any of these would give the agent CLI + git-diff capture read/write
 * access to secrets or system state. The check is absolute-path + boundary
 * (prefix + "/"), not substring, so `~/.sshfoo` is still allowed.
 */
const SENSITIVE_PATH_PREFIXES: readonly string[] = [
  "/etc",
  "/var",
  "/private/etc",
  "/private/var",
  "/System",
  "/usr/bin",
  "/usr/sbin",
  "/bin",
  "/sbin",
];

function isUnderSensitivePath(resolved: string, home: string | undefined): boolean {
  const underHome = (suffix: string): boolean => {
    if (!home) return false;
    const target = path.resolve(home, suffix);
    return resolved === target || resolved.startsWith(target + path.sep);
  };
  for (const prefix of SENSITIVE_PATH_PREFIXES) {
    if (resolved === prefix || resolved.startsWith(prefix + path.sep)) return true;
  }
  // Per-user secrets/config we really don't want an agent CLI to cd into.
  for (const rel of [".ssh", ".gnupg", ".aws", ".config/gcloud", ".config/gh", ".kube"]) {
    if (underHome(rel)) return true;
  }
  return false;
}

function validateRepoPath(repoPath: string): string {
  if (!repoPath || !repoPath.trim()) {
    throw new Error("Repo path is required");
  }
  // Leading '-' would be (mis)read as a flag by the agent CLI when we
  // pass the path as an argv element (`codex -C <repoPath>`).
  if (repoPath.trim().startsWith("-")) {
    throw new Error("Repo path cannot begin with '-' (would be read as a CLI flag)");
  }
  const resolved = path.resolve(repoPath);
  // Use lstat first: if the supplied path itself is a symlink we want to
  // detect that before following it into a possibly sensitive location.
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(resolved);
  } catch {
    throw new Error(`Repo path does not exist: ${resolved}`);
  }
  if (lstat.isSymbolicLink()) {
    throw new Error(`Repo path must not be a symlink: ${resolved}`);
  }
  if (!lstat.isDirectory()) {
    throw new Error(`Repo path is not a directory: ${resolved}`);
  }
  // Realpath catches the case where a parent component is a symlink
  // (e.g. /tmp -> /private/tmp on macOS) — we still accept that, but we
  // run the sensitive-path check against the real target.
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    real = resolved;
  }
  if (isUnderSensitivePath(real, process.env["HOME"])) {
    throw new Error(
      `Repo path is under a sensitive system/user location and refuses to open: ${real}`,
    );
  }
  return real;
}
