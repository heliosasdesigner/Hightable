import type { AgentId } from "../shared/types.js";

export interface BuiltCommand {
  executable: string;
  args: string[];
  cwd: string;
  display: string;
}

export interface BuildAgentCommandInput {
  agent: AgentId;
  repoPath: string;
  /**
   * When true, pass the CLI's "restore last session" flag so the agent picks
   * up where it left off. Falls back silently to a fresh session if the CLI
   * can't find one on disk.
   *   - Claude Code: `claude -c` (alias of `--continue`)
   *   - Codex CLI: `codex resume --last`
   */
  resume?: boolean;
}

export function buildAgentCommand(input: BuildAgentCommandInput): BuiltCommand {
  if (!input.repoPath) {
    throw new Error("buildAgentCommand requires a non-empty repoPath");
  }
  const resume = !!input.resume;
  switch (input.agent) {
    case "claude":
      return makeCommand("claude", resume ? ["-c"] : [], input.repoPath);
    case "codex":
      return makeCommand(
        "codex",
        resume
          ? ["--no-alt-screen", "resume", "--last", "-C", input.repoPath]
          : ["--no-alt-screen", "-C", input.repoPath],
        input.repoPath,
      );
    default: {
      const unreachable: never = input.agent;
      throw new Error(`Unknown agent: ${String(unreachable)}`);
    }
  }
}

export interface BuildNonInteractiveCommandInput {
  agent: AgentId;
  repoPath: string;
  prompt: string;
}

/**
 * Build a one-shot non-interactive invocation that writes the agent's
 * response to stdout and exits. Used for tracked rounds so we capture a
 * clean response instead of scraping it out of an interactive TUI stream.
 */
export function buildNonInteractiveCommand(input: BuildNonInteractiveCommandInput): BuiltCommand {
  if (!input.repoPath) {
    throw new Error("buildNonInteractiveCommand requires a non-empty repoPath");
  }
  if (!input.prompt) {
    throw new Error("buildNonInteractiveCommand requires a non-empty prompt");
  }
  switch (input.agent) {
    case "claude":
      return makeCommand("claude", ["-p", input.prompt], input.repoPath);
    case "codex":
      return makeCommand("codex", ["exec", "-C", input.repoPath, input.prompt], input.repoPath);
    default: {
      const unreachable: never = input.agent;
      throw new Error(`Unknown agent: ${String(unreachable)}`);
    }
  }
}

function makeCommand(executable: string, args: readonly string[], cwd: string): BuiltCommand {
  return {
    executable,
    args: [...args],
    cwd,
    display: formatDisplay(executable, args),
  };
}

function formatDisplay(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(quoteForDisplay).join(" ");
}

const SAFE_CHARS = /^[A-Za-z0-9_\-./:@+=,%]+$/;

function quoteForDisplay(value: string): string {
  if (value === "") return "''";
  if (SAFE_CHARS.test(value)) return value;
  return "'" + value.replace(/'/g, `'\\''`) + "'";
}
