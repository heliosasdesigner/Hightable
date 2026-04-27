import { describe, expect, it } from "vitest";
import { detectRateLimit } from "./rate-limit-patterns";

describe("detectRateLimit", () => {
  it("parses a clock expression out of a plan/usage limit message", () => {
    const now = new Date("2026-04-19T09:00:00-04:00");
    const result = detectRateLimit(
      "claude",
      "You've hit your Claude Max usage limit. Resets at 3pm.",
      now,
    );
    expect(result).not.toBeNull();
    expect(result!.agent).toBe("claude");
    expect(result!.until.getHours()).toBe(15);
  });

  it("parses 24-hour time on a plan usage limit message", () => {
    const now = new Date("2026-04-19T09:00:00-04:00");
    const result = detectRateLimit(
      "codex",
      "Your Pro plan usage limit will reset at 14:30",
      now,
    );
    expect(result!.until.getHours()).toBe(14);
    expect(result!.until.getMinutes()).toBe(30);
  });

  it("rolls past times to the next day", () => {
    const now = new Date("2026-04-19T15:00:00-04:00");
    const result = detectRateLimit(
      "claude",
      "Weekly usage limit. Try again at 9:00 am",
      now,
    );
    expect(result).not.toBeNull();
    expect(result!.until.getTime()).toBeGreaterThan(now.getTime());
    expect(result!.until.getDate()).toBe(20);
    expect(result!.until.getHours()).toBe(9);
  });

  it("falls back to +1 hour when no clock is given", () => {
    const now = new Date("2026-04-19T09:00:00-04:00");
    const result = detectRateLimit("claude", "Account usage limit reached.", now);
    expect(result).not.toBeNull();
    const diff = result!.until.getTime() - now.getTime();
    expect(diff).toBeGreaterThan(59 * 60 * 1000);
    expect(diff).toBeLessThan(61 * 60 * 1000);
  });

  it("matches personal-quota phrasing", () => {
    const result = detectRateLimit(
      "codex",
      "You've exceeded your message quota for the hour.",
      new Date(),
    );
    expect(result).not.toBeNull();
  });

  it("does NOT match a sub-service HTTP 429 — that's not a user-quota signal", () => {
    expect(
      detectRateLimit(
        "codex",
        "codebase-retrieval: HTTP error: 429 Too Many Requests",
        new Date(),
      ),
    ).toBeNull();
    expect(
      detectRateLimit("codex", "Remote API returned 429 Too Many Requests.", new Date()),
    ).toBeNull();
  });

  it("does NOT match bare 'rate-limit' wording without a plan/quota context", () => {
    expect(
      detectRateLimit("claude", "The service is currently rate-limited, falling back.", new Date()),
    ).toBeNull();
  });

  it("does not match ordinary mentions of 'rate' or 'limit'", () => {
    expect(detectRateLimit("claude", "The exchange rate moved overnight.", new Date())).toBeNull();
    expect(detectRateLimit("claude", "Limit yourself to one snack.", new Date())).toBeNull();
    expect(detectRateLimit("claude", "Users rate the app highly.", new Date())).toBeNull();
  });
});
