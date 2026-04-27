import { describe, expect, it } from "vitest";
import {
  cleanAgentResponse,
  collapseEmbeddedContext,
  scrubResiduals,
} from "./text-cleanup";

describe("scrubResiduals", () => {
  it("strips orphan CSI SGR fragments with the leading bracket intact", () => {
    expect(scrubResiduals("hello [39;48;5;235m world")).toBe("hello  world");
    expect(scrubResiduals("  [2m dim [22m bright ")).toBe("   dim  bright ");
  });

  it("strips CSI SGR fragments that lost their bracket when ANSI straddled a chunk", () => {
    expect(scrubResiduals("9;48;5;235m text")).toBe(" text");
  });

  it("leaves short numeric-suffix prose alone", () => {
    // Only 2 groups → ignored. Single "42" line untouched.
    expect(scrubResiduals("took 5m to run")).toBe("took 5m to run");
    expect(scrubResiduals("42")).toBe("42");
  });

  it("strips OSC title-bar remnants like `;⠏ Project-Docs\\`", () => {
    expect(scrubResiduals("prose ;⠏ Project-Docs\\ more prose")).toBe("prose  more prose");
  });

  it("strips HM_RUN markers wherever they appear", () => {
    expect(scrubResiduals("foo [HM_RUN_BEGIN:abcd1234] bar [HM_RUN_DONE:abcd1234] baz")).toBe(
      "foo  bar  baz",
    );
  });

  it("strips paste placeholders", () => {
    expect(scrubResiduals("prefix [Pasted Content 4162 chars] suffix")).toBe("prefix  suffix");
    expect(scrubResiduals("prefix [Pasted text] suffix")).toBe("prefix  suffix");
  });

  it("strips invisible Unicode junk but keeps tab, newline, carriage return", () => {
    // BOM (U+FEFF), zero-width joiner (U+200D), bidi LRM (U+200E),
    // C1 control (U+0085 NEL), private use (U+E000) all dropped.
    const noisy =
      "hello\uFEFF world\u200D\u200E\u0085\uE000";
    expect(scrubResiduals(noisy)).toBe("hello world");
    // TAB / LF / CR preserved as formatting.
    expect(scrubResiduals("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });

  it("preserves code symbols, CJK, and numeric content", () => {
    const code = "fn main() { let x = 3.14; return x > 0; }";
    expect(scrubResiduals(code)).toBe(code);
    const cjk = "你好世界 — test 123";
    expect(scrubResiduals(cjk)).toBe(cjk);
    const path = "/Users/alice/project:3000";
    expect(scrubResiduals(path)).toBe(path);
  });
});

describe("collapseEmbeddedContext", () => {
  it("collapses nested <last_response> blocks to a placeholder", () => {
    const input = "before\n<last_response>\nlots\nof\nstuff\n</last_response>\nafter";
    expect(collapseEmbeddedContext(input)).toBe(
      "before\n<last_response>…(prior response omitted — see preceding round)…</last_response>\nafter",
    );
  });

  it("collapses <primary_response> and <revised_response> blocks too", () => {
    const out = collapseEmbeddedContext(
      "<primary_response>a</primary_response> mid <revised_response>b</revised_response>",
    );
    expect(out).toContain("…(omitted — see preceding round)…");
    expect(out).not.toContain("<primary_response>a</primary_response>");
  });
});

describe("cleanAgentResponse", () => {
  it("strips HM_RUN scaffolding at edges and collapses TUI noise", () => {
    const raw =
      "[HM_RUN_BEGIN:abcd1234]\n" +
      "Hello world.\n" +
      ";⠏ Project-Docs\\\n" +
      "When your final response is complete, emit [HM_RUN_DONE:abcd1234]\n" +
      "More content.\n" +
      "[HM_RUN_DONE:abcd1234]";
    const out = cleanAgentResponse(raw);
    expect(out).toContain("Hello world.");
    expect(out).toContain("More content.");
    expect(out).not.toContain("HM_RUN_");
    expect(out).not.toContain("When your final response is complete");
    expect(out).not.toContain("Project-Docs");
  });

  it("removes inline HM_RUN markers", () => {
    const raw = "line one\n[HM_RUN_DONE:deadbeef]\nline two";
    const out = cleanAgentResponse(raw);
    expect(out).toContain("line one");
    expect(out).toContain("line two");
    expect(out).not.toContain("HM_RUN_");
  });

  // Real captured sample from a Claude Code discussion round. Locks in
  // regression coverage for the noise types observed in live transcripts:
  // title-bar redraws, spinner verbs (Infusing/Orchestrating/Considering),
  // token-count fragments, ⏵⏵ mode indicators, Tip feed, horizontal rules.
  it("cleans a real captured Claude Code round", () => {
    const raw = `;⠐ Design backend architecture workflow for AI project
❯
✽Infusing…
 ⎿ Tip:Hitshift+tabtocyclebetweendefaultmode,auto-accepteditmode,andplanmode
;⠂ Design backend architecture workflow for AI project
✳ns
;⠐ Design backend architecture workflow for AI project
·
This one needs a moment…
;⠐ Design backend architecture workflow for AI project
Iu
Working through it…
;⠐ Design backend architecture workflow for AI project
✶Iu
8
12 tokens · thought for 14s)
✶730
⏺ Proceeding with C (vertical-slice, covers both) as the default since you haven't narrowed — it's the only option that doesn't lock you in.
  Creating the folder and doc now.
✶ Considering… (17s · ↓ 57 tokens)
  ⎿  Tip: Hit shift+tab to cycle between default mode, auto-accept edit mode, and plan mode
⏺ Bash(mkdir -p /tmp/example/workflow)
  Running…
─────────────────────────────────────
✻ Orchestrating…
✶ Orchestrating…
Use /btw to ask a quick side question without interrupting Claude's current work
✽ Orchestrating… 20
⏺ Write(workflow/development-files.md)
✻ Orchestrating… (57s · ↓233 tokens)
⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt
⏺
  ⎿  Wrote 150 lines to workflow/development-files.md
End goal status: met — folder created, doc inside specifies required development files.`;

    const out = cleanAgentResponse(raw);

    // Signal preserved
    expect(out).toContain("Proceeding with C");
    expect(out).toContain("vertical-slice");
    expect(out).toContain("Creating the folder and doc now.");
    expect(out).toContain("Wrote 150 lines");
    expect(out).toContain("End goal status: met");

    // Noise gone
    expect(out).not.toContain("Design backend architecture workflow for AI project");
    expect(out).not.toContain("Orchestrating");
    expect(out).not.toContain("Infusing");
    expect(out).not.toContain("This one needs a moment");
    expect(out).not.toContain("Working through it");
    expect(out).not.toContain("Considering…");
    expect(out).not.toContain("accept edits on");
    expect(out).not.toContain("Use /btw");
    expect(out).not.toContain("Hit shift");
    expect(out).not.toMatch(/^\s*Tip:/im);
    expect(out).not.toContain("─────");
    // Token-count fragments
    expect(out).not.toMatch(/^\s*\d+\s*tokens/m);
    expect(out).not.toContain("thought for 14s");
  });
});
