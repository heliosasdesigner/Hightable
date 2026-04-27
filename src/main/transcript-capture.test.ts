import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TranscriptCapture, type MarkerEvent } from "./transcript-capture";
import type { HightableTerminal } from "../shared/types";

function makeCapture(): TranscriptCapture {
  const dir = mkdtempSync(path.join(tmpdir(), "hightable-transcript-"));
  return new TranscriptCapture({ roomsDir: dir });
}

function makeTerminal(id: string, agent: "claude" | "codex"): HightableTerminal {
  return {
    id,
    roomId: "room-1",
    agent,
    command: `${agent} --no-alt-screen`,
    cwd: "/tmp",
    status: "idle",
    startedAt: new Date().toISOString(),
  };
}

describe("TranscriptCapture markers", () => {
  it("emits a done event for a marker in a single chunk", () => {
    const capture = makeCapture();
    const terminal = makeTerminal("t1", "claude");
    capture.attach(terminal);

    const events: MarkerEvent[] = [];
    capture.onMarker((e) => events.push(e));

    const id = "abcd1234-1234-1234-1234-abcdef012345";
    capture.append("t1", `some output before\n[HM_RUN_DONE:${id}]\ntrailing\n`);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      terminalId: "t1",
      agent: "claude",
      kind: "done",
      markerId: id,
    });
  });

  it("emits begin then done across two chunks and returns cleaned text between them", () => {
    const capture = makeCapture();
    capture.attach(makeTerminal("t1", "claude"));

    const events: MarkerEvent[] = [];
    capture.onMarker((e) => events.push(e));

    const id = "0000aaaa-bbbb-cccc-dddd-eeeeffff0000";
    // ANSI color codes interleaved to verify stripping.
    capture.append("t1", `\u001b[32m[HM_RUN_BEGIN:${id}]\u001b[0m\n`);
    const beginOffset = capture.snapshotOffset("t1");
    capture.append("t1", "Answer line 1.\n");
    capture.append("t1", `Answer line 2.\n[HM_RUN_DONE:${id}]\n`);

    expect(events.map((e) => e.kind)).toEqual(["begin", "done"]);
    const doneOffset = events[1]!.bufferOffset;
    const cleaned = capture.getCleanedSlice("t1", beginOffset, doneOffset);
    expect(cleaned).toBe("Answer line 1.\nAnswer line 2.");
  });

  it("handles a marker split across append boundaries", () => {
    const capture = makeCapture();
    capture.attach(makeTerminal("t1", "codex"));

    const events: MarkerEvent[] = [];
    capture.onMarker((e) => events.push(e));

    const id = "11112222-3333-4444-5555-666677778888";
    capture.append("t1", `working...\n[HM_RUN_DO`);
    capture.append("t1", `NE:${id}]\n`);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "done", markerId: id });
  });

  it("matches a marker with CR/LF line endings (Claude Code uses \\r\\r\\n)", () => {
    const capture = makeCapture();
    capture.attach(makeTerminal("t1", "claude"));

    const events: MarkerEvent[] = [];
    capture.onMarker((e) => events.push(e));

    capture.append("t1", "Want me to fix that?\r\r\n\r\r\n[HM_RUN_DONE:e3f67e3c]\r\r\n");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "done", markerId: "e3f67e3c" });
  });

  it("matches a short marker id that wraps across two lines in a narrow pane", () => {
    const capture = makeCapture();
    capture.attach(makeTerminal("t1", "claude"));

    const events: MarkerEvent[] = [];
    capture.onMarker((e) => events.push(e));

    // Simulates Claude Code wrapping "[HM_RUN_DONE:9d5b36d4]" in a narrow pane
    // where the closing bracket ends up on its own line.
    capture.append("t1", "Answer text.\n[HM_RUN_DONE:9d5b36\nd4]\n");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "done",
      markerId: "9d5b36d4",
    });
  });

  it("does not re-emit a marker that was already reported on a prior append", () => {
    const capture = makeCapture();
    capture.attach(makeTerminal("t1", "claude"));

    const events: MarkerEvent[] = [];
    capture.onMarker((e) => events.push(e));

    const id = "aaaabbbb-ccc0-ccc0-ccc0-ddddeeeeffff";
    capture.append("t1", `[HM_RUN_DONE:${id}]\n`);
    capture.append("t1", "more output unrelated to markers\n");

    expect(events).toHaveLength(1);
  });
});
