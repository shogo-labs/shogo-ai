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

export interface IdeFileResult {
  type: 'file' | 'folder'
  path: string
  name: string
}

export interface IdeContextState {
  activeFile?: IdeActiveFileContext
  workspaceFolders: IdeWorkspaceFolderContext[]
  workspaceItems?: IdeFileResult[]
}

export interface IdeReadFileResult {
  type: 'file'
  path: string
  contents?: string
  truncated?: boolean
  error?: string
}

/**
 * A reference inserted into the chat composer (mirrors the composer's
 * `ChatReferenceInput` file / folder / selection variants). Lines are
 * 1-based and inclusive.
 */
export type IdeChatReference =
  | { type: 'file' | 'folder'; path: string; name: string }
  | {
      type: 'selection'
      path: string
      name: string
      startLine: number
      endLine: number
      text: string
      languageId?: string
      truncated?: boolean
    }

export type IdeToWebviewMessage =
  | ({ type: 'ide.hostReady' } & Partial<IdeContextState>)
  | ({ type: 'ide.context' } & IdeContextState)
  | { type: 'ide.fileResults'; requestId?: string; items: IdeFileResult[] }
  | { type: 'ide.readFilesResult'; requestId?: string; files: IdeReadFileResult[] }

/** What the chat iframe (apps/mobile ideBridge) receives through the relay. */
export type LegacyIdeToWebviewMessage =
  | { type: 'shogo.ide.hostReady' }
  | ({ type: 'shogo.ide.context' } & IdeContextState)
  | { type: 'shogo.ide.fileResults'; requestId?: string; items: IdeFileResult[] }
  | { type: 'shogo.ide.readFilesResult'; requestId?: string; files: IdeReadFileResult[] }
  | { type: 'shogo.ide.addReferences'; batchId: string; references: IdeChatReference[] }

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
  | { type: 'shogo.ide.referencesAck'; batchId?: string }
