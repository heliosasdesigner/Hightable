import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface HightableStoragePaths {
  baseDir: string;
  databasePath: string;
  roomsDir: string;
}

export function getHightableStoragePaths(baseDir = path.join(homedir(), ".heliomodo", "hightable")): HightableStoragePaths {
  return {
    baseDir,
    databasePath: path.join(baseDir, "hightable.sqlite"),
    roomsDir: path.join(baseDir, "rooms"),
  };
}

export function ensureHightableStorage(paths = getHightableStoragePaths()): HightableStoragePaths {
  // 0o700 — these directories hold transcripts, the sqlite DB, and rate-limit
  // records. Keep them user-only so other local accounts can't read them.
  mkdirSync(paths.baseDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.roomsDir, { recursive: true, mode: 0o700 });
  // `mode:` on mkdirSync only takes effect at creation time; a user who
  // ran an earlier build before we set these modes still has 0o755 dirs
  // and 0o644 logs on disk. Explicitly re-chmod on every startup to
  // converge existing installs without disturbing anything else.
  tightenPerms(paths);
  return paths;
}

function tightenPerms(paths: HightableStoragePaths): void {
  chmodIfExists(paths.baseDir, 0o700);
  chmodIfExists(paths.roomsDir, 0o700);
  chmodIfExists(paths.databasePath, 0o600);
  // One level of recursion covers the only structure we create:
  //   <roomsDir>/<roomId>/<agent>.raw.log
  try {
    const rooms = readdirSync(paths.roomsDir, { withFileTypes: true });
    for (const roomEntry of rooms) {
      if (roomEntry.isSymbolicLink()) continue; // never follow symlinks
      const roomPath = path.join(paths.roomsDir, roomEntry.name);
      if (!roomEntry.isDirectory()) continue;
      chmodIfExists(roomPath, 0o700);
      try {
        const files = readdirSync(roomPath, { withFileTypes: true });
        for (const f of files) {
          if (f.isSymbolicLink()) continue;
          if (f.isFile()) chmodIfExists(path.join(roomPath, f.name), 0o600);
        }
      } catch {
        /* swallow per-room errors; startup should not fail for a bad sub-dir */
      }
    }
  } catch {
    /* roomsDir missing or unreadable — nothing to tighten */
  }
}

function chmodIfExists(p: string, mode: number): void {
  try {
    if (!existsSync(p)) return;
    // Guard against following a symlinked entry into an unexpected target.
    const s = statSync(p, { throwIfNoEntry: false });
    if (!s) return;
    chmodSync(p, mode);
  } catch {
    /* swallow — a chmod failure should not block app startup */
  }
}
