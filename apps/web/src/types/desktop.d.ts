/**
 * Type declarations for the Electron desktop preload bridge.
 *
 * When running inside Electron, `window.shogoDesktop` is injected via
 * contextBridge in apps/desktop/src/preload/index.ts.  In a normal
 * browser environment the property is `undefined`.
 */

interface IpcResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

interface AgentRuntimeInfo {
  id: string
  port: number
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'error'
  url: string
  startedAt: number
  error?: string
}

type SyncState = 'idle' | 'syncing' | 'error' | 'disabled'

interface SyncStatus {
  state: SyncState
  lastSyncedAt: number | null
  fileCount: number
  error?: string
}

interface ShogoDesktopAPI {
  runtime: {
    start: (projectId: string) => Promise<IpcResult<AgentRuntimeInfo>>
    stop: (projectId: string) => Promise<IpcResult>
    restart: (projectId: string) => Promise<IpcResult<AgentRuntimeInfo>>
    status: (projectId: string) => Promise<AgentRuntimeInfo | null>
    list: () => Promise<AgentRuntimeInfo[]>
    logs: (projectId: string) => Promise<string[]>
    onLog: (cb: (projectId: string, line: string) => void) => () => void
  }
  sync: {
    enable: (projectId: string) => Promise<void>
    disable: (projectId: string) => Promise<void>
    status: (projectId: string) => Promise<SyncStatus>
    trigger: (projectId: string) => Promise<void>
    pull: (projectId: string) => Promise<void>
    onStatus: (cb: (projectId: string, status: SyncStatus) => void) => () => void
  }
  settings: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    getAll: () => Promise<Record<string, unknown>>
  }
  auth: {
    setApiKey: (key: string) => Promise<IpcResult>
    hasApiKey: () => Promise<boolean>
    clearApiKey: () => Promise<IpcResult>
  }
  app: {
    version: () => Promise<string>
    platform: () => Promise<string>
    agentsDir: () => Promise<string>
    apiUrl: () => Promise<string>
  }
}

declare interface Window {
  shogoDesktop?: ShogoDesktopAPI
}
