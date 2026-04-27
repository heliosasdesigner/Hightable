import { spawn } from "node:child_process";
import type { AgentId } from "../shared/types.js";
import { buildNonInteractiveCommand } from "./command-builder.js";

const MAX_STDOUT_BYTES = 8 * 1024 * 1024; // 8 MB cap per run

export interface RunAgentPromptInput {
  agent: AgentId;
  repoPath: string;
  prompt: string;
  signal?: AbortSignal;
}

export type RunExitReason = "exit" | "aborted" | "spawn-error";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  reason: RunExitReason;
  truncated: boolean;
}

/**
 * Spawn a one-shot CLI invocation (`claude -p` / `codex exec`) that writes
 * the agent's response to stdout and exits. The returned stdout is the
 * cleaned response — no TUI rendering, no ANSI stripping required.
 *
 * Honours an optional AbortSignal for orchestration-driven cancellation
 * (timeout or manual `Mark complete`). On abort, resolves with whatever
 * stdout arrived before the child was killed.
 */
export function runAgentPrompt(input: RunAgentPromptInput): Promise<RunResult> {
  const command = buildNonInteractiveCommand({
    agent: input.agent,
    repoPath: input.repoPath,
    prompt: input.prompt,
  });

  return new Promise<RunResult>((resolve) => {
    let stdoutBytes = 0;
    let truncated = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let reason: RunExitReason = "exit";
    let settled = false;

    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    function settle(result: Omit<RunResult, "stdout" | "stderr" | "truncated">): void {
      if (settled) return;
      settled = true;
      if (input.signal) input.signal.removeEventListener("abort", onAbort);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        truncated,
        ...result,
      });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const remaining = MAX_STDOUT_BYTES - stdoutBytes;
      if (chunk.length >= remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        truncated = true;
        child.kill("SIGTERM");
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (err) => {
      stderrChunks.push(Buffer.from(`[spawn error] ${err.message}\n`, "utf8"));
      reason = "spawn-error";
      settle({ exitCode: null, exitSignal: null, reason });
    });

    child.on("close", (code, signal) => {
      settle({ exitCode: code, exitSignal: signal, reason });
    });

    function onAbort(): void {
      reason = "aborted";
      if (!child.killed) child.kill("SIGTERM");
      // If the child ignores SIGTERM, follow with SIGKILL after a short grace.
      setTimeout(() => {
        if (!settled && !child.killed) child.kill("SIGKILL");
      }, 500).unref?.();
    }

    if (input.signal) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
