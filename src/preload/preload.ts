import { contextBridge, ipcRenderer } from "electron";
/*
 * IpcChannels is INLINED here rather than imported from "../shared/ipc.js"
 * because this preload runs under `sandbox: true` — only the "electron"
 * module and Node built-ins are allowed to be required at runtime. The
 * type-only import below acts as a compile-time sync check: if the two
 * maps drift, TypeScript fails the `_IpcChannelsSync` assignment.
 *
 *  KEEP IN SYNC WITH src/shared/ipc.ts
 */
import type * as SharedIpc from "../shared/ipc.js";
const IpcChannels = {
  CreateRoom: "hightable:room:create",
  ListRooms: "hightable:room:list",
  OpenRoom: "hightable:room:open",
  GetRound: "hightable:round:get",
  SearchTranscripts: "hightable:transcripts:search",
  GetAgentUsage: "hightable:agent:get-usage",
  SetAgentRateLimit: "hightable:agent:set-rate-limit",
  ClearAgentRateLimit: "hightable:agent:clear-rate-limit",
  AgentUsageUpdated: "hightable:agent:usage-updated",
  PickDirectory: "hightable:dialog:pick-directory",
  WriteTerminal: "hightable:terminal:write",
  ResizeTerminal: "hightable:terminal:resize",
  TerminalData: "hightable:terminal:data",
  TerminalExit: "hightable:terminal:exit",
  SendPrompt: "hightable:prompt:send",
  MarkRoundComplete: "hightable:round:mark-complete",
  PauseRound: "hightable:round:pause",
  ExportRound: "hightable:round:export",
  RestartTerminal: "hightable:terminal:restart",
  SetRoomResumePolicy: "hightable:room:set-resume-policy",
  ResetDatabase: "hightable:app:reset-database",
  RoundUpdated: "hightable:round:updated",
  RoundProgress: "hightable:round:progress",
} as const;
// Compile-time guard: if channels are added/removed/renamed on either
// side without matching the other, this assignment fails typecheck.
//
// Object types use width subtyping — `X extends Y` means X has at least
// all of Y's properties (X's key set is a superset of Y's). Reasoning
// about which branch maps to which drift direction:
//
//   outer `Shared extends Preload` FALSE
//     → Shared does NOT have all of Preload's keys
//     → Preload has keys Shared doesn't
//     → preload has EXTRA entries
//
//   outer TRUE, inner `Preload extends Shared` FALSE
//     → Preload does NOT have all of Shared's keys
//     → Shared has keys Preload doesn't
//     → preload is MISSING entries
//
// If you are staring at a cryptic TS error involving `_IpcChannelsSync`
// or `_ipcSync`, `src/shared/ipc.ts` and the inlined `IpcChannels` above
// have drifted. The error string points at which side needs updating.
type _IpcChannelsSync = typeof SharedIpc.IpcChannels extends typeof IpcChannels
  ? typeof IpcChannels extends typeof SharedIpc.IpcChannels
    ? true
    : "preload IpcChannels is missing entries"
  : "preload IpcChannels has extra entries";
const _ipcSync: _IpcChannelsSync = true;
void _ipcSync;

import type {
  AgentUsageUpdatedEvent,
  ClearAgentRateLimitInput,
  CreateRoomInput,
  ExportRoundInput,
  GetRoundInput,
  HightableApi,
  MarkRoundCompleteInput,
  OpenRoomInput,
  PauseRoundInput,
  ResizeTerminalInput,
  RestartTerminalInput,
  RoundProgressEvent,
  RoundUpdatedEvent,
  SearchTranscriptsInput,
  SendPromptInput,
  SetAgentRateLimitInput,
  SetRoomResumePolicyInput,
  TerminalDataEvent,
  TerminalExitEvent,
  WriteTerminalInput,
} from "../shared/types.js";

const api: HightableApi = {
  createRoom: (input: CreateRoomInput) => ipcRenderer.invoke(IpcChannels.CreateRoom, input),
  listRooms: () => ipcRenderer.invoke(IpcChannels.ListRooms),
  openRoom: (input: OpenRoomInput) => ipcRenderer.invoke(IpcChannels.OpenRoom, input),
  getRound: (input: GetRoundInput) => ipcRenderer.invoke(IpcChannels.GetRound, input),
  searchTranscripts: (input: SearchTranscriptsInput) =>
    ipcRenderer.invoke(IpcChannels.SearchTranscripts, input),
  getAgentUsage: () => ipcRenderer.invoke(IpcChannels.GetAgentUsage),
  setAgentRateLimit: (input: SetAgentRateLimitInput) =>
    ipcRenderer.invoke(IpcChannels.SetAgentRateLimit, input),
  clearAgentRateLimit: (input: ClearAgentRateLimitInput) =>
    ipcRenderer.invoke(IpcChannels.ClearAgentRateLimit, input),
  pickDirectory: () => ipcRenderer.invoke(IpcChannels.PickDirectory),
  writeTerminal: (input: WriteTerminalInput) => ipcRenderer.invoke(IpcChannels.WriteTerminal, input),
  resizeTerminal: (input: ResizeTerminalInput) => ipcRenderer.invoke(IpcChannels.ResizeTerminal, input),
  sendPrompt: (input: SendPromptInput) => ipcRenderer.invoke(IpcChannels.SendPrompt, input),
  markRoundComplete: (input: MarkRoundCompleteInput) =>
    ipcRenderer.invoke(IpcChannels.MarkRoundComplete, input),
  pauseRound: (input: PauseRoundInput) => ipcRenderer.invoke(IpcChannels.PauseRound, input),
  exportRound: (input: ExportRoundInput) => ipcRenderer.invoke(IpcChannels.ExportRound, input),
  restartTerminal: (input: RestartTerminalInput) =>
    ipcRenderer.invoke(IpcChannels.RestartTerminal, input),
  setRoomResumePolicy: (input: SetRoomResumePolicyInput) =>
    ipcRenderer.invoke(IpcChannels.SetRoomResumePolicy, input),
  resetDatabase: () => ipcRenderer.invoke(IpcChannels.ResetDatabase),
  onTerminalData: (callback: (event: TerminalDataEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent) => {
      callback(payload);
    };
    ipcRenderer.on(IpcChannels.TerminalData, listener);
    return () => ipcRenderer.off(IpcChannels.TerminalData, listener);
  },
  onTerminalExit: (callback: (event: TerminalExitEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalExitEvent) => {
      callback(payload);
    };
    ipcRenderer.on(IpcChannels.TerminalExit, listener);
    return () => ipcRenderer.off(IpcChannels.TerminalExit, listener);
  },
  onRoundUpdated: (callback: (event: RoundUpdatedEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: RoundUpdatedEvent) => {
      callback(payload);
    };
    ipcRenderer.on(IpcChannels.RoundUpdated, listener);
    return () => ipcRenderer.off(IpcChannels.RoundUpdated, listener);
  },
  onRoundProgress: (callback: (event: RoundProgressEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: RoundProgressEvent) => {
      callback(payload);
    };
    ipcRenderer.on(IpcChannels.RoundProgress, listener);
    return () => ipcRenderer.off(IpcChannels.RoundProgress, listener);
  },
  onAgentUsageUpdated: (callback: (event: AgentUsageUpdatedEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AgentUsageUpdatedEvent) => {
      callback(payload);
    };
    ipcRenderer.on(IpcChannels.AgentUsageUpdated, listener);
    return () => ipcRenderer.off(IpcChannels.AgentUsageUpdated, listener);
  },
};

contextBridge.exposeInMainWorld("hightable", api);
