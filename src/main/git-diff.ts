import { execFile } from "node:child_process";

const GIT_TIMEOUT_MS = 5_000;
const MAX_STATUS_BYTES = 2 * 1024;
const MAX_DIFF_STAT_BYTES = 8 * 1024;
const MAX_DIFF_BYTES = 64 * 1024;

export interface GitDiffArtifact {
  available: boolean;
  statusShort: string;
  diffStat: string;
  diff: string;
  note?: string;
}

/**
 * Run `git` inside the room's repo to capture a snapshot useful for a
 * reviewer prompt. Best-effort: if git isn't installed, or the path isn't a
 * git working tree, returns `available: false` with a note the reviewer can
 * see in place of the diff block.
 */
export async function captureGitDiff(repoPath: string): Promise<GitDiffArtifact> {
  if (!repoPath) {
    return emptyArtifact("Repo path is empty.");
  }

  const insideWorktree = await runGit(repoPath, ["rev-parse", "--is-inside-work-tree"]);
  if (!insideWorktree.ok || insideWorktree.stdout.trim() !== "true") {
    return emptyArtifact("Repository is not a git working tree.");
  }

  const [statusResult, statResult, diffResult] = await Promise.all([
    runGit(repoPath, ["status", "--short"]),
    runGit(repoPath, ["diff", "--stat"]),
    runGit(repoPath, ["diff"]),
  ]);

  return {
    available: true,
    statusShort: scrubMarkers(capture(statusResult, MAX_STATUS_BYTES)),
    diffStat: scrubMarkers(capture(statResult, MAX_DIFF_STAT_BYTES)),
    diff: scrubMarkers(capture(diffResult, MAX_DIFF_BYTES)),
  };
}

/**
 * If a repo file happens to contain the literal orchestration-marker
 * tokens (`[HM_RUN_BEGIN:xxxxxxxx]` / `[HM_RUN_DONE:xxxxxxxx]`) — e.g.
 * in a test fixture, a comment, or this project's own sources — they
 * must not appear in the review prompt. The transcript scanner would
 * mis-fire a DONE event and truncate the reviewer's actual response.
 * Replace them with a visible placeholder so the reviewer can still see
 * that the file referenced them.
 */
function scrubMarkers(text: string): string {
  // Replacement uses guillemets so the result cannot re-match the
  // transcript scanner's marker regex (which anchors on `[HM_RUN_…:…]`).
  return text.replace(
    /\[HM_RUN_(BEGIN|DONE):[0-9a-fA-F\-\s]+\]/g,
    "«HM_RUN_$1 marker in source»",
  );
}

/** Format the artifact for injection into a review prompt. */
export function formatGitDiffForPrompt(artifact: GitDiffArtifact): string {
  if (!artifact.available) {
    return artifact.note ?? "No git diff available.";
  }
  const parts: string[] = [];
  if (artifact.statusShort.trim()) parts.push(`$ git status --short\n${artifact.statusShort}`);
  if (artifact.diffStat.trim()) parts.push(`$ git diff --stat\n${artifact.diffStat}`);
  if (artifact.diff.trim()) parts.push(`$ git diff\n${artifact.diff}`);
  if (parts.length === 0) return "(working tree is clean — no changes to diff)";
  return parts.join("\n\n");
}

interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[]): Promise<GitRunResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        resolve({ ok: err === null, stdout, stderr });
      },
    );
  });
}

function capture(result: GitRunResult, maxBytes: number): string {
  if (!result.ok) return "";
  if (result.stdout.length <= maxBytes) return result.stdout;
  return result.stdout.slice(0, maxBytes) + `\n... [truncated at ${maxBytes} bytes]`;
}

function emptyArtifact(note: string): GitDiffArtifact {
  return { available: false, statusShort: "", diffStat: "", diff: "", note };
}
