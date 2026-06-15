import * as vscode from 'vscode'

export type ShogoContextKind = 'selection' | 'active-file' | 'workspace' | 'git-diff' | 'diagnostics'

export interface ShogoContextItem {
  id: string
  kind: ShogoContextKind
  label: string
  uri?: string
  languageId?: string
  text?: string
  range?: {
    startLine: number
    startCharacter: number
    endLine: number
    endCharacter: number
  }
  createdAt: string
}

export interface AgentHealth {
  ok: boolean
  status: 'not-configured' | 'healthy' | 'unreachable' | 'error'
  url: string | null
  message: string
}

export interface ChatTranscriptMessage {
  id: string
  role: 'system' | 'user' | 'assistant'
  text: string
  createdAt: string
}

export interface ChatRequest {
  prompt: string
  context: ShogoContextItem[]
  workspaceTrusted: boolean
  workspaceFolders: string[]
}

export interface ChatResponse {
  ok: boolean
  message: string
  error?: string
}

export interface ExtensionState {
  health: AgentHealth
  contextItems: ShogoContextItem[]
  messages: ChatTranscriptMessage[]
  workspaceTrusted: boolean
}

export interface ExtensionServices {
  agentClient: {
    getHealth(): Promise<AgentHealth>
    sendChat(request: ChatRequest): Promise<ChatResponse>
  }
  contextStore: {
    list(): ShogoContextItem[]
    addSelection(editor: vscode.TextEditor): ShogoContextItem | null
    addActiveFile(editor: vscode.TextEditor): ShogoContextItem | null
    clear(): void
  }
}
