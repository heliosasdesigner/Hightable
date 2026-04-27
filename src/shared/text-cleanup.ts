/**
 * Cleanup pipeline for agent response text captured from an interactive TUI.
 *
 * Used in three places:
 *   - orchestration (write-time): scrub before saving messages to sqlite
 *   - exporter (read-time): defence-in-depth on older rows and a second pass
 *   - drawer (render-time): make legacy rows readable without a migration
 *
 * Order: residual scrub (inline artifacts) → per-line noise filter → dedup.
 */

/**
 * Strip artifacts that survive ANSI stripping when escape sequences straddle
 * PTY chunk boundaries — the opening ESC gets eaten but the tail remains.
 *
 * Also drops Unicode Control/Format/Private-use/Surrogate-category chars
 * (everything in `\p{C}` except TAB, LF, CR) — these include BOMs, zero-
 * width joiners, bidi marks, C1 controls, and the other invisible bytes
 * that can slip past ANSI stripping and confuse xterm's parser or clutter
 * the stored text. Keeps all letters, digits, punctuation, symbols, marks,
 * and CJK intact.
 */
export function scrubResiduals(text: string): string {
  return text
    // Strip Unicode "other" categories except the three whitespace controls
    // (TAB, LF, CR) that carry real formatting intent for the text.
    .replace(/\p{C}/gu, (m) => (m === "\t" || m === "\n" || m === "\r" ? m : ""))
    // OSC title-bar updates: ESC]0;<title>ESC\ → after ESC strip we see
    // remnants like `;⠏ Project-Docs\` (spinner glyph + title + trailing \).
    .replace(/;[\u2800-\u28FF][^\r\n]*?\\/g, "")
    // Orphan CSI SGR fragments with the opening [ intact: `[39;48;5;235m`.
    .replace(/\[\d{1,3}(?:;\d{1,3})*m/g, "")
    // Orphan CSI SGR fragments that lost the [ too: `9;48;5;235m`.
    // Requires 3+ numeric groups to avoid eating normal prose like "5m later".
    .replace(/\b\d{1,3}(?:;\d{1,3}){2,}m\b/g, "")
    // HM_RUN markers wherever they appear (not just edges).
    .replace(/\[HM_RUN_(?:BEGIN|DONE):[0-9a-fA-F\-\s]+\]/g, "")
    // `[Pasted Content 1234 chars]` / `[Pasted text]` paste placeholders.
    .replace(/\[Pasted(?:\s+(?:text|Content))?[^\]]*\]/gi, "")
    // Trailing "text: " / "other text: " token from prompt echo (the rest of
    // the line — typically the HM_RUN tag — is stripped separately above).
    .replace(/\b(?:other\s+)?text:\s*$/gim, "");
}

