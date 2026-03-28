import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/types'
import type { RunOptions, NormalizedEvent, HealthReport, EnrichedError, Attachment, SessionMeta } from '../shared/types'

export interface CanvasAPI {
  // Canvas-specific
  getBackground(dirPath?: string): Promise<string | null>
  selectBackground(): Promise<string | null>
  getProjectPath(): Promise<string>
  attachFiles(): Promise<Array<{ type: 'image' | 'document'; mimeType: string; data: string; name: string }>>
  pasteImage(): Promise<{ type: 'image'; mimeType: string; data: string; name: string } | null>

  // Claude Code integration
  start(): Promise<{ version: string; auth: { email?: string; subscriptionType?: string; authMethod?: string }; projectPath: string; homePath: string }>
  createTab(): Promise<{ tabId: string }>
  prompt(tabId: string, requestId: string, options: RunOptions): Promise<void>
  cancel(requestId: string): Promise<boolean>
  stopTab(tabId: string): Promise<boolean>
  retry(tabId: string, requestId: string, options: RunOptions): Promise<void>
  status(): Promise<HealthReport>
  closeTab(tabId: string): Promise<void>
  selectDirectory(): Promise<string | null>
  openExternal(url: string): Promise<boolean>
  respondPermission(tabId: string, questionId: string, optionId: string): Promise<boolean>
  initSession(tabId: string): void
  resetTabSession(tabId: string): void
  listSessions(projectPath?: string): Promise<SessionMeta[]>
  setPermissionMode(mode: string): void
  getTheme(): Promise<{ isDark: boolean }>
  onThemeChange(callback: (isDark: boolean) => void): () => void

  // Codex (fully separate from Claude)
  codexCheck(): Promise<{ installed: boolean; version: string | null }>
  codexCreateTab(): Promise<{ tabId: string }>
  codexPrompt(tabId: string, requestId: string, options: { prompt: string; projectPath: string; model?: string }): Promise<void>
  codexStopTab(tabId: string): Promise<boolean>
  codexCloseTab(tabId: string): Promise<void>

  // Event listeners (shared — both Claude and Codex events arrive here)
  onEvent(callback: (tabId: string, event: NormalizedEvent) => void): () => void
  onTabStatusChange(callback: (tabId: string, newStatus: string, oldStatus: string) => void): () => void
  onError(callback: (tabId: string, error: EnrichedError) => void): () => void
}

const api: CanvasAPI = {
  // Canvas
  getBackground: (dirPath) => ipcRenderer.invoke('canvas:get-background', dirPath),
  selectBackground: () => ipcRenderer.invoke('canvas:select-background'),
  getProjectPath: () => ipcRenderer.invoke('canvas:get-project-path'),
  attachFiles: () => ipcRenderer.invoke(IPC.ATTACH_FILES),
  pasteImage: () => ipcRenderer.invoke(IPC.PASTE_IMAGE),

  // Claude Code
  start: () => ipcRenderer.invoke(IPC.START),
  createTab: () => ipcRenderer.invoke(IPC.CREATE_TAB),
  prompt: (tabId, requestId, options) => ipcRenderer.invoke(IPC.PROMPT, { tabId, requestId, options }),
  cancel: (requestId) => ipcRenderer.invoke(IPC.CANCEL, requestId),
  stopTab: (tabId) => ipcRenderer.invoke(IPC.STOP_TAB, tabId),
  retry: (tabId, requestId, options) => ipcRenderer.invoke(IPC.RETRY, { tabId, requestId, options }),
  status: () => ipcRenderer.invoke(IPC.STATUS),
  closeTab: (tabId) => ipcRenderer.invoke(IPC.CLOSE_TAB, tabId),
  selectDirectory: () => ipcRenderer.invoke(IPC.SELECT_DIRECTORY),
  openExternal: (url) => ipcRenderer.invoke(IPC.OPEN_EXTERNAL, url),
  respondPermission: (tabId, questionId, optionId) =>
    ipcRenderer.invoke(IPC.RESPOND_PERMISSION, { tabId, questionId, optionId }),
  initSession: (tabId) => ipcRenderer.send(IPC.INIT_SESSION, tabId),
  resetTabSession: (tabId) => ipcRenderer.send(IPC.RESET_TAB_SESSION, tabId),
  listSessions: (projectPath) => ipcRenderer.invoke(IPC.LIST_SESSIONS, projectPath),
  setPermissionMode: (mode) => ipcRenderer.send(IPC.SET_PERMISSION_MODE, mode),
  getTheme: () => ipcRenderer.invoke(IPC.GET_THEME),
  onThemeChange: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, isDark: boolean) => callback(isDark)
    ipcRenderer.on(IPC.THEME_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.THEME_CHANGED, handler)
  },

  // Codex
  codexCheck: () => ipcRenderer.invoke(IPC.CODEX_CHECK),
  codexCreateTab: () => ipcRenderer.invoke(IPC.CODEX_CREATE_TAB),
  codexPrompt: (tabId, requestId, options) => ipcRenderer.invoke(IPC.CODEX_PROMPT, { tabId, requestId, options }),
  codexStopTab: (tabId) => ipcRenderer.invoke(IPC.CODEX_STOP_TAB, tabId),
  codexCloseTab: (tabId) => ipcRenderer.invoke(IPC.CODEX_CLOSE_TAB, tabId),

  // Event listeners (shared)
  onEvent: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, event: NormalizedEvent) => callback(tabId, event)
    ipcRenderer.on('clui:normalized-event', handler)
    return () => ipcRenderer.removeListener('clui:normalized-event', handler)
  },
  onTabStatusChange: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, newStatus: string, oldStatus: string) =>
      callback(tabId, newStatus, oldStatus)
    ipcRenderer.on('clui:tab-status-change', handler)
    return () => ipcRenderer.removeListener('clui:tab-status-change', handler)
  },
  onError: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, error: EnrichedError) =>
      callback(tabId, error)
    ipcRenderer.on('clui:enriched-error', handler)
    return () => ipcRenderer.removeListener('clui:enriched-error', handler)
  },

  // Orchestrator
  onOrchestratorCreateAgent: (callback: (data: { title: string; prompt?: string; responseChannel: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('orchestrator:create-agent', handler)
    return () => ipcRenderer.removeListener('orchestrator:create-agent', handler)
  },
  onOrchestratorCloseAgent: (callback: (data: { nodeId: string; responseChannel: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('orchestrator:close-agent', handler)
    return () => ipcRenderer.removeListener('orchestrator:close-agent', handler)
  },
  onOrchestratorSendMessage: (callback: (data: { nodeId: string; prompt: string; responseChannel: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('orchestrator:send-message', handler)
    return () => ipcRenderer.removeListener('orchestrator:send-message', handler)
  },
  orchestratorRespond: (channel: string, data: any) => {
    // Security: only allow orchestrator response channels with expected prefix pattern
    if (!/^orchestrator:(create-agent|close-agent|send-message)-response-\d+[a-z0-9]+$/.test(channel)) return
    ipcRenderer.send(channel, data)
  },
  pushAgentSnapshot: (snapshot: any, messages: any) => {
    ipcRenderer.send('orchestrator:agent-snapshot', snapshot, messages)
  },
}

contextBridge.exposeInMainWorld('canvas', api)
