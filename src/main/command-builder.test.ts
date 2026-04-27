import { describe, expect, it } from "vitest";
import { buildAgentCommand, buildNonInteractiveCommand } from "./command-builder";

describe("buildAgentCommand", () => {
  it("builds the Claude command with the repo cwd and no args", () => {
    expect(buildAgentCommand({ agent: "claude", repoPath: "/repo" })).toEqual({
      executable: "claude",
      args: [],
      cwd: "/repo",
      display: "claude",
    });
  });

  it("builds the Codex command with --no-alt-screen and -C <path>", () => {
    expect(buildAgentCommand({ agent: "codex", repoPath: "/repo" })).toEqual({
      executable: "codex",
      args: ["--no-alt-screen", "-C", "/repo"],
      cwd: "/repo",
      display: "codex --no-alt-screen -C /repo",
    });
  });

  it("keeps repo paths with spaces intact in argv and quotes only the display string", () => {
    const built = buildAgentCommand({ agent: "codex", repoPath: "/Users/alice/my repo" });

    expect(built.args).toEqual(["--no-alt-screen", "-C", "/Users/alice/my repo"]);
    expect(built.display).toBe("codex --no-alt-screen -C '/Users/alice/my repo'");
  });

  it("rejects an empty repo path", () => {
    expect(() => buildAgentCommand({ agent: "claude", repoPath: "" })).toThrow();
  });

  it("passes -c to Claude when resume is true", () => {
    expect(buildAgentCommand({ agent: "claude", repoPath: "/repo", resume: true })).toEqual({
      executable: "claude",
      args: ["-c"],
      cwd: "/repo",
      display: "claude -c",
    });
  });

  it("passes `resume --last` to Codex when resume is true", () => {
    expect(buildAgentCommand({ agent: "codex", repoPath: "/repo", resume: true })).toEqual({
      executable: "codex",
      args: ["--no-alt-screen", "resume", "--last", "-C", "/repo"],
      cwd: "/repo",
      display: "codex --no-alt-screen resume --last -C /repo",
    });
  });
});

describe("buildNonInteractiveCommand", () => {
  it("builds `claude -p <prompt>` with cwd = repo", () => {
    expect(
      buildNonInteractiveCommand({
        agent: "claude",
        repoPath: "/repo",
        prompt: "summarise this repo",
      }),
    ).toEqual({
      executable: "claude",
      args: ["-p", "summarise this repo"],
      cwd: "/repo",
      display: "claude -p 'summarise this repo'",
    });
  });

  it("builds `codex exec -C <path> <prompt>`", () => {
    expect(
      buildNonInteractiveCommand({
        agent: "codex",
        repoPath: "/repo",
        prompt: "what changed?",
      }),
    ).toEqual({
      executable: "codex",
      args: ["exec", "-C", "/repo", "what changed?"],
      cwd: "/repo",
      display: "codex exec -C /repo 'what changed?'",
    });
  });

  it("keeps prompts with spaces and newlines as one argv entry", () => {
    const built = buildNonInteractiveCommand({
      agent: "claude",
      repoPath: "/repo",
      prompt: "line one\nline two",
    });
    expect(built.args).toEqual(["-p", "line one\nline two"]);
  });

  it("rejects empty prompt or empty repoPath", () => {
    expect(() =>
      buildNonInteractiveCommand({ agent: "claude", repoPath: "/repo", prompt: "" }),
    ).toThrow();
    expect(() =>
      buildNonInteractiveCommand({ agent: "claude", repoPath: "", prompt: "hi" }),
    ).toThrow();
  });
});
