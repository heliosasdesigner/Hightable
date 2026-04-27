import type { AgentId, RoundDetail } from "../shared/types.js";
import {
  cleanAgentResponse,
  collapseEmbeddedContext,
  scrubResiduals,
} from "../shared/text-cleanup.js";

function labelFor(agent: AgentId): string {
  return agent === "claude" ? "Claude" : "Codex";
}

function targetLabel(target: RoundDetail["round"]["target"]): string {
  switch (target) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "both":
      return "Both (Claude + Codex)";
    case "claude_to_codex":
      return "Claude → Codex";
    case "codex_to_claude":
      return "Codex → Claude";
  }
}

function modeLabel(mode: RoundDetail["round"]["mode"]): string {
  if (mode === "compare") return "Compare";
  if (mode === "discussion") return "Discussion";
  return "Manual";
}

/** Fenced markdown block with the response cleaned once more at export time. */
function fencedResponse(text: string): string {
  const body = cleanAgentResponse(text ?? "").replace(/\s+$/g, "");
  if (!body) return "_(empty response)_";
  return "```text\n" + body + "\n```";
}

/**
 * Prompts are user-typed — apply only the light residual scrub (ANSI
 * leftovers, HM_RUN markers, paste placeholders) so short legitimate lines
 * like "42" aren't filtered out by the TUI noise heuristics.
 */
function fencedPrompt(text: string): string {
  const body = scrubResiduals(collapseEmbeddedContext(text ?? "")).replace(/\s+$/g, "");
  if (!body) return "_(empty prompt)_";
  return "```text\n" + body + "\n```";
}


export function roundToMarkdown(detail: RoundDetail): string {
  const { round, messages } = detail;
  const responses = messages.filter((m) => m.direction === "response");

  const lines: string[] = [];
  lines.push(`# ${modeLabel(round.mode)} round`);
  lines.push("");
  lines.push(`- **Status:** ${round.status}`);
  lines.push(`- **Target:** ${targetLabel(round.target)}`);
  lines.push(`- **Started:** ${round.startedAt}`);
  if (round.completedAt) lines.push(`- **Completed:** ${round.completedAt}`);
  if (round.endGoal) lines.push(`- **End goal:** ${round.endGoal}`);
  lines.push(`- **Round id:** \`${round.id}\``);
  lines.push("");
  lines.push("## Prompt");
  lines.push("");
  lines.push(fencedPrompt(round.prompt));
  lines.push("");

  if (round.mode === "discussion" &&
      (round.target === "claude_to_codex" || round.target === "codex_to_claude")) {
    const primaryAgent: AgentId = round.target === "claude_to_codex" ? "claude" : "codex";
    const reviewerAgent: AgentId = primaryAgent === "claude" ? "codex" : "claude";
    // Interleave: responses come back ordered by created_at, so the Nth response
    // on each side is the Nth iteration. Pair them up.
    const primaryTurns = responses.filter((m) => m.agent === primaryAgent);
    const reviewerTurns = responses.filter((m) => m.agent === reviewerAgent);
    const turnCount = Math.max(primaryTurns.length, reviewerTurns.length);
    for (let i = 0; i < turnCount; i++) {
      lines.push(`## Iteration ${i + 1}`);
      lines.push("");
      const primary = primaryTurns[i];
      const reviewer = reviewerTurns[i];
      const primarySuffix = i === 0 ? "primary" : "revision";
      const reviewerSuffix = i === 0 ? "reviewer" : "re-review";
      lines.push(`### ${labelFor(primaryAgent)} · ${primarySuffix}`);
      lines.push("");
      lines.push(primary ? fencedResponse(primary.cleanedText ?? "") : "_(no response recorded)_");
      lines.push("");
      lines.push(`### ${labelFor(reviewerAgent)} · ${reviewerSuffix}`);
      lines.push("");
      lines.push(reviewer ? fencedResponse(reviewer.cleanedText ?? "") : "_(no response recorded)_");
      lines.push("");
    }
  } else if (round.mode === "compare" || round.target === "both") {
    for (const agent of ["claude", "codex"] as const) {
      lines.push(`## ${labelFor(agent)}`);
      lines.push("");
      const msg = responses.find((m) => m.agent === agent);
      lines.push(msg ? fencedResponse(msg.cleanedText ?? "") : "_(no response recorded)_");
      lines.push("");
    }
  } else {
    lines.push("## Response");
    lines.push("");
    if (responses.length === 0) {
      lines.push("_(no response recorded)_");
    } else {
      for (const m of responses) {
        lines.push(`### ${labelFor(m.agent)}`);
        lines.push("");
        lines.push(fencedResponse(m.cleanedText ?? ""));
        lines.push("");
      }
    }
  }

  return lines.join("\n") + "\n";
}

/** Suggested filename — readable in Finder, no slashes, ISO-ordered. */
export function suggestRoundFilename(detail: RoundDetail): string {
  const stamp = detail.round.startedAt.replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const modeSlug =
    detail.round.mode === "discussion" ? "discussion" :
    detail.round.mode === "compare" ? "compare" : "manual";
  const topic = slugifyPromptHead(detail.round.prompt);
  const parts = ["hightable", stamp, modeSlug];
  if (topic) parts.push(topic);
  return `${parts.join("-")}.md`;
}

function slugifyPromptHead(prompt: string): string {
  return prompt
    .slice(0, 60)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