const TUI_NOISE_LINE = [
  /^[\s\u2800-\u28FF;\u00a0]*$/, // whitespace / braille / NBSP only
  /^─{4,}\s*$/,
  /^\s*esc\s*to\s*interrupt\s*$/i,
  // Status verbs — Anthropic rotates the vocabulary frequently; cover bare
  // lines and spinner-prefixed variants like "✻ Roosting…".
  // Status verbs shown as "✳ Roosting…" / "Orchestrating…". Anchored to
  // end-of-line so prose that happens to START with one of these verbs
  // (e.g. "Creating the folder and doc now.") is preserved.
  /^\s*[✢✳✶✻✽·⏺]?\s*(Ionizing|Nebulizing|Sautéed|Churned|Caramelizing|Roosting|Shimmying|Transfiguring|Simmering|Percolating|Marinating|Fermenting|Spicing|Brewing|Steeping|Whisking|Frothing|Kneading|Proofing|Noodling|Pondering|Mulling|Stewing|Ruminating|Cogitating|Deliberating|Reasoning|Computing|Creating|Exploring|Thinking|Reviewing|Running|Philosophising|Analyzing|Designing|Processing|Loading|Generating|Orchestrating|Infusing|Considering|Scheming|Strategizing|Engineering|Composing|Assembling)[.…\s]*$/i,
  // Same verb followed by a parenthetical time/token counter:
  //   "Orchestrating… (57s · ↓233 tokens)" — one regex, verb + status paren.
  /^\s*[✢✳✶✻✽·⏺]?\s*(Orchestrating|Considering|Infusing|Roosting|Philosophising|Transfiguring|Analyzing|Designing|Processing|Running|Generating)…?\s*\([^)]*tokens?[^)]*\)\s*$/i,
  // Verb followed by a trailing digit counter: "✽ Orchestrating… 20".
  /^\s*[✢✳✶✻✽·⏺]?\s*(Orchestrating|Considering|Infusing|Roosting|Philosophising|Transfiguring|Analyzing|Designing|Processing|Running|Generating)…?\s*\d+\s*$/i,
  // Spinner glyph glued to digits with no space: "✶730", "·608", "✢820".
  /^\s*[✢✳✶✻✽·⏺]+\d+\s*$/,
  /thinking with high effort/i,
  // "... thought for 14s" with or without matching parens
  /thought for \d+\s*s\)?/i,
  // Multi-word status sentences that end with ellipsis
  /^\s*(This one needs a moment|Working through it|Thinking it through|Gathering context|Figuring this out|One moment)…\s*$/i,
  /^\s*\(\d+\s*s\s*·\s*[↑↓].*tokens?\s*\)\s*$/i,
  /\besc to interrupt\b/i,
  /^\s*❯\s*$/,
  /^\s*[✢✳✶✻✽·⏺↑↓]\s*$/,
  /^\s*│.*│\s*$/,
  /^\s*╭[─╮]*$/,
  /^\s*╰[─╯]*$/,
  /^\s*\[Pasted\b/,
  /^\s*ctrl\+[a-z]\s*.*\bto\s+[a-z]/i,
  /\bWelcome back\b/,
  /^\s*Opus\s+\d/,
  /^\s*Claude\s+Code\s+v?\d/,
  /^\s*Recent activity\s*$/,
  /^\s*Tips for getting\s*$/,
  // Bare `user@host` lines (login / prompt banners) — generic match so
  // no specific address is baked into the binary.
  /^\s*[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\s*$/,
  // Shell-prompt lines ending in $, %, or ❯ (`~/path/to/thing $`).
  /^\s*~\/[^\r\n]{1,200}\s*[$%❯>]\s*$/,
  /^\s*Do you want to proceed\??/i,
  /^\s*\d\.\s*(Yes(,\s*allow.*)?|No)\s*$/i,
  /^\s*❯?\s*Yes(,\s*allow)?\b/i,
  /^\s*Esc\s*to\s*cancel/i,
  /^\s*Tab\s*to\s*amend/i,
  /^\s*[↑↓]\s*\d+\s*(tokens?)?\s*$/,
  /^\s*\d+\s*$/,
  /^\s*(Bash|Shell)\s+command\s*$/i,
  /^[\s\u2800-\u28FF;·⏺✢✳✶✻✽]+[A-Za-z]{1,3}\s*$/,
  // Title-bar lines on their own: `;⠏ Project-Docs\`, `;⠏ Design backend…`
  /^\s*;[\u2800-\u28FF][^\r\n]*$/,
  // Title-bar run with two updates on one line, no trailing backslash.
  /;[\u2800-\u28FF][^;]{3,}.*;[\u2800-\u28FF]/,
  // Claude Code banner fragments
  /^\s*╭.*Claude\s*Code.*╮?\s*$/i,
  // Pure "Running" / "Exploring" / tool-call status chrome
  /^\s*[•·⏺]\s*(Explored|Findings|Running|Read)\b/i,
  // Contextual tip feed with or without the L-shaped leader char.
  /^\s*⎿?\s*Tip:\s/i,
  // The tip body sometimes arrives on its own line (no "Tip:" prefix) when
  // xterm redraws flush separately — match the canonical sentence stem.
  /\bUse\s*\/btw\s*to\s*ask\s*a\s*quick\s*side\s*question/i,
  /\bHit\s*shift\+?tab\s*to\s*cycle\s*between/i,
  // MCP / plugin load chatter
  /\bMCP\s+server\s+(failed|connected|disconnected|starting)/i,
  /^\s*\/mcp\s*$/i,
  /^\s*Successfully\s+loaded/i,
  // Claude Code mode indicator strip at the bottom.
  /^\s*⏵⏵?\s*accept\s+edits/i,
  // Standalone token-count fragments: "12 tokens · thought for 14s)",
  // "✶ 1m 0s· ↓ 770 tokens", "✢ 1.0k tokens)".
  /^\s*[✢✳✶✻✽·⏺↑↓]?\s*\d+(?:\.\d+)?k?\s*tokens?\)?\s*$/i,
  /^\s*[✢✳✶✻✽·⏺↑↓]?\s*\d+m\s*\d+s.*tokens?\)?/i,
  // Bash tool-call scaffolding
  /^\s*\$\s*ls\s/,
  /^\s*Running…\s*$/i,
  // Lone spinner-glyph + 1–6 char fragment: `✳h`, `✢ho`, `Pl`, `sohi`, `Phg…`
  /^\s*[✢✳✶✻✽·⏺]*\s*[A-Za-z]{1,6}[…\s]*$/,
  // Mid-word redraw frames with sparse vowels: `sg20`, `sh8`, `·sg20`, `Pl3`
  /^\s*[·⏺✢✳✶✻✽]*\s*[A-Za-z]{1,4}\d+\s*$/,
];

