import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HightableStore } from "./sqlite-store";

function createTestStore(): HightableStore {
  const dir = mkdtempSync(path.join(tmpdir(), "hightable-store-"));
  return new HightableStore(path.join(dir, "hightable.sqlite"));
}

describe("HightableStore", () => {
  it("initializes the expected tables", () => {
    const store = createTestStore();

    expect(store.listTableNames()).toEqual([
      "artifacts",
      "messages",
      "rate_limits",
      "rooms",
      "rounds",
      "terminals",
    ]);
  });

  it("creates and lists rooms in most recently used order", () => {
    const store = createTestStore();

    const first = store.createRoom({
      name: "Example Router",
      repoPath: "/tmp/example-router",
      topic: "Router review",
    });
    const second = store.createRoom({
      name: "Example Hub",
      repoPath: "/tmp/example-hub",
    });

    expect(store.listRooms()).toEqual([second, first]);
  });

  it("updates terminal status", () => {
    const store = createTestStore();
    const room = store.createRoom({
      name: "Example Repo",
      repoPath: "/tmp/example-repo",
    });
    const terminal = store.createTerminal({
      roomId: room.id,
      agent: "codex",
      command: "codex --no-alt-screen -C /tmp/example-repo",
      cwd: "/tmp/example-repo",
      status: "starting",
    });

    const updated = store.updateTerminalStatus(terminal.id, "idle");

    expect(updated.status).toBe("idle");
    expect(store.listTerminals(room.id)).toEqual([updated]);
  });

  it("creates and completes rounds", () => {
    const store = createTestStore();
    const room = store.createRoom({
      name: "Hightable",
      repoPath: "/tmp/example-hightable",
    });
    const round = store.createRound({
      roomId: room.id,
      mode: "compare",
      target: "both",
      prompt: "Compare the architecture.",
      status: "running",
    });

    const completed = store.completeRound(round.id);

    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toEqual(expect.any(String));
    expect(store.listRounds(room.id)).toEqual([completed]);
  });
});
