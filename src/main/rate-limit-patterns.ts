import type { AgentId } from "../shared/types.js";

export interface RateLimitDetection {
  agent: AgentId;
  until: Date;
  note: string;
  /** The raw text fragment that triggered the detection (for display only). */
  match: string;
}

interface RateLimitPattern {
  /** Match shape — scans the recent cleaned-text region. */
  regex: RegExp;
  /** Extract a reset time from the match, or null if the pattern has no time clue. */
  parseReset?: (match: RegExpMatchArray) => Date | null;
  /** Short human-readable note saved with the rate-limit row. */
  note: string;
}

const DEFAULT_RATE_LIMIT_MS = 60 * 60 * 1000; // 1 hour

/**
 * Pattern list ordered from most specific to most generic. We only match
 * phrases that clearly refer to the CLI's *own* usage / plan / quota — not
 * sub-service errors (a tool call that returned HTTP 429 doesn't mean the
 * agent is out of its user quota).
 *
 * Best-effort and conservative; the user can always set a limit manually from
 * the topbar pill.
 */
const PATTERNS: RateLimitPattern[] = [
  // Explicit plan/usage limit with a reset time.
  // "You've hit your Claude Max usage limit. Resets at 3pm."
  // "Your Pro plan usage limit will reset at 14:30"
  {
    regex:
      /(?:(?:claude\s+)?max|pro|plus|account|plan|weekly|monthly|daily)[^\n]{0,20}(?:usage|quota)[^\n]{0,20}limit[^\n]{0,80}?(?:reset(?:s)?\s+at|available again at|try again at)\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm|AM|PM)?(?:\s*(?:UTC|utc|GMT|gmt|Z))?)/i,
    parseReset: (m) => parseClockExpression(m[1]),
    note: "auto-detected plan usage limit (parsed reset time)",
  },
  // Explicit plan/usage limit without a time clue.
  // "You've hit your weekly usage limit."
  // "Account usage limit reached."
  {
    regex:
      /(?:(?:claude\s+)?max|pro|plus|account|plan|weekly|monthly|daily)[^\n]{0,20}(?:usage|quota)[^\n]{0,20}limit/i,
    note: "auto-detected plan usage limit (default +1 hour)",
  },
  // "You have reached / hit / exceeded your (usage|message|request|token) quota / limit"
  {
    regex:
      /(?:you['’]?ve |you have )(?:hit|reached|exceeded)[^\n]{0,30}your[^\n]{0,30}(?:usage|quota|(?:message|request|token)[^\n]{0,10}limit)/i,
    note: "auto-detected personal quota exceeded (default +1 hour)",
  },
];

export function detectRateLimit(
  agent: AgentId,
  cleanedText: string,
  now: Date = new Date(),
): RateLimitDetection | null {
  for (const pattern of PATTERNS) {
    const m = cleanedText.match(pattern.regex);
    if (!m) continue;
    const parsed = pattern.parseReset ? pattern.parseReset(m) : null;
    const until = parsed ?? new Date(now.getTime() + DEFAULT_RATE_LIMIT_MS);
    return {
      agent,
      until,
      note: pattern.note,
      match: m[0].trim(),
    };
  }
  return null;
}

/**
 * Parse a clock expression like "3pm", "15:00", "9:30 am UTC". Anchored to
 * today; if the result has already passed today, roll to tomorrow.
 */
function parseClockExpression(expr: string): Date | null {
  const trimmed = expr.trim();
  const match = trimmed.match(
    /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(utc|gmt|z)?$/i,
  );
  if (!match) return null;
  let hour = Number.parseInt(match[1], 10);
  const minute = match[2] ? Number.parseInt(match[2], 10) : 0;
  const meridiem = match[3]?.toLowerCase();
  const utc = Boolean(match[4]);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  const now = new Date();
  const target = new Date(now);
  if (utc) {
    target.setUTCHours(hour, minute, 0, 0);
  } else {
    target.setHours(hour, minute, 0, 0);
  }
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}