const SPINNER_GLYPHS_RE = /[\s\u2800-\u28FF;·⏺✢✳✶✻✽↑↓…]/g;

function looksLikeFragment(line: string): boolean {
  const stripped = line.replace(SPINNER_GLYPHS_RE, "");
  if (stripped.length === 0) return true;
  const alphanumCount = (stripped.match(/[A-Za-z0-9]/g) ?? []).length;
  if (alphanumCount < 3) return true;
  if (!/[A-Za-z0-9]{3,}/.test(stripped)) return true;
  return false;
}

function looksLikeNoise(line: string): boolean {
  if (TUI_NOISE_LINE.some((pattern) => pattern.test(line))) return true;
  return looksLikeFragment(line);
}

function stripTuiNoise(text: string): string {
  const kept: string[] = [];
  let lastKept = "";
  for (const line of text.split("\n")) {
    if (looksLikeNoise(line)) continue;
    const normalized = line.replace(/\s+/g, " ").trim();
    if (!normalized) {
      if (kept.length > 0 && kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    if (normalized === lastKept) continue;
    kept.push(line.trimEnd());
    lastKept = normalized;
  }
  return collapsePrefixFrames(kept).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Stripping ANSI from a TUI that uses cursor movement leaves every partial
 * draw frame as its own line: `Pl` → `Philos` → `Philosophising…`. Since
 * each earlier frame is a prefix (by compressed content) of the next, we
 * drop any line whose compressed form is a prefix of the following line's.
 * Iterates once — that's enough for the typical frame count, and avoids
 * pathological O(n²) behaviour on long responses.
 */
function collapsePrefixFrames(lines: string[]): string[] {
  const compress = (s: string): string =>
    s.replace(/[\s\u2800-\u28FF·⏺✢✳✶✻✽↑↓…]/g, "").toLowerCase();
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    const next = lines[i + 1];
    if (next) {
      const curC = compress(cur);
      const nextC = compress(next);
      // Require the shorter to be a real prefix and have at least a couple
      // of chars — empty or single-char prefixes would false-positive drop
      // legitimate short lines.
      if (
        curC.length >= 2 &&
        curC.length < nextC.length &&
        nextC.startsWith(curC)
      ) {
        continue;
      }
    }
    result.push(cur);
  }
  return result;
}

/**
 * Full cleanup pipeline: strip marker scaffolding, scrub residual ANSI /
 * OSC / paste placeholders, then filter TUI-redraw lines and collapse
 * consecutive duplicates.
 */
export function cleanAgentResponse(raw: string): string {
  const demarkered = raw
    .replace(/^\s*\[HM_RUN_BEGIN:[^\]]+\]\s*\n?/, "")
    .replace(/^[^\n]*When your final response is complete[^\n]*\n?/gm, "")
    .replace(/\n?[ \t]*\[HM_RUN_DONE:[^\]]+\][ \t]*$/, "");
  const scrubbed = scrubResiduals(demarkered);
  return stripTuiNoise(scrubbed);
}

/**
 * Continuation prompts embed the previous response. When that response
 * itself contains a `<last_response>` / `<primary_response>` block from a
 * still-earlier continuation, the text grows quadratically. Collapse those
 * nested blocks so only the most recent substantive content is carried.
 */
export function collapseEmbeddedContext(prompt: string): string {
  return prompt
    .replace(
      /<last_response>[\s\S]*?<\/last_response>/g,
      "<last_response>…(prior response omitted — see preceding round)…</last_response>",
    )
    .replace(
      /<primary_response>[\s\S]*?<\/primary_response>/g,
      "<primary_response>…(omitted — see preceding round)…</primary_response>",
    )
    .replace(
      /<revised_response>[\s\S]*?<\/revised_response>/g,
      "<revised_response>…(omitted — see preceding round)…</revised_response>",
    );
}
