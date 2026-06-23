export interface IdeSelectionContext {
  text: string
  startLine: number
  endLine: number
  truncated?: boolean
}

export interface IdeActiveFileContext {
  path: string
  languageId?: string
  selection?: IdeSelectionContext
}

export interface IdeWorkspaceFolderContext {
  name: string
  path: string
}

export interface IdeContextAttachment {
  id: string
  kind: 'selection' | 'active-file' | 'file' | 'folder'
  label: string
  path?: string
  languageId?: string
  text?: string
  startLine?: number
  endLine?: number
  truncated?: boolean
}

export interface IdeFileResult {
  type: 'file' | 'folder'
  path: string
  name: string
}

export interface IdeContextState {
  activeFile?: IdeActiveFileContext
  workspaceFolders: IdeWorkspaceFolderContext[]
  workspaceItems?: IdeFileResult[]
  storedContext?: IdeContextAttachment[]
}

export interface IdeReadFileResult {
  type: 'file'
  path: string
  contents?: string
  truncated?: boolean
  error?: string
}

export type IdeToWebviewMessage =
  | ({ type: 'ide.hostReady' } & Partial<IdeContextState>)
  | ({ type: 'ide.context' } & IdeContextState)
  | { type: 'ide.fileResults'; requestId?: string; items: IdeFileResult[] }
  | { type: 'ide.readFilesResult'; requestId?: string; files: IdeReadFileResult[] }

export type WebviewToIdeMessage =
  | { type: 'webview.ready' }
  | { type: 'ide.listFiles'; requestId?: string; query?: string }
  | { type: 'ide.readFiles'; requestId?: string; paths: string[] }
  | { type: 'ide.openFile'; path: string }
  | { type: 'openExternal' }
  | { type: 'refresh' }

export type LegacyIdeMessage =
  | { type: 'shogo.ide.ready' }
  | { type: 'shogo.ide.listFiles'; requestId?: string; query?: string }
  | { type: 'shogo.ide.readFiles'; requestId?: string; paths?: string[] }
  | { type: 'shogo.ide.openFile'; path?: string }
