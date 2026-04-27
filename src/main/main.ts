import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { IpcChannels } from "../shared/ipc.js";
import type {
  AgentId,
  AgentRateLimit,
  AgentUsageStats,
  AgentUsageUpdatedEvent,
  ClearAgentRateLimitInput,
  CreateRoomInput,
  ExportRoundInput,
  ExportRoundResult,
  GetRoundInput,
  HightableRoom,
  HightableTerminal,
  MarkRoundCompleteInput,
  PauseRoundInput,
  OpenRoomInput,
  PickDirectoryResult,
  ResetDatabaseResult,
  ResizeTerminalInput,
  RestartTerminalInput,
  RoundDetail,
  SearchTranscriptsInput,
  SendPromptInput,
  SetAgentRateLimitInput,
  SetRoomResumePolicyInput,
  TranscriptSearchResult,
  WriteTerminalInput,
} from "../shared/types.js";
import { roundToMarkdown, suggestRoundFilename } from "./round-exporter.js";
import {
  PtyManager,
  checkAgentBinaries,
  type TerminalDataEvent,
  type TerminalExitEvent,
} from "./pty-manager.js";
import { HightableStore } from "./sqlite-store.js";
import { ensureHightableStorage } from "./storage-paths.js";
import { TranscriptCapture } from "./transcript-capture.js";
import { RoomManager } from "./room-manager.js";
import { OrchestrationManager } from "./orchestration-manager.js";

const storagePaths = ensureHightableStorage();
const store = new HightableStore(storagePaths.databasePath);
const ptyManager = new PtyManager();
const transcript = new TranscriptCapture({ roomsDir: storagePaths.roomsDir });
const roomManager = new RoomManager({ store, ptyManager, transcript });
const orchestration = new OrchestrationManager({ store, ptyManager, roomManager, transcript });

let mainWindow: BrowserWindow | null = null;

/**
 * Resolve the app icon path. In dev we run from the repo root; when
 * packaged, app.getAppPath() points into the asar bundle. `assets/icon.png`
 * is the 1024×1024 master — Electron down-samples as needed for dock /
 * taskbar / window title bar rendering.
 */
function appIconPath(): string {
  return path.join(app.getAppPath(), "assets/icon.png");
}

/**
 * Content-Security-Policy applied to every HTTP response the window
 * loads. In dev we relax it so Vite's HMR websockets + inline scripts
 * work; in the packaged build everything is self-contained so no external
 * origins are allowed. Electron IPC bypasses CSP so `ipcRenderer.invoke`
 * is unaffected.
 *
 * `base-uri 'self'` blocks <base> tag injection (would repoint relative
 * URLs to an attacker origin). `form-action 'self'` blocks form-hijack
 * gadgets. `font-src 'self'` is sufficient now that @fontsource ships
 * the WOFF2 assets as `./assets/*` — no data: URIs in use.
 */
