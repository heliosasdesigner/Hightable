import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { AgentId, Unsubscribe } from "../shared/types.js";
import { buildAgentCommand, type BuiltCommand } from "./command-builder.js";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

export interface StartTerminalInput {
  terminalId?: string;
  roomId: string;
  agent: AgentId;
  repoPath: string;
  cols?: number;
  rows?: number;
  env?: NodeJS.ProcessEnv;
  /** Spawn with the CLI's resume flag so the prior session is restored. */
  resume?: boolean;
}

export interface TerminalHandle {
  terminalId: string;
  roomId: string;
  agent: AgentId;
  command: BuiltCommand;
  pid: number;
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

interface TrackedTerminal {
  handle: TerminalHandle;
  process: IPty;
}

export class PtyManager {
  private readonly terminals = new Map<string, TrackedTerminal>();
  private readonly emitter = new EventEmitter();

  start(input: StartTerminalInput): TerminalHandle {
    const command = buildAgentCommand({
      agent: input.agent,
      repoPath: input.repoPath,
      resume: input.resume,
    });
    const terminalId = input.terminalId ?? randomUUID();
    if (this.terminals.has(terminalId)) {
      throw new Error(`Terminal id already in use: ${terminalId}`);
    }
    const ptyProcess = pty.spawn(command.executable, command.args, {
      name: "xterm-256color",
      cols: input.cols ?? DEFAULT_COLS,
      rows: input.rows ?? DEFAULT_ROWS,
      cwd: command.cwd,
      env: (input.env ?? process.env) as { [key: string]: string },
    });

    const handle: TerminalHandle = {
      terminalId,
      roomId: input.roomId,
      agent: input.agent,
      command,
      pid: ptyProcess.pid,
    };

    this.terminals.set(terminalId, { handle, process: ptyProcess });

    ptyProcess.onData((data) => {
      const event: TerminalDataEvent = {
        terminalId,
        agent: input.agent,
        data,
      };
      this.emitter.emit("data", event);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      this.terminals.delete(terminalId);
      const event: TerminalExitEvent = {
        terminalId,
        agent: input.agent,
        exitCode,
        signal: signal ?? undefined,
      };
      this.emitter.emit("exit", event);
    });

    return handle;
  }

  write(terminalId: string, data: string): void {
    // Silent no-op for unknown ids. Keystrokes can race with PTY exit;
    // throwing here would surface a meaningless error to the renderer.
    const entry = this.terminals.get(terminalId);
    if (!entry) return;
    entry.process.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return;
    const entry = this.terminals.get(terminalId);
    if (!entry) return;
    entry.process.resize(cols, rows);
  }

  kill(terminalId: string, signal?: string): void {
    const entry = this.terminals.get(terminalId);
    if (!entry) return;
    entry.process.kill(signal);
  }

  killAll(signal?: string): void {
    for (const { process } of this.terminals.values()) {
      try {
        process.kill(signal);
      } catch {
        /* already exited */
      }
    }
  }

  has(terminalId: string): boolean {
    return this.terminals.has(terminalId);
  }

  get(terminalId: string): TerminalHandle | undefined {
    return this.terminals.get(terminalId)?.handle;
  }

  list(): TerminalHandle[] {
    return Array.from(this.terminals.values(), (entry) => entry.handle);
  }

  onData(listener: (event: TerminalDataEvent) => void): Unsubscribe {
    this.emitter.on("data", listener);
    return () => this.emitter.off("data", listener);
  }

  onExit(listener: (event: TerminalExitEvent) => void): Unsubscribe {
    this.emitter.on("exit", listener);
    return () => this.emitter.off("exit", listener);
  }
}

export interface BinaryStatus {
  name: string;
  found: boolean;
  path?: string;
}

/**
 * Resolve an executable on PATH. Surfaces missing CLIs as app-level
 * diagnostics rather than crashing at PTY spawn time.
 */
export function locateBinary(name: string, env: NodeJS.ProcessEnv = process.env): BinaryStatus {
  const rawPath = env["PATH"] ?? "";
  const separator = process.platform === "win32" ? ";" : ":";
  const entries = rawPath.split(separator).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";").map((ext) => ext.toLowerCase())
      : [""];

  for (const dir of entries) {
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return { name, found: true, path: candidate };
      } catch {
        /* continue searching */
      }
    }
  }
  return { name, found: false };
}

export function checkAgentBinaries(
  env: NodeJS.ProcessEnv = process.env,
): Record<AgentId, BinaryStatus> {
  return {
    claude: locateBinary("claude", env),
    codex: locateBinary("codex", env),
  };
}
