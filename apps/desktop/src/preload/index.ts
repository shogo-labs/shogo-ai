import { contextBridge, ipcRenderer } from 'electron'

export interface IpcResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

export interface AgentRuntimeInfo {
  id: string
  port: number
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'error'
  url: string
  startedAt: number
  error?: string
}

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'error' | 'disabled'
  lastSyncedAt: number | null
  fileCount: number
  error?: string
}

export interface ShogoDesktopAPI {
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

const api: ShogoDesktopAPI = {
  runtime: {
    start: (projectId) => ipcRenderer.invoke('runtime:start', projectId),
    stop: (projectId) => ipcRenderer.invoke('runtime:stop', projectId),
    restart: (projectId) => ipcRenderer.invoke('runtime:restart', projectId),
    status: (projectId) => ipcRenderer.invoke('runtime:status', projectId),
    list: () => ipcRenderer.invoke('runtime:list'),
    logs: (projectId) => ipcRenderer.invoke('runtime:logs', projectId),
    onLog: (cb) => {
      const handler = (_event: Electron.IpcRendererEvent, projectId: string, line: string) => {
        cb(projectId, line)
      }
      ipcRenderer.on('runtime:log', handler)
      return () => {
        ipcRenderer.removeListener('runtime:log', handler)
      }
    },
  },
  sync: {
    enable: (projectId) => ipcRenderer.invoke('sync:enable', projectId),
    disable: (projectId) => ipcRenderer.invoke('sync:disable', projectId),
    status: (projectId) => ipcRenderer.invoke('sync:status', projectId),
    trigger: (projectId) => ipcRenderer.invoke('sync:trigger', projectId),
    pull: (projectId) => ipcRenderer.invoke('sync:pull', projectId),
    onStatus: (cb) => {
      const handler = (_event: Electron.IpcRendererEvent, projectId: string, status: SyncStatus) => {
        cb(projectId, status)
      }
      ipcRenderer.on('sync:onStatus', handler)
      return () => {
        ipcRenderer.removeListener('sync:onStatus', handler)
      }
    },
  },
  settings: {
    get: (key) => ipcRenderer.invoke('settings:get', key),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
    getAll: () => ipcRenderer.invoke('settings:getAll'),
  },
  auth: {
    setApiKey: (key) => ipcRenderer.invoke('auth:setApiKey', key),
    hasApiKey: () => ipcRenderer.invoke('auth:hasApiKey'),
    clearApiKey: () => ipcRenderer.invoke('auth:clearApiKey'),
  },
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    platform: () => ipcRenderer.invoke('app:platform'),
    agentsDir: () => ipcRenderer.invoke('app:agentsDir'),
    apiUrl: () => ipcRenderer.invoke('app:apiUrl'),
  },
}

contextBridge.exposeInMainWorld('shogoDesktop', api)