function buildCsp(isDev: boolean): string {
  if (isDev) {
    return [
      "default-src 'self' http://127.0.0.1:5300 ws://127.0.0.1:5300",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://127.0.0.1:5300",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "img-src 'self' data:",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; ");
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/**
 * Strict navigation guard. `startsWith` on a URL is exploitable
 * (e.g. `http://127.0.0.1:5300.attacker.example/` or
 * `http://127.0.0.1:53000/`), and `startsWith("file://")` in the packaged
 * build would let the renderer navigate to any local file. Instead:
 *
 *   - Dev: parse the URL and require an exact origin match against the
 *     dev-server origin.
 *   - Prod: require protocol === "file:" AND the decoded pathname to
 *     live under the packaged renderer's real directory.
 *
 * Any parse error → deny.
 */
function isAllowedNavigation(targetUrl: string, devServerUrl: string | undefined): boolean {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return false;
  }
  if (devServerUrl) {
    let expected: URL;
    try {
      expected = new URL(devServerUrl);
    } catch {
      return false;
    }
    return target.origin === expected.origin;
  }
  if (target.protocol !== "file:") return false;
  // app.getAppPath() resolves to the real path of the packaged renderer
  // (inside the asar bundle at runtime). Adding `path.sep` prevents a
  // sibling directory whose name shares a prefix from slipping through.
  const appRoot = path.join(app.getAppPath(), "dist/renderer") + path.sep;
  let pathname: string;
  try {
    pathname = decodeURIComponent(target.pathname);
  } catch {
    return false;
  }
  return pathname.startsWith(appRoot);
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 720,
    title: "Hightable",
    // Window icon — used by Windows and Linux title bars. macOS uses the
    // dock icon set below in app.whenReady().
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Preload is sandboxed — it only uses `electron`'s contextBridge +
      // ipcRenderer (built-ins). The IpcChannels string map is inlined in
      // the preload itself to avoid a non-built-in require(), which would
      // fail under sandbox: true.
      sandbox: true,
      webSecurity: true,
    },
  });

  const devServerUrl = process.env["VITE_DEV_SERVER_URL"];

  // Apply CSP to every response served to this window.
  mainWindow.webContents.session.webRequest.onHeadersReceived(
    (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [buildCsp(!!devServerUrl)],
        },
      });
    },
  );

  // Navigation guard — the renderer is only ever allowed to stay on its
  // own origin (the dev server in dev, the packaged renderer directory in
  // prod). `isAllowedNavigation` does proper URL parsing + origin/root
  // comparison; any other navigation is blocked and (for http/https
  // links) handed off to the OS default browser.
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedNavigation(targetUrl, devServerUrl)) {
      event.preventDefault();
      console.warn(`[hightable] blocked navigation: ${targetUrl}`);
      if (/^https?:\/\//i.test(targetUrl)) void shell.openExternal(targetUrl);
    }
  });

  // New-window / target=_blank / window.open — always blocked inside
  // Electron; http(s) URLs open in the OS browser, others are dropped.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(app.getAppPath(), "dist/renderer/index.html"));
  }

  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL) => {
      console.error(
        `[hightable] renderer did-fail-load: ${errorCode} ${errorDescription} (${validatedURL})`,
      );
    },
  );

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[hightable] renderer gone: ${details.reason} (exit ${details.exitCode})`);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function broadcast<T>(channel: string, payload: T): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

ptyManager.onData((event: TerminalDataEvent) => {
  broadcast(IpcChannels.TerminalData, event);
});

ptyManager.onExit((event: TerminalExitEvent) => {
  broadcast(IpcChannels.TerminalExit, event);
});

orchestration.onRoundUpdate((event) => {
  broadcast(IpcChannels.RoundUpdated, event);
  // A finished prompt always changes usage counts; push fresh stats so every
  // renderer's pill updates without a re-fetch.
  broadcastAgentUsage();
});

orchestration.onRoundProgress((event) => {
  broadcast(IpcChannels.RoundProgress, event);
});

// Auto-detection of rate limits from PTY output is temporarily disabled —
// without known-good CLI error samples to train against, the best-effort
// regex patterns produced too many false positives (including on agent-
// generated text that *discussed* quota concepts). The patterns and
// transcript scanner stay in place; re-enable this subscription when we've
// captured the actual error phrases emitted by the two CLIs.
//
// Users set limits manually via the topbar pill in the meantime.
//
// transcript.onRateLimit((event) => { … });

function computeAgentUsage(): AgentUsageStats[] {
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfWeek = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const agents: AgentId[] = ["claude", "codex"];
  return agents.map((agent) => {
    const limit = store.getActiveRateLimit(agent);
    return {
      agent,
      today: store.countPromptsSince(agent, startOfToday.toISOString()),
      week: store.countPromptsSince(agent, startOfWeek.toISOString()),
      limitedUntil: limit?.limitedUntil,
      note: limit?.note,
    };
  });
}

function broadcastAgentUsage(): void {
  const event: AgentUsageUpdatedEvent = { usage: computeAgentUsage() };
  broadcast(IpcChannels.AgentUsageUpdated, event);
}

ipcMain.handle(IpcChannels.ListRooms, () => roomManager.listRooms());

ipcMain.handle(
  IpcChannels.CreateRoom,
  (_event: IpcMainInvokeEvent, input: CreateRoomInput) => roomManager.createRoom(input),
);

ipcMain.handle(
  IpcChannels.OpenRoom,
  (_event: IpcMainInvokeEvent, input: OpenRoomInput) => roomManager.openRoom(input.roomId),
);

ipcMain.handle(
  IpcChannels.GetRound,
  (_event: IpcMainInvokeEvent, input: GetRoundInput): RoundDetail => {
    const round = store.getRound(input.roundId);
    if (!round) throw new Error(`Round not found: ${input.roundId}`);
    const messages = store.listMessages(input.roundId);
    return { round, messages };
  },
);

ipcMain.handle(
  IpcChannels.SearchTranscripts,
  (_event: IpcMainInvokeEvent, input: SearchTranscriptsInput): TranscriptSearchResult[] => {
    // Hard cap to prevent a renderer-side bug from asking the store to
    // materialise an unbounded result set into memory.
    const clamped = Math.max(1, Math.min(input.limit ?? 50, 200));
    return store.searchTranscripts(input.query, clamped);
  },
);

ipcMain.handle(
  IpcChannels.PickDirectory,
  async (_event: IpcMainInvokeEvent): Promise<PickDirectoryResult> => {
    const target = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
    const result = target
      ? await dialog.showOpenDialog(target, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    return { canceled: false, path: result.filePaths[0] };
  },
);

// Max bytes the renderer can push to a PTY in a single IPC message. A runaway
// paste or a bug in the xterm handler should not be able to flood the child
// process (or block the main process) with unbounded input.
const MAX_WRITE_TERMINAL_BYTES = 1 << 20; // 1 MiB

ipcMain.handle(
  IpcChannels.WriteTerminal,
  (_event: IpcMainInvokeEvent, input: WriteTerminalInput): void => {
    const data =
      input.data.length > MAX_WRITE_TERMINAL_BYTES
        ? input.data.slice(0, MAX_WRITE_TERMINAL_BYTES)
        : input.data;
    ptyManager.write(input.terminalId, data);
  },
);

ipcMain.handle(
  IpcChannels.ResizeTerminal,
  (_event: IpcMainInvokeEvent, input: ResizeTerminalInput): void => {
    ptyManager.resize(input.terminalId, input.cols, input.rows);
  },
);

ipcMain.handle(
  IpcChannels.SendPrompt,
  (_event: IpcMainInvokeEvent, input: SendPromptInput) => orchestration.sendPrompt(input),
);

ipcMain.handle(
  IpcChannels.MarkRoundComplete,
  (_event: IpcMainInvokeEvent, input: MarkRoundCompleteInput) =>
    orchestration.markRoundComplete(input.roundId),
);

ipcMain.handle(
  IpcChannels.PauseRound,
  (_event: IpcMainInvokeEvent, input: PauseRoundInput) =>
    orchestration.pauseRound(input.roundId),
);

ipcMain.handle(
  IpcChannels.ExportRound,
  async (_event: IpcMainInvokeEvent, input: ExportRoundInput): Promise<ExportRoundResult> => {
    const round = store.getRound(input.roundId);
    if (!round) throw new Error(`Round not found: ${input.roundId}`);
    const messages = store.listMessages(input.roundId);
    const detail: RoundDetail = { round, messages };
    const markdown = roundToMarkdown(detail);
    const suggested = suggestRoundFilename(detail);
    const target = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
    const saveOptions = {
      title: "Export round as Markdown",
      defaultPath: suggested,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    };
    const result = target
      ? await dialog.showSaveDialog(target, saveOptions)
      : await dialog.showSaveDialog(saveOptions);
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.writeFile(result.filePath, markdown, "utf8");
    return { canceled: false, path: result.filePath };
  },
);

ipcMain.handle(
  IpcChannels.RestartTerminal,
  (_event: IpcMainInvokeEvent, input: RestartTerminalInput): HightableTerminal => {
    return roomManager.restartTerminal(input.terminalId, { resume: input.resume });
  },
);

ipcMain.handle(
  IpcChannels.SetRoomResumePolicy,
  (_event: IpcMainInvokeEvent, input: SetRoomResumePolicyInput): HightableRoom => {
    return store.setRoomResumePolicy(input.roomId, input.resumeOnOpen);
  },
);

ipcMain.handle(
  IpcChannels.ResetDatabase,
  async (): Promise<ResetDatabaseResult> => {
    // Tear down live state first so writes can't race the wipe. The
    // orchestration pending map must be cleared too — otherwise any
    // in-flight inactivity timer will try to write a message for a
    // round that no longer exists and throw an FK error.
    orchestration.clearAll();
    ptyManager.killAll();
    transcript.closeAll();
    const { roomsDeleted } = store.resetAll();
    // Remove the per-room transcript raw-log directories so "reset" really
    // erases history on disk, not just in sqlite.
    let rawLogsDeleted = 0;
    try {
      const rootReal = await fs.realpath(storagePaths.roomsDir);
      // Use a Dirent listing so we can check for symlinks explicitly and
      // never follow them. `fs.rm recursive: true` would otherwise traverse
      // a malicious symlink out of the rooms directory and delete the target.
      const entries = await fs.readdir(rootReal, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          // Unlink the symlink itself — do not follow it.
          try {
            await fs.unlink(path.join(rootReal, entry.name));
            rawLogsDeleted += 1;
          } catch {
            /* swallow */
          }
          continue;
        }
        const candidate = path.resolve(rootReal, entry.name);
        // Containment check: candidate must live strictly under rootReal.
        const rel = path.relative(rootReal, candidate);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          console.warn(
            `[hightable] reset: refusing to delete out-of-root entry ${candidate}`,
          );
          continue;
        }
        await fs.rm(candidate, { recursive: true, force: true });
        rawLogsDeleted += 1;
      }
    } catch (err) {
      console.warn(`[hightable] reset: transcript cleanup failed: ${(err as Error).message}`);
    }
    broadcastAgentUsage();
    return { roomsDeleted, rawLogsDeleted };
  },
);

ipcMain.handle(IpcChannels.GetAgentUsage, (): AgentUsageStats[] => computeAgentUsage());

ipcMain.handle(
  IpcChannels.SetAgentRateLimit,
  (_event: IpcMainInvokeEvent, input: SetAgentRateLimitInput): AgentRateLimit => {
    if (!input.limitedUntil) throw new Error("limitedUntil is required");
    if (Number.isNaN(new Date(input.limitedUntil).getTime())) {
      throw new Error("limitedUntil is not a valid ISO timestamp");
    }
    const saved = store.createRateLimit({
      agent: input.agent,
      limitedUntil: input.limitedUntil,
      note: input.note,
    });
    broadcastAgentUsage();
    return saved;
  },
);

ipcMain.handle(
  IpcChannels.ClearAgentRateLimit,
  (_event: IpcMainInvokeEvent, input: ClearAgentRateLimitInput): void => {
    store.clearRateLimits(input.agent);
    broadcastAgentUsage();
  },
);

void app.whenReady().then(() => {
  // macOS: the window `icon` option doesn't affect the dock — we need to
  // set it explicitly via app.dock.setIcon(). On Windows/Linux the window
  // icon option above already covers the taskbar.
  if (process.platform === "darwin") {
    try {
      const img = nativeImage.createFromPath(appIconPath());
      if (!img.isEmpty()) app.dock?.setIcon(img);
    } catch (err) {
      console.warn(`[hightable] dock icon set failed: ${(err as Error).message}`);
    }
  }

  const binaries = checkAgentBinaries();
  for (const status of Object.values(binaries)) {
    if (status.found) {
      console.log(`[hightable] ${status.name} found at ${status.path}`);
    } else {
      console.warn(`[hightable] ${status.name} not found on PATH`);
    }
  }

  // One-time cleanup: the disabled auto-detector left some false-positive
  // rate-limit rows. Clear anything whose note starts with "auto-detected"
  // so the topbar pills reset on launch. Manual entries are untouched.
  const cleared = store.clearRateLimitsWhereNoteLike("auto-detected%");
  if (cleared > 0) console.log(`[hightable] cleared ${cleared} stale auto-detected rate limits`);

  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  ptyManager.killAll();
  transcript.closeAll();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  ptyManager.killAll();
  transcript.closeAll();
});
