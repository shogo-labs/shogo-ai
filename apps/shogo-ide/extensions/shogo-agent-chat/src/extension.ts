import * as vscode from 'vscode'

type Role = 'system' | 'user' | 'assistant'

type IdeActionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'rejected' | 'undone'

type IdeActionKind = 'workspaceEdit' | 'writeFile' | 'runCommand' | 'openFile'
type ChatMode = 'ask' | 'edit' | 'agent' | 'plan'

interface ModeContract {
  mode: ChatMode
  label: string
  description: string
  readOnly: boolean
  allowedActions: IdeActionKind[]
  requiresReview: boolean
  handoff?: { targetMode: ChatMode; label: string }
}

interface IdeAction {
  id: string
  kind: IdeActionKind
  title: string
  description?: string
  status: IdeActionStatus
  filePath?: string
  uri?: string
  languageId?: string
  content?: string
  find?: string
  replace?: string
  command?: string
  args?: string[]
  cwd?: string
  result?: string
  error?: string
  reviewSummary?: string
  hasCheckpoint?: boolean
}

interface ActionReview {
  actionId: string
  targetLabel: string
  uri: vscode.Uri
  originalText: string
  proposedText: string
  originalUri: vscode.Uri
  proposedUri: vscode.Uri
  applied: boolean
}

interface ChatMessage {
  id: string
  role: Role
  text: string
  createdAt: string
  actions?: IdeAction[]
}

type RequestStatus = 'idle' | 'running' | 'stopping'

interface QueuedPrompt {
  prompt: string
  mode: ChatMode
  model?: string
}

interface OperationTimelineItem {
  id: string
  kind: 'request' | 'stream' | 'action' | 'queue' | 'steer' | 'debug' | 'subagent'
  title: string
  detail?: string
  createdAt: string
}

interface DebugSnapshot {
  createdAt: string
  bridgeUrl: string
  requestBody: string
  headers: Record<string, string>
}

type ContextKind = 'selection' | 'activeFile' | 'file' | 'folder' | 'symbol' | 'diagnostic' | 'terminal'

interface ContextRange {
  start: { line: number; character: number }
  end: { line: number; character: number }
}

interface ContextItem {
  id: string
  kind: ContextKind
  label: string
  uri: string
  detail?: string
  text?: string
  range?: ContextRange
  stale?: boolean
}

interface ContextSuggestion extends ContextItem {
  score: number
}

interface RichIdeContext {
  source: 'shogo-ide'
  phase: 5 | 6
  workspaceTrusted: boolean
  workspaceFolders: Array<{ name: string; uri: string; fsPath: string }>
  activeEditor: null | {
    uri: string
    fsPath: string
    relativePath: string
    languageId: string
    lineCount: number
    selection: null | {
      start: { line: number; character: number }
      end: { line: number; character: number }
      text: string
    }
  }
  visibleEditors: Array<{ uri: string; relativePath: string; languageId: string }>
  attachedContext: Array<ContextItem & { textLength: number }>
  diagnostics: Array<{ uri: string; relativePath: string; severity: string; message: string; line: number; character: number }>
  terminals: Array<{ name: string; state?: string }>
  capabilities: {
    richContext: true
    editActions: true
    runActions: true
    requiresConfirmation: true
  }
}

interface WebviewMessage {
  type: string
  prompt?: string
  model?: string
  mode?: string
  actionId?: string
  contextId?: string
  query?: string
  message?: string
  operation?: 'queue' | 'steer'
}

interface BridgeResponse {
  ok?: boolean
  message?: string
  error?: string
  actions?: IdeAction[]
}

interface AgentStreamResult {
  text: string
  error?: string
  actions: IdeAction[]
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let value = ''
  for (let i = 0; i < 32; i += 1) value += chars.charAt(Math.floor(Math.random() * chars.length))
  return value
}

function createMessage(role: Role, text: string, actions?: IdeAction[]): ChatMessage {
  return {
    id: `${role}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
    role,
    text,
    createdAt: new Date().toISOString(),
    ...(actions && actions.length > 0 ? { actions } : {}),
  }
}

function createAction(input: Partial<IdeAction> & { kind: IdeActionKind }): IdeAction {
  return {
    id: input.id || `action:${Date.now()}:${Math.random().toString(16).slice(2)}`,
    kind: input.kind,
    title: input.title || titleForAction(input.kind),
    description: input.description,
    status: input.status || 'pending',
    filePath: input.filePath,
    uri: input.uri,
    languageId: input.languageId,
    content: input.content,
    find: input.find,
    replace: input.replace,
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    result: input.result,
    error: input.error,
    reviewSummary: input.reviewSummary,
    hasCheckpoint: input.hasCheckpoint,
  }
}

function titleForAction(kind: IdeActionKind): string {
  if (kind === 'workspaceEdit') return 'Apply workspace edit'
  if (kind === 'writeFile') return 'Write file'
  if (kind === 'runCommand') return 'Run command'
  return 'Open file'
}

function isIdeActionKind(value: unknown): value is IdeActionKind {
  return value === 'workspaceEdit' || value === 'writeFile' || value === 'runCommand' || value === 'openFile'
}

function isEditAction(action: IdeAction): boolean {
  return action.kind === 'workspaceEdit' || action.kind === 'writeFile'
}

function isChatMode(value: unknown): value is ChatMode {
  return value === 'ask' || value === 'edit' || value === 'agent' || value === 'plan'
}

function modeContract(mode: ChatMode): ModeContract {
  if (mode === 'ask') {
    return {
      mode,
      label: 'Ask',
      description: 'Answer and explain using attached IDE context. Do not modify files or run commands.',
      readOnly: true,
      allowedActions: ['openFile'],
      requiresReview: false,
    }
  }
  if (mode === 'edit') {
    return {
      mode,
      label: 'Edit',
      description: 'Focus on concrete file edits. Propose workspaceEdit/writeFile actions and avoid shell commands.',
      readOnly: false,
      allowedActions: ['workspaceEdit', 'writeFile', 'openFile'],
      requiresReview: true,
    }
  }
  if (mode === 'plan') {
    return {
      mode,
      label: 'Plan',
      description: 'Create an implementation plan only. Use read-only reasoning and do not propose file edits or commands.',
      readOnly: true,
      allowedActions: ['openFile'],
      requiresReview: false,
      handoff: { targetMode: 'agent', label: 'Implement plan' },
    }
  }
  return {
    mode,
    label: 'Agent',
    description: 'Use tools for multi-step implementation. Edits require review and commands require explicit confirmation.',
    readOnly: false,
    allowedActions: ['workspaceEdit', 'writeFile', 'runCommand', 'openFile'],
    requiresReview: true,
  }
}

function allModeContracts(): ModeContract[] {
  return ['ask', 'edit', 'agent', 'plan'].map((mode) => modeContract(mode as ChatMode))
}

function buildModeInstruction(contract: ModeContract): string {
  const allowed = contract.allowedActions.length ? contract.allowedActions.join(', ') : 'none'
  return [
    `[Shogo chat mode: ${contract.label}]`,
    contract.description,
    `Allowed IDE actions: ${allowed}.`,
    contract.readOnly ? 'Read-only mode is active: do not create writeFile, workspaceEdit, runCommand, install, migration, or deployment actions.' : 'Side effects must stay inside the advertised action protocol and wait for user review/confirmation.',
    contract.mode === 'plan' ? 'Return a concise implementation plan with ordered tasks, risks, and a handoff-ready implementation prompt. Do not edit files.' : '',
    contract.mode === 'edit' ? 'Prefer minimal, reviewable file edits over broad agentic exploration.' : '',
    contract.mode === 'ask' ? 'Prefer explanation, references to attached context, and suggested next steps over implementation.' : '',
  ].filter(Boolean).join('\n')
}

function actionAllowedInMode(action: IdeAction, mode: ChatMode): boolean {
  return modeContract(mode).allowedActions.includes(action.kind)
}

function blockedActionMessage(action: IdeAction, mode: ChatMode): string {
  return `${action.kind} was blocked because ${modeContract(mode).label} mode only allows ${modeContract(mode).allowedActions.join(', ') || 'read-only responses'}. Switch to Agent mode to run broader tool actions.`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[ch] ?? ch))
}

function getBridgeConfig(): { url: string | null; token: string | null } {
  const config = vscode.workspace.getConfiguration('shogo.agentChat')
  const configuredUrl = config.get<string>('bridgeUrl')?.trim() || process.env.SHOGO_AGENT_BRIDGE_URL || ''
  const configuredToken = config.get<string>('bridgeToken')?.trim() || process.env.SHOGO_AGENT_BRIDGE_TOKEN || ''
  const normalizedUrl = configuredUrl.replace(/\/+$/, '').replace(/\/api$/, '')
  return {
    url: normalizedUrl || null,
    token: configuredToken || null,
  }
}

function getWorkspaceFolders(): string[] {
  return vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? []
}

function relativePath(uri: vscode.Uri): string {
  const asRelativePath = (vscode.workspace as any).asRelativePath as undefined | ((pathOrUri: string | vscode.Uri, includeWorkspaceFolder?: boolean) => string)
  if (asRelativePath) return asRelativePath(uri, false)
  return uri.fsPath || uri.toString()
}

function buildSessionId(): string {
  const folder = getWorkspaceFolders()[0] ?? 'workspace'
  const safeFolder = folder.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-48)
  return `shogo-ide:${safeFolder}:${Date.now().toString(36)}:${Math.random().toString(16).slice(2)}`
}

let lastTextEditor: vscode.TextEditor | null = null
const lastSelections = new Map<string, vscode.Selection>()
const actionReviews = new Map<string, ActionReview>()
const reviewDocuments = new Map<string, string>()

function normalizeQuery(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

function contextIcon(kind: ContextKind): string {
  if (kind === 'selection') return '⌁'
  if (kind === 'folder') return '▣'
  if (kind === 'symbol') return '◇'
  if (kind === 'diagnostic') return '⚠'
  if (kind === 'terminal') return '▹'
  return '□'
}

function contextKindLabel(kind: ContextKind): string {
  if (kind === 'activeFile') return 'active file'
  return kind
}

function contextMatches(item: ContextItem, query: string): boolean {
  if (!query) return true
  return [item.kind, item.label, item.detail, item.uri].filter(Boolean).join(' ').toLowerCase().includes(query)
}

function dedupeContextItems(items: ContextSuggestion[]): ContextSuggestion[] {
  const seen = new Set<string>()
  const output: ContextSuggestion[] = []
  for (const item of items.sort((a, b) => b.score - a.score)) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    output.push(item)
  }
  return output
}

function rememberTextEditor(editor: vscode.TextEditor | undefined): void {
  if (!editor) return
  lastTextEditor = editor
  if (!editor.selection.isEmpty) lastSelections.set(editor.document.uri.toString(), editor.selection)
}

function getContextTextEditor(): vscode.TextEditor | null {
  const activeEditor = vscode.window.activeTextEditor
  if (activeEditor) rememberTextEditor(activeEditor)
  return activeEditor ?? lastTextEditor
}

function getContextSelection(editor: vscode.TextEditor): vscode.Selection | null {
  if (!editor.selection.isEmpty) return editor.selection
  return lastSelections.get(editor.document.uri.toString()) ?? null
}

function toAgentMessage(role: 'user' | 'assistant', text: string): { role: 'user' | 'assistant'; parts: Array<{ type: 'text'; text: string }> } {
  return { role, parts: [{ type: 'text', text }] }
}

function summarizeContextForPrompt(context: ContextItem[]): string {
  if (context.length === 0) return ''
  const sections = context.map((item, index) => {
    const text = item.text?.trim()
    return [
      `Context ${index + 1}: ${item.kind} — ${item.label}`,
      `URI: ${item.uri}`,
      text ? '```\n' + text + '\n```' : '(no text captured)',
    ].join('\n')
  })
  return `\n\nAttached IDE context:\n\n${sections.join('\n\n')}`
}

async function collectActiveFile(): Promise<ContextItem | null> {
  const editor = getContextTextEditor()
  if (!editor) return null
  rememberTextEditor(editor)
  const document = editor.document
  return {
    id: `activeFile:${document.uri.toString()}`,
    kind: 'activeFile',
    label: relativePath(document.uri),
    uri: document.uri.toString(),
    detail: document.languageId,
    text: document.getText().slice(0, 24000),
  }
}

function collectSelection(): ContextItem | null {
  const editor = getContextTextEditor()
  if (!editor) return null
  const selection = getContextSelection(editor)
  if (!selection) return null
  const document = editor.document
  const text = document.getText(selection)
  if (!text.trim()) return null
  lastSelections.set(document.uri.toString(), selection)
  return {
    id: `selection:${document.uri.toString()}:${selection.start.line}:${selection.start.character}:${selection.end.line}:${selection.end.character}`,
    kind: 'selection',
    label: `${relativePath(document.uri)}:${selection.start.line + 1}`,
    uri: document.uri.toString(),
    detail: `${selection.start.line + 1}:${selection.start.character + 1}–${selection.end.line + 1}:${selection.end.character + 1}`,
    text: text.slice(0, 24000),
    range: {
      start: { line: selection.start.line, character: selection.start.character },
      end: { line: selection.end.line, character: selection.end.character },
    },
  }
}

async function readContextFileText(uri: vscode.Uri): Promise<string> {
  const workspaceApi = vscode.workspace as any
  try {
    if (workspaceApi.fs?.readFile) return new TextDecoder().decode(await workspaceApi.fs.readFile(uri)).slice(0, 24000)
    const document = await workspaceApi.openTextDocument(uri)
    return document.getText().slice(0, 24000)
  } catch {
    return ''
  }
}

async function createFileContextItem(uri: vscode.Uri, kind: 'file' | 'activeFile' = 'file'): Promise<ContextItem> {
  return {
    id: `${kind}:${uri.toString()}`,
    kind,
    label: relativePath(uri),
    uri: uri.toString(),
    text: await readContextFileText(uri),
  }
}

function createFolderContextItem(folder: vscode.WorkspaceFolder): ContextItem {
  return {
    id: `folder:${folder.uri.toString()}`,
    kind: 'folder',
    label: folder.name,
    uri: folder.uri.toString(),
    detail: relativePath(folder.uri),
    text: `Workspace folder: ${folder.name}\nURI: ${folder.uri.toString()}`,
  }
}

function severityLabel(value: unknown): string {
  if (value === 0) return 'error'
  if (value === 1) return 'warning'
  if (value === 2) return 'information'
  if (value === 3) return 'hint'
  return 'unknown'
}

function collectRichIdeContext(contextItems: ContextItem[]): RichIdeContext {
  const activeEditor = getContextTextEditor()
  const activeDocument = activeEditor?.document
  const activeSelection = activeEditor ? getContextSelection(activeEditor) : null
  const visibleEditors = ((vscode.window as any).visibleTextEditors ?? []) as vscode.TextEditor[]
  const languages = (vscode as any).languages
  const diagnostics = typeof languages?.getDiagnostics === 'function'
    ? ((languages.getDiagnostics() ?? []) as Array<[vscode.Uri, any[]]>)
    : []
  const terminals = (((vscode.window as any).terminals ?? []) as Array<{ name?: string; state?: { isInteractedWith?: boolean } }>).slice(0, 8)

  return {
    source: 'shogo-ide',
    phase: 6,
    workspaceTrusted: vscode.workspace.isTrusted,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      name: folder.name,
      uri: folder.uri.toString(),
      fsPath: folder.uri.fsPath,
    })),
    activeEditor: activeEditor && activeDocument ? {
      uri: activeDocument.uri.toString(),
      fsPath: activeDocument.uri.fsPath,
      relativePath: relativePath(activeDocument.uri),
      languageId: activeDocument.languageId,
      lineCount: Number((activeDocument as any).lineCount ?? 0),
      selection: activeSelection && !activeSelection.isEmpty ? {
        start: { line: activeSelection.start.line, character: activeSelection.start.character },
        end: { line: activeSelection.end.line, character: activeSelection.end.character },
        text: activeDocument.getText(activeSelection).slice(0, 24000),
      } : null,
    } : null,
    visibleEditors: visibleEditors.slice(0, 12).map((editor) => ({
      uri: editor.document.uri.toString(),
      relativePath: relativePath(editor.document.uri),
      languageId: editor.document.languageId,
    })),
    attachedContext: contextItems.map((item) => ({
      ...item,
      textLength: item.text?.length ?? 0,
      text: item.text?.slice(0, 24000),
    })),
    diagnostics: diagnostics.flatMap(([uri, items]) => items.slice(0, 20).map((diagnostic) => ({
      uri: uri.toString(),
      relativePath: relativePath(uri),
      severity: severityLabel(diagnostic.severity),
      message: String(diagnostic.message ?? '').slice(0, 1000),
      line: Number(diagnostic.range?.start?.line ?? 0),
      character: Number(diagnostic.range?.start?.character ?? 0),
    }))).slice(0, 80),
    terminals: terminals.map((terminal) => ({
      name: terminal.name || 'Terminal',
      state: terminal.state?.isInteractedWith ? 'active' : 'idle',
    })),
    capabilities: {
      richContext: true,
      editActions: true,
      runActions: true,
      requiresConfirmation: true,
    },
  }
}

function normalizeIdeAction(input: unknown): IdeAction | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  const rawKind = raw.kind ?? raw.type
  if (!isIdeActionKind(rawKind)) return null
  const args = Array.isArray(raw.args) ? raw.args.filter((item): item is string => typeof item === 'string') : undefined
  return createAction({
    id: typeof raw.id === 'string' ? raw.id : undefined,
    kind: rawKind,
    title: typeof raw.title === 'string' ? raw.title : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    status: 'pending',
    filePath: typeof raw.filePath === 'string' ? raw.filePath : undefined,
    uri: typeof raw.uri === 'string' ? raw.uri : undefined,
    languageId: typeof raw.languageId === 'string' ? raw.languageId : undefined,
    content: typeof raw.content === 'string' ? raw.content : undefined,
    find: typeof raw.find === 'string' ? raw.find : undefined,
    replace: typeof raw.replace === 'string' ? raw.replace : undefined,
    command: typeof raw.command === 'string' ? raw.command : undefined,
    args,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
  })
}

function collectStreamActions(data: Record<string, any>): IdeAction[] {
  const candidates: unknown[] = []
  if (Array.isArray(data.actions)) candidates.push(...data.actions)
  if (data.action) candidates.push(data.action)
  if ((data.type === 'ide-action' || data.type === 'shogo-ide-action') && data.kind) candidates.push(data)
  if (data.type === 'tool-call' && (data.toolName === 'shogo_ide_action' || data.toolName === 'ide_action')) {
    candidates.push(data.args ?? data.input ?? data.arguments)
  }
  return candidates.map(normalizeIdeAction).filter((action): action is IdeAction => Boolean(action))
}

async function readAgentStream(response: Response, onText: (text: string) => void, onAction: (action: IdeAction) => void, onEvent?: (event: Record<string, any>) => void): Promise<AgentStreamResult> {
  const reader = response.body?.getReader()
  if (!reader) return { text: '', actions: [] }

  const decoder = new TextDecoder()
  const actions: IdeAction[] = []
  let buffer = ''
  let text = ''
  let error: string | undefined

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const dataText = trimmed.slice(5).trim()
        if (!dataText || dataText === '[DONE]' || dataText === '{}') continue

        try {
          const data = JSON.parse(dataText) as Record<string, any>
          onEvent?.(data)
          const nextActions = collectStreamActions(data)
          for (const action of nextActions) {
            actions.push(action)
            onAction(action)
          }
          if (data.type === 'text-delta') {
            text += typeof data.delta === 'string' ? data.delta : ''
            onText(text)
          } else if (data.type === 'text') {
            text += typeof data.content === 'string' ? data.content : ''
            onText(text)
          } else if (data.type === 'error') {
            error = String(data.errorText || data.message || data.error || 'Agent stream error')
          }
        } catch {
          if (dataText.startsWith('0:')) {
            try {
              text += JSON.parse(dataText.slice(2))
              onText(text)
            } catch {
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  return { text, error, actions }
}

class ShogoAgentChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null
  private chatSessionId = buildSessionId()
  private pendingComposerText = ''
  private currentMode: ChatMode = 'agent'
  private lastPlanText = ''
  private requestStatus: RequestStatus = 'idle'
  private activeAbortController: AbortController | null = null
  private queuedPrompt: QueuedPrompt | null = null
  private readonly steeringNotes: string[] = []
  private readonly operationTimeline: OperationTimelineItem[] = []
  private debugSnapshot: DebugSnapshot | null = null
  private readonly messages: ChatMessage[] = []
  private readonly contextItems = new Map<string, ContextItem>()
  private readonly contextSuggestions = new Map<string, ContextSuggestion>()

  constructor(private readonly extensionUri: vscode.Uri, private readonly statusBarItem: any | null = null) {
    this.updateNativeStatus()
  }

  private pushSystemMessage(text: string): void {
    const lastMessage = this.messages[this.messages.length - 1]
    if (lastMessage?.role === 'system' && lastMessage.text === text) return
    this.messages.push(createMessage('system', text))
  }

  private addTimeline(kind: OperationTimelineItem['kind'], title: string, detail?: string): void {
    this.operationTimeline.push({
      id: `op:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      kind,
      title,
      detail,
      createdAt: new Date().toISOString(),
    })
    if (this.operationTimeline.length > 80) this.operationTimeline.splice(0, this.operationTimeline.length - 80)
  }

  private setDebugSnapshot(bridgeUrl: string, requestBody: string, headers: Record<string, string>): void {
    this.debugSnapshot = {
      createdAt: new Date().toISOString(),
      bridgeUrl,
      requestBody,
      headers: { ...headers, ...(headers.authorization ? { authorization: 'Bearer •••' } : {}) },
    }
    this.addTimeline('debug', 'Captured request payload', `${requestBody.length} bytes`)
  }

  getAttachedContext(): ContextItem[] {
    return Array.from(this.contextItems.values())
  }

  private setContextItem(item: ContextItem): void {
    this.contextItems.set(item.id, item)
  }

  private removeContextItem(contextId: string): void {
    this.contextItems.delete(contextId)
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    }
    webviewView.webview.html = this.render(webviewView.webview)
    webviewView.webview.onDidReceiveMessage((raw) => {
      void this.handleMessage(raw)
    })
    void this.postState()
  }

  async open(preserveFocus = false): Promise<void> {
    await showShogoChatContainer()
    await vscode.commands.executeCommand('shogo.agentChat.focus').catch(() => undefined)
    this.view?.show?.(preserveFocus)
    await this.postState()
  }

  async focusInput(): Promise<void> {
    await this.open(false)
    await this.view?.webview.postMessage({ type: 'focusComposer' })
  }

  async prefillPrompt(text: string, mode?: ChatMode): Promise<void> {
    this.pendingComposerText = text
    if (mode) this.currentMode = mode
    await this.open(false)
    await this.view?.webview.postMessage({ type: 'prefillPrompt', text, mode })
    await this.postState()
  }

  async handoffPlanToAgent(): Promise<void> {
    const plan = this.lastPlanText || [...this.messages].reverse().find((message) => message.role === 'assistant' && message.text.trim() && message.text !== 'Thinking…')?.text || ''
    if (!plan.trim()) {
      this.pushSystemMessage('No planner response is available to hand off yet.')
      await this.postState()
      return
    }
    await this.prefillPrompt(`Implement this plan from the previous planner response. Keep changes minimal, use reviewed edit actions, and explain verification steps.\n\nPlan:\n${plan}`, 'agent')
    this.pushSystemMessage('Planner handoff prepared in Agent mode. Review the prompt, then send when ready.')
    await this.postState()
  }

  async askAboutSelection(intent: 'explain' | 'fix'): Promise<void> {
    const item = collectSelection()
    if (!item) {
      this.pushSystemMessage('Select code in the editor before asking Shogo about it.')
      await this.focusInput()
      return
    }
    this.setContextItem(item)
    const prompt = intent === 'fix'
      ? `Fix the selected code in ${item.label}. Propose an edit action when you are confident.`
      : `Explain the selected code in ${item.label}. Include key behavior, edge cases, and any risks.`
    this.pushSystemMessage(`Added selection context: ${item.label}`)
    await this.prefillPrompt(prompt, intent === 'fix' ? 'edit' : 'ask')
    await this.postState()
  }

  async newChat(): Promise<void> {
    this.activeAbortController?.abort()
    this.activeAbortController = null
    this.requestStatus = 'idle'
    this.queuedPrompt = null
    this.steeringNotes.splice(0, this.steeringNotes.length)
    this.operationTimeline.splice(0, this.operationTimeline.length)
    this.debugSnapshot = null
    this.chatSessionId = buildSessionId()
    this.messages.splice(0, this.messages.length)
    this.contextItems.clear()
    this.addTimeline('request', 'Started new chat', this.chatSessionId)
    await this.postState()
  }

  async addSelection(): Promise<void> {
    const item = collectSelection()
    if (!item) {
      this.pushSystemMessage('Select code in the editor before adding selection context.')
    } else {
      this.setContextItem(item)
      this.pushSystemMessage(`Added selection context: ${item.label}`)
    }
    await this.open()
  }

  async addActiveFile(): Promise<void> {
    const item = await collectActiveFile()
    if (!item) {
      this.pushSystemMessage('Open a file before adding active file context.')
    } else {
      this.setContextItem(item)
      this.pushSystemMessage(`Added active file context: ${item.label}`)
    }
    await this.open()
  }

  async openContextPicker(): Promise<void> {
    const suggestions = await this.collectContextSuggestions('', 40)
    const pickerItems = suggestions.map((item) => ({
      label: `${contextIcon(item.kind)} ${item.label}`,
      description: contextKindLabel(item.kind),
      detail: item.detail || item.uri,
      item,
    }))
    const picked = await (vscode.window as any).showQuickPick?.(pickerItems, {
      placeHolder: 'Attach context to Shogo Chat',
      matchOnDescription: true,
      matchOnDetail: true,
    })
    if (picked?.item) {
      this.setContextItem(picked.item)
      this.pushSystemMessage(`Attached ${contextKindLabel(picked.item.kind)} context: ${picked.item.label}`)
      await this.open()
    }
  }

  removeDeletedContext(files: readonly vscode.Uri[]): void {
    const deleted = new Set(files.map((uri) => uri.toString()))
    let removed = 0
    for (const item of this.contextItems.values()) {
      if ((item.kind === 'file' || item.kind === 'activeFile' || item.kind === 'selection' || item.kind === 'folder' || item.kind === 'symbol' || item.kind === 'diagnostic') && deleted.has(item.uri)) {
        this.contextItems.delete(item.id)
        removed += 1
      }
    }
    if (removed > 0) {
      this.pushSystemMessage(`Removed ${removed} stale context attachment${removed === 1 ? '' : 's'} after file deletion.`)
      void this.postState()
    }
  }

  private async addSuggestionContext(contextId: string): Promise<void> {
    const item = this.contextSuggestions.get(contextId)
    if (!item) return
    this.setContextItem(item)
    this.pushSystemMessage(`Attached ${contextKindLabel(item.kind)} context: ${item.label}`)
    await this.postState()
  }

  private async postContextSuggestions(query: string | undefined): Promise<void> {
    const suggestions = await this.collectContextSuggestions(query ?? '', 12)
    this.contextSuggestions.clear()
    for (const suggestion of suggestions) this.contextSuggestions.set(suggestion.id, suggestion)
    await this.view?.webview.postMessage({
      type: 'contextSuggestions',
      suggestions: suggestions.map((item) => ({
        id: item.id,
        kind: item.kind,
        label: item.label,
        detail: item.detail || item.uri,
      })),
    })
  }

  private async collectContextSuggestions(queryValue: string, limit: number): Promise<ContextSuggestion[]> {
    const query = normalizeQuery(queryValue)
    const suggestions: ContextSuggestion[] = []
    const activeFile = await collectActiveFile()
    if (activeFile) suggestions.push({ ...activeFile, score: 100 })
    const selection = collectSelection()
    if (selection) suggestions.push({ ...selection, score: 98 })
    for (const folder of vscode.workspace.workspaceFolders ?? []) suggestions.push({ ...createFolderContextItem(folder), score: 82 })

    const workspaceApi = vscode.workspace as any
    if (workspaceApi.findFiles) {
      const files = await workspaceApi.findFiles(query ? `**/*${query}*` : '**/*', '**/{node_modules,.git,dist,out,build}/**', 12).catch(() => [])
      for (const uri of files as vscode.Uri[]) {
        suggestions.push({ ...(await createFileContextItem(uri, 'file')), score: 76 })
      }
    }

    const symbolProvider = await vscode.commands.executeCommand<any[]>('vscode.executeWorkspaceSymbolProvider', query || '').catch(() => [])
    for (const symbol of (symbolProvider ?? []).slice(0, 8)) {
      const uri = symbol.location?.uri
      if (!uri) continue
      suggestions.push({
        id: `symbol:${uri.toString()}:${symbol.name ?? ''}:${symbol.location?.range?.start?.line ?? 0}`,
        kind: 'symbol',
        label: String(symbol.name ?? relativePath(uri)),
        uri: uri.toString(),
        detail: `${relativePath(uri)} · ${String(symbol.containerName ?? symbol.kind ?? 'symbol')}`,
        text: await readContextFileText(uri),
        range: symbol.location?.range ? {
          start: { line: Number(symbol.location.range.start.line ?? 0), character: Number(symbol.location.range.start.character ?? 0) },
          end: { line: Number(symbol.location.range.end.line ?? 0), character: Number(symbol.location.range.end.character ?? 0) },
        } : undefined,
        score: 70,
      })
    }

    const diagnostics = typeof (vscode as any).languages?.getDiagnostics === 'function' ? ((vscode as any).languages.getDiagnostics() ?? []) as Array<[vscode.Uri, any[]]> : []
    for (const [uri, items] of diagnostics) {
      for (const diagnostic of items.slice(0, 5)) {
        suggestions.push({
          id: `diagnostic:${uri.toString()}:${diagnostic.range?.start?.line ?? 0}:${String(diagnostic.message ?? '').slice(0, 80)}`,
          kind: 'diagnostic',
          label: `${relativePath(uri)}:${Number(diagnostic.range?.start?.line ?? 0) + 1}`,
          uri: uri.toString(),
          detail: String(diagnostic.message ?? '').slice(0, 160),
          text: `Diagnostic in ${relativePath(uri)}:${Number(diagnostic.range?.start?.line ?? 0) + 1}\n${String(diagnostic.message ?? '')}`,
          range: diagnostic.range ? {
            start: { line: Number(diagnostic.range.start.line ?? 0), character: Number(diagnostic.range.start.character ?? 0) },
            end: { line: Number(diagnostic.range.end.line ?? 0), character: Number(diagnostic.range.end.character ?? 0) },
          } : undefined,
          score: 66,
        })
      }
    }

    const terminals = (((vscode.window as any).terminals ?? []) as Array<{ name?: string; state?: { isInteractedWith?: boolean } }>).slice(0, 8)
    for (const terminal of terminals) {
      const name = terminal.name || 'Terminal'
      suggestions.push({
        id: `terminal:${name}`,
        kind: 'terminal',
        label: name,
        uri: `shogo-terminal://${encodeURIComponent(name)}`,
        detail: terminal.state?.isInteractedWith ? 'active terminal' : 'idle terminal',
        text: `Terminal: ${name} (${terminal.state?.isInteractedWith ? 'active' : 'idle'})`,
        score: 58,
      })
    }

    return dedupeContextItems(suggestions.filter((item) => contextMatches(item, query))).slice(0, limit)
  }

  private async openContextItem(contextId: string): Promise<void> {
    const item = this.contextItems.get(contextId)
    if (!item || item.kind === 'terminal') return
    const uri = vscode.Uri.parse(item.uri)
    if (item.kind === 'folder') {
      await vscode.commands.executeCommand('revealInExplorer', uri).catch(() => undefined)
      return
    }
    const document = await (vscode.workspace as any).openTextDocument(uri)
    const options: any = { preview: false }
    if (item.range) {
      const rangeFactory = (vscode as any).Range
      if (rangeFactory) options.selection = new rangeFactory(item.range.start.line, item.range.start.character, item.range.end.line, item.range.end.character)
    }
    await (vscode.window as any).showTextDocument(document, options)
  }

  private queuePrompt(prompt: string, mode: ChatMode, model?: string): void {
    this.queuedPrompt = { prompt, mode, model }
    this.addTimeline('queue', 'Queued follow-up prompt', `${modeContract(mode).label} · ${prompt.slice(0, 140)}`)
    this.pushSystemMessage('Queued your follow-up. Shogo will send it after the current request finishes.')
  }

  private steerRequest(prompt: string): void {
    this.steeringNotes.push(prompt)
    this.queuedPrompt = {
      prompt: `Steering note while the previous request was running:\n${prompt}\n\nContinue from the latest assistant result and adjust course accordingly.`,
      mode: this.currentMode,
      model: undefined,
    }
    this.addTimeline('steer', 'Captured steering note', prompt.slice(0, 160))
    this.pushSystemMessage('Captured steering note and queued it as the next turn.')
  }

  private async stopRequest(): Promise<void> {
    if (!this.activeAbortController || this.requestStatus !== 'running') {
      this.pushSystemMessage('No Shogo request is currently running.')
      await this.postState()
      return
    }
    this.requestStatus = 'stopping'
    this.addTimeline('request', 'Stop requested', 'Aborting the active Shogo bridge request.')
    this.activeAbortController.abort()
    await this.postState()
  }

  private async runQueuedPrompt(): Promise<void> {
    const queued = this.queuedPrompt
    if (!queued || this.requestStatus !== 'idle') return
    this.queuedPrompt = null
    this.addTimeline('queue', 'Sending queued follow-up', `${modeContract(queued.mode).label} · ${queued.prompt.slice(0, 140)}`)
    await this.startPromptRequest(queued.prompt, queued.model, queued.mode)
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const msg = raw as WebviewMessage
    if (!msg || typeof msg.type !== 'string') return

    if (msg.type === 'ready') {
      this.addTimeline('debug', 'Chat UI script loaded', 'Handlers attached')
      await this.postState()
      return
    }

    if (msg.type === 'webviewError') {
      const message = typeof msg.message === 'string' ? msg.message : 'Unknown webview error'
      this.pushSystemMessage(`Chat UI error: ${message}`)
      this.addTimeline('debug', 'Chat UI error', message)
      await this.postState()
      return
    }

    if (msg.type === 'newChat') {
      await this.newChat()
      return
    }

    if (msg.type === 'modeChanged') {
      if (isChatMode(msg.mode)) this.currentMode = msg.mode
      await this.postState()
      return
    }

    if (msg.type === 'handoffPlan') {
      await this.handoffPlanToAgent()
      return
    }

    if (msg.type === 'stopRequest') {
      await this.stopRequest()
      return
    }

    if (msg.type === 'clearTimeline') {
      this.operationTimeline.splice(0, this.operationTimeline.length)
      this.addTimeline('debug', 'Cleared operation timeline')
      await this.postState()
      return
    }

    if (msg.type === 'addSelection') {
      await this.addSelection()
      return
    }

    if (msg.type === 'addActiveFile') {
      await this.addActiveFile()
      return
    }

    if (msg.type === 'openContextPicker') {
      await this.openContextPicker()
      return
    }

    if (msg.type === 'requestContextSuggestions') {
      await this.postContextSuggestions(msg.query)
      return
    }

    if (msg.type === 'addContextSuggestion') {
      if (typeof msg.contextId === 'string') await this.addSuggestionContext(msg.contextId)
      return
    }

    if (msg.type === 'removeContext') {
      if (typeof msg.contextId === 'string') this.removeContextItem(msg.contextId)
      await this.postState()
      return
    }

    if (msg.type === 'openContext') {
      if (typeof msg.contextId === 'string') await this.openContextItem(msg.contextId)
      return
    }

    if (msg.type === 'clearContext') {
      this.contextItems.clear()
      this.messages.push(createMessage('system', 'Context cleared.'))
      await this.postState()
      return
    }

    if (msg.type === 'previewAction') {
      if (typeof msg.actionId === 'string') await this.previewAction(msg.actionId)
      return
    }

    if (msg.type === 'rejectAction') {
      if (typeof msg.actionId === 'string') await this.rejectAction(msg.actionId)
      return
    }

    if (msg.type === 'undoAction') {
      if (typeof msg.actionId === 'string') await this.undoAction(msg.actionId)
      return
    }

    if (msg.type === 'runAction') {
      if (typeof msg.actionId === 'string') await this.runAction(msg.actionId)
      return
    }

    if (msg.type === 'sendPrompt') {
      const prompt = typeof msg.prompt === 'string' ? msg.prompt.trim() : ''
      const mode = isChatMode(msg.mode) ? msg.mode : this.currentMode
      this.currentMode = mode
      if (!prompt) return
      if (this.requestStatus === 'running' || this.requestStatus === 'stopping') {
        if (msg.operation === 'steer') this.steerRequest(prompt)
        else this.queuePrompt(prompt, mode, msg.model)
        await this.postState()
        return
      }
      await this.startPromptRequest(prompt, msg.model, mode)
    }
  }

  private async startPromptRequest(prompt: string, model: string | undefined, mode: ChatMode): Promise<void> {
    this.currentMode = mode
    this.pendingComposerText = ''
    this.requestStatus = 'running'
    this.activeAbortController = new AbortController()
    this.addTimeline('request', `Started ${modeContract(mode).label} request`, prompt.slice(0, 160))
    this.messages.push(createMessage('user', prompt))
    const assistantMessage = createMessage('assistant', 'Thinking…')
    this.messages.push(assistantMessage)
    await this.postState()
    const response = await this.sendPrompt(prompt, model, mode, this.activeAbortController.signal, (text) => {
      assistantMessage.text = text || 'Thinking…'
      void this.postState()
    }, (action) => {
      this.addTimeline('action', action.title || action.kind, `${action.kind} · ${action.filePath || action.uri || action.command || 'pending'}`)
      if (!actionAllowedInMode(action, mode)) {
        assistantMessage.actions = [...(assistantMessage.actions ?? []), { ...action, status: 'rejected', error: blockedActionMessage(action, mode), reviewSummary: `Blocked by ${modeContract(mode).label} mode contract.` }]
      } else {
        assistantMessage.actions = [...(assistantMessage.actions ?? []), action]
      }
      void this.postState()
    }, (event) => {
      if (event.type && event.type !== 'text-delta' && event.type !== 'text') this.addTimeline('stream', String(event.type), event.toolName || event.message || event.kind)
    })
    if (response.ok === false) {
      assistantMessage.role = 'system'
      assistantMessage.text = response.error || 'Shogo Agent Chat request failed.'
      this.addTimeline('request', 'Request failed', assistantMessage.text)
    } else {
      assistantMessage.text = response.message || 'Shogo returned an empty response.'
      if (response.actions?.length) assistantMessage.actions = response.actions.map((action) => actionAllowedInMode(action, mode) ? action : { ...action, status: 'rejected', error: blockedActionMessage(action, mode), reviewSummary: `Blocked by ${modeContract(mode).label} mode contract.` })
      if (mode === 'plan') this.lastPlanText = assistantMessage.text
      this.addTimeline('request', 'Request completed', `${assistantMessage.text.length} chars · ${response.actions?.length ?? 0} action(s)`)
    }
    this.activeAbortController = null
    this.requestStatus = 'idle'
    await this.postState()
    await this.runQueuedPrompt()
  }

  private buildAgentMessages(prompt: string, mode: ChatMode): Array<{ role: 'user' | 'assistant'; parts: Array<{ type: 'text'; text: string }> }> {
    const context = Array.from(this.contextItems.values())
    const contextText = summarizeContextForPrompt(context)
    const modeText = `\n\n${buildModeInstruction(modeContract(mode))}`
    const steeringText = this.steeringNotes.length ? `\n\n[Shogo steering notes captured while previous requests were running]\n${this.steeringNotes.map((note, index) => `${index + 1}. ${note}`).join('\n')}` : ''
    const history = this.messages
      .filter((message) => (message.role === 'user' || message.role === 'assistant') && message.text.trim() && message.text !== 'Thinking…')
      .map((message) => toAgentMessage(message.role as 'user' | 'assistant', message.text))

    if (history.length === 0 || history[history.length - 1].role !== 'user') {
      history.push(toAgentMessage('user', `${prompt}${contextText}${modeText}${steeringText}`))
    } else {
      const last = history[history.length - 1]
      last.parts = [{ type: 'text', text: `${prompt}${contextText}${modeText}${steeringText}` }]
    }

    return history
  }

  private async sendPrompt(prompt: string, model: string | undefined, mode: ChatMode, signal: AbortSignal, onText: (text: string) => void, onAction: (action: IdeAction) => void, onEvent: (event: Record<string, any>) => void): Promise<BridgeResponse> {
    const bridge = getBridgeConfig()
    const contract = modeContract(mode)
    const context = Array.from(this.contextItems.values())
    const ideContext = collectRichIdeContext(context)
    if (!bridge.url) {
      return {
        ok: false,
        error: `Shogo Desktop agent bridge is not configured. Launch Shogo IDE from Shogo Desktop so it can pass the local agent URL, or set shogo.agentChat.bridgeUrl to ${getWorkspaceFolders()[0] ? 'the local Desktop API URL' : 'http://localhost:39100'}.`,
      }
    }

    const requestBody = JSON.stringify({
      messages: this.buildAgentMessages(prompt, mode),
      chatSessionId: this.chatSessionId,
      interactionMode: mode,
      chatMode: mode,
      modeContract: contract,
      availableModes: allModeContracts(),
      ...(model && model !== 'auto' ? { agentMode: model } : {}),
      ide: ideContext,
      ideContext,
      ideActionProtocol: {
        version: 2,
        actions: contract.allowedActions,
        modeContracts: allModeContracts(),
        delivery: 'stream-event',
        eventTypes: ['ide-action', 'shogo-ide-action'],
        requiresUserConfirmation: true,
        shellCommandsRequireWorkspaceTrust: true,
        contextAttachments: {
          hashMentions: true,
          atMentions: true,
          slashCommands: true,
          picker: true,
          types: ['selection', 'activeFile', 'file', 'folder', 'symbol', 'diagnostic', 'terminal'],
          dedupe: true,
          staleFileWatch: true,
        },
        editReview: {
          diffPreview: true,
          checkpoints: true,
          rejectBeforeApply: true,
          undoAfterApply: true,
        },
        planHandoff: {
          enabled: true,
          sourceMode: 'plan',
          targetMode: 'agent',
          reviewBeforeSend: true,
        },
        agentOperations: {
          stop: true,
          queueFollowUps: true,
          steeringNotes: true,
          operationTimeline: true,
          debugPayload: true,
          subagents: { enabled: true, handoffOnly: true },
        },
      },
    })
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-chat-session-id': this.chatSessionId,
      ...(bridge.token ? { authorization: `Bearer ${bridge.token}` } : {}),
    }
    this.setDebugSnapshot(bridge.url, requestBody, headers)

    try {
      let response = await fetch(`${bridge.url}/agent/chat`, {
        method: 'POST',
        headers,
        body: requestBody,
        signal,
      })
      if (response.status === 404 || response.status === 401) {
        response = await fetch(`${bridge.url}/api/agent/chat`, {
          method: 'POST',
          headers,
          body: requestBody,
          signal,
        })
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as BridgeResponse
        return { ok: false, error: body.error || `Shogo agent backend returned HTTP ${response.status}.` }
      }

      const stream = await readAgentStream(response, onText, onAction, onEvent)
      if (stream.error) return { ok: false, error: stream.error, actions: stream.actions }
      return { ok: true, message: stream.text || 'Shogo returned an empty response.', actions: stream.actions }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return { ok: false, error: 'Shogo request stopped by user.' }
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private findAction(actionId: string): IdeAction | null {
    for (const message of this.messages) {
      const action = message.actions?.find((candidate) => candidate.id === actionId)
      if (action) return action
    }
    return null
  }

  private resolveActionUri(action: IdeAction): vscode.Uri {
    if (action.uri) return vscode.Uri.parse(action.uri)
    if (!action.filePath) throw new Error('Action is missing a file path.')
    const uriFactory = (vscode.Uri as any).file as undefined | ((value: string) => vscode.Uri)
    if (action.filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(action.filePath)) {
      if (!uriFactory) return vscode.Uri.parse(`file://${action.filePath}`)
      return uriFactory(action.filePath)
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
    if (!workspaceFolder) throw new Error('Open a workspace before applying file actions.')
    const basePath = workspaceFolder.uri.fsPath.replace(/[\\/]$/, '')
    const fullPath = `${basePath}/${action.filePath.replace(/^\.\//, '')}`
    if (!uriFactory) return vscode.Uri.parse(`file://${fullPath}`)
    return uriFactory(fullPath)
  }

  private async readTextFile(uri: vscode.Uri): Promise<string> {
    const workspaceApi = vscode.workspace as any
    const fsApi = workspaceApi.fs
    if (fsApi?.readFile) {
      try {
        return new TextDecoder().decode(await fsApi.readFile(uri))
      } catch {
        return ''
      }
    }
    try {
      const document = await workspaceApi.openTextDocument(uri)
      return document.getText()
    } catch {
      return ''
    }
  }

  private async writeTextFile(uri: vscode.Uri, content: string): Promise<void> {
    const fsApi = (vscode.workspace as any).fs
    if (!fsApi?.writeFile) throw new Error('VS Code workspace file API is unavailable.')
    await fsApi.writeFile(uri, new TextEncoder().encode(content))
  }

  private buildReviewUri(actionId: string, side: 'original' | 'proposed'): vscode.Uri {
    return vscode.Uri.parse(`shogo-review:/${encodeURIComponent(actionId)}/${side}.txt`)
  }

  private async createActionReview(action: IdeAction): Promise<ActionReview> {
    const existing = actionReviews.get(action.id)
    if (existing) return existing
    const uri = this.resolveActionUri(action)
    const originalText = await this.readTextFile(uri)
    let proposedText = ''
    if (action.kind === 'writeFile') {
      if (typeof action.content !== 'string') throw new Error('writeFile action is missing content.')
      proposedText = action.content
    } else {
      if (typeof action.content === 'string' && !action.find) {
        proposedText = action.content
      } else {
        if (!action.find) throw new Error('workspaceEdit action needs either content or find/replace text.')
        if (!originalText.includes(action.find)) throw new Error(`Could not find requested text in ${action.filePath || action.uri}.`)
        proposedText = originalText.replace(action.find, action.replace ?? '')
      }
    }
    const originalUri = this.buildReviewUri(action.id, 'original')
    const proposedUri = this.buildReviewUri(action.id, 'proposed')
    const targetLabel = action.filePath || action.uri || uri.toString()
    const review: ActionReview = {
      actionId: action.id,
      targetLabel,
      uri,
      originalText,
      proposedText,
      originalUri,
      proposedUri,
      applied: false,
    }
    actionReviews.set(action.id, review)
    reviewDocuments.set(originalUri.toString(), originalText)
    reviewDocuments.set(proposedUri.toString(), proposedText)
    action.hasCheckpoint = true
    action.reviewSummary = `Review ready · ${targetLabel} · ${originalText.length} → ${proposedText.length} chars`
    return review
  }

  private async previewActionReview(action: IdeAction): Promise<string> {
    if (!isEditAction(action)) return 'Only edit actions have a diff preview.'
    const review = await this.createActionReview(action)
    await vscode.commands.executeCommand('vscode.diff', review.originalUri, review.proposedUri, `Shogo review: ${review.targetLabel}`)
    action.reviewSummary = `Diff preview opened · ${review.targetLabel}`
    return `Opened Shogo diff preview for ${review.targetLabel}.`
  }

  private async rejectActionReview(action: IdeAction): Promise<string> {
    if (action.status !== 'pending') throw new Error('Only pending actions can be rejected.')
    action.status = 'rejected'
    action.result = `Rejected ${action.title}. No files were changed.`
    return action.result
  }

  private async undoActionCheckpoint(action: IdeAction): Promise<string> {
    const review = actionReviews.get(action.id)
    if (!review || !review.applied) throw new Error('No applied checkpoint is available for this action.')
    await this.writeTextFile(review.uri, review.originalText)
    review.applied = false
    action.status = 'undone'
    action.result = `Restored checkpoint for ${review.targetLabel}.`
    return action.result
  }

  private async executeIdeAction(action: IdeAction): Promise<string> {
    if (!actionAllowedInMode(action, this.currentMode)) throw new Error(blockedActionMessage(action, this.currentMode))
    if ((action.kind === 'workspaceEdit' || action.kind === 'writeFile' || action.kind === 'runCommand') && !vscode.workspace.isTrusted) {
      throw new Error('Workspace trust is required before Shogo can edit files or run commands.')
    }

    if (action.kind === 'openFile') {
      const document = await (vscode.workspace as any).openTextDocument(this.resolveActionUri(action))
      await (vscode.window as any).showTextDocument(document, { preview: false })
      return `Opened ${action.filePath || action.uri}.`
    }

    if (isEditAction(action)) {
      const review = await this.createActionReview(action)
      const currentText = await this.readTextFile(review.uri)
      if (currentText !== review.originalText) {
        const approved = await vscode.window.showWarningMessage(`The file changed after Shogo prepared this edit. Apply the reviewed version anyway?\n\n${review.targetLabel}`, 'Apply anyway', 'Cancel')
        if (approved !== 'Apply anyway') throw new Error('Edit was cancelled because the file changed.')
      }
      await this.writeTextFile(review.uri, review.proposedText)
      review.applied = true
      action.hasCheckpoint = true
      action.reviewSummary = `Applied with checkpoint · ${review.targetLabel}`
      return `Applied reviewed edit to ${review.targetLabel}.`
    }

    if (!action.command) throw new Error('runCommand action is missing a command.')
    const approved = await vscode.window.showWarningMessage(`Run command from Shogo?\n\n${action.command}`, 'Run', 'Cancel')
    if (approved !== 'Run') throw new Error('Command was cancelled.')
    const terminalFactory = (vscode.window as any).createTerminal as undefined | ((options: { name: string; cwd?: string }) => { show: () => void; sendText: (text: string, addNewLine?: boolean) => void })
    if (!terminalFactory) throw new Error('VS Code terminal API is unavailable.')
    const terminal = terminalFactory({ name: 'Shogo Agent Action', cwd: action.cwd })
    terminal.show()
    terminal.sendText([action.command, ...(action.args ?? [])].join(' '), true)
    return `Started command: ${action.command}.`
  }

  private async previewAction(actionId: string): Promise<void> {
    const action = this.findAction(actionId)
    if (!action || !isEditAction(action) || action.status !== 'pending') return
    try {
      const result = await this.previewActionReview(action)
      this.messages.push(createMessage('system', result))
    } catch (error) {
      action.error = error instanceof Error ? error.message : String(error)
      this.messages.push(createMessage('system', `Review failed: ${action.error}`))
    }
    await this.postState()
  }

  private async rejectAction(actionId: string): Promise<void> {
    const action = this.findAction(actionId)
    if (!action || action.status !== 'pending') return
    try {
      const result = await this.rejectActionReview(action)
      this.messages.push(createMessage('system', result))
    } catch (error) {
      action.error = error instanceof Error ? error.message : String(error)
      this.messages.push(createMessage('system', `Reject failed: ${action.error}`))
    }
    await this.postState()
  }

  private async undoAction(actionId: string): Promise<void> {
    const action = this.findAction(actionId)
    if (!action || !isEditAction(action)) return
    try {
      const result = await this.undoActionCheckpoint(action)
      this.messages.push(createMessage('system', result))
    } catch (error) {
      action.error = error instanceof Error ? error.message : String(error)
      this.messages.push(createMessage('system', `Undo failed: ${action.error}`))
    }
    await this.postState()
  }

  private async runAction(actionId: string): Promise<void> {
    const action = this.findAction(actionId)
    if (!action || action.status === 'running' || action.status === 'rejected' || action.status === 'undone') return
    action.status = 'running'
    action.error = undefined
    action.result = undefined
    await this.postState()
    try {
      action.result = await this.executeIdeAction(action)
      action.status = 'completed'
      this.messages.push(createMessage('system', action.result))
    } catch (error) {
      action.status = 'failed'
      action.error = error instanceof Error ? error.message : String(error)
      this.messages.push(createMessage('system', `Action failed: ${action.error}`))
    }
    await this.postState()
  }

  private updateNativeStatus(): void {
    if (!this.statusBarItem) return
    const bridge = getBridgeConfig()
    const pendingActions = this.messages.reduce((count, message) => count + (message.actions?.filter((action) => action.status === 'pending').length ?? 0), 0)
    this.statusBarItem.text = pendingActions > 0 ? `$(sparkle) Shogo ${pendingActions}` : '$(sparkle) Shogo'
    this.statusBarItem.tooltip = bridge.url
      ? `Shogo Chat connected · ${this.contextItems.size} context item${this.contextItems.size === 1 ? '' : 's'}`
      : 'Open Shogo Chat · Desktop agent bridge offline'
    this.statusBarItem.command = 'shogo.agentChat.open'
    this.statusBarItem.show?.()
  }

  private async postState(): Promise<void> {
    const bridge = getBridgeConfig()
    this.updateNativeStatus()
    await this.view?.webview.postMessage({
      type: 'state',
      state: {
        bridgeConfigured: Boolean(bridge.url),
        bridgeUrl: bridge.url,
        chatSessionId: this.chatSessionId,
        pendingComposerText: this.pendingComposerText,
        mode: this.currentMode,
        modes: allModeContracts(),
        canHandoffPlan: Boolean(this.lastPlanText),
        requestStatus: this.requestStatus,
        queuedPrompt: this.queuedPrompt ? { prompt: this.queuedPrompt.prompt, mode: this.queuedPrompt.mode } : null,
        steeringNotes: this.steeringNotes,
        operationTimeline: this.operationTimeline,
        debugSnapshot: this.debugSnapshot,
        nativePhase: 10,
        workspaceTrusted: vscode.workspace.isTrusted,
        workspaceFolders: getWorkspaceFolders(),
        richContext: collectRichIdeContext(Array.from(this.contextItems.values())),
        contextItems: Array.from(this.contextItems.values()).map((item) => ({
          id: item.id,
          kind: item.kind,
          label: item.label,
          detail: item.detail,
          uri: item.uri,
          stale: item.stale,
        })),
        messages: this.messages,
      },
    })
  }

  private render(webview: vscode.Webview): string {
    const scriptNonce = createNonce()
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${scriptNonce}'`,
    ].join('; ')

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Shogo Agent Chat</title>
  <style>
    :root {
      color-scheme: dark light;
      --shogo-orange: #f97316;
      --shogo-orange-strong: #fb923c;
      --shogo-radius-lg: 18px;
      --shogo-radius-md: 13px;
      --shogo-shadow: 0 18px 55px rgba(0, 0, 0, .25);
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body {
      margin: 0;
      height: 100vh;
      overflow: hidden;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    button, textarea, select { font: inherit; }
    button { cursor: pointer; }
    button:focus-visible, textarea:focus-visible, select:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .desktop-chat-shell {
      height: 100vh;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      background: var(--vscode-sideBar-background);
    }
    .chat-header {
      display: flex;
      align-items: stretch;
      justify-content: space-between;
      gap: 10px;
      min-height: 48px;
      padding: 0 8px;
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 72%, transparent);
      background: var(--vscode-sideBar-background);
    }
    .brand-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      max-width: 260px;
      padding: 0 12px;
      border-left: 1px solid transparent;
      border-right: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent);
      color: var(--vscode-foreground);
      background: color-mix(in srgb, var(--vscode-sideBar-background) 92%, var(--vscode-editor-background));
    }
    .brand-mark {
      width: 22px;
      height: 22px;
      display: grid;
      place-items: center;
      flex: none;
      color: var(--vscode-descriptionForeground);
      font-size: 18px;
      line-height: 1;
    }
    .brand-copy { min-width: 0; }
    .eyebrow, .status-dot { display: none; }
    .title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .title { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .title-close { color: var(--vscode-descriptionForeground); font-size: 18px; line-height: 1; }
    .header-actions { display: flex; align-items: center; justify-content: flex-end; gap: 4px; flex: 0 0 auto; min-width: 0; }
    .icon-button, .text-button, .send-button, .chip-button {
      border: 1px solid transparent;
      color: var(--vscode-button-secondaryForeground);
      background: transparent;
      border-radius: 10px;
    }
    .icon-button {
      width: 32px;
      height: 32px;
      padding: 0;
      display: grid;
      place-items: center;
      font-size: 18px;
    }
    .icon-button:hover, .text-button:hover, .chip-button:hover {
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-button-secondaryBackground));
      color: var(--vscode-foreground);
    }
    .conversation {
      position: relative;
      min-height: 0;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding: 18px 14px 14px;
      scroll-behavior: smooth;
    }
    .desktop-chat-shell.is-empty .conversation {
      justify-content: flex-start;
      padding-top: clamp(20px, 7vh, 64px);
    }
    .desktop-card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 12px;
      background: var(--vscode-editor-background);
      overflow: hidden;
      margin-bottom: 12px;
    }
    .session-card {
      position: absolute;
      z-index: 20;
      top: 10px;
      right: 12px;
      left: 12px;
      max-height: min(520px, calc(100% - 24px));
      overflow: auto;
      padding: 12px;
      border-color: color-mix(in srgb, var(--vscode-panel-border) 82%, var(--vscode-foreground));
      border-radius: 14px;
      background: var(--vscode-quickInput-background, var(--vscode-editor-background));
      box-shadow: 0 18px 48px rgba(0, 0, 0, .28);
    }
    .session-card[hidden] { display: none; }
    .session-top { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
    .session-top > div { min-width: 0; }
    .session-top > div:first-child { flex: 1 1 220px; }
    .session-top > div:last-child { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; flex: 1 1 160px; }
    .session-title { font-weight: 700; margin-bottom: 4px; }
    .session-subtitle { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.45; }
    .bridge-pill {
      border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-button-secondaryBackground);
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 11px;
      white-space: nowrap;
    }
    .context-strip { display: flex; flex-wrap: wrap; gap: 7px; min-height: 0; padding: 0 12px 2px; }
    .context-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      min-width: 0;
      border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
      border-radius: 999px;
      padding: 5px 9px;
      color: var(--vscode-descriptionForeground);
      background: color-mix(in srgb, var(--vscode-button-secondaryBackground) 50%, transparent);
      font-size: 11px;
      line-height: 1;
    }
    .context-chip span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .context-chip[data-open-context-id] { cursor: pointer; }
    .context-remove {
      border: 0;
      width: 16px;
      height: 16px;
      display: grid;
      place-items: center;
      border-radius: 999px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      padding: 0;
      line-height: 1;
    }
    .context-remove:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, var(--vscode-button-secondaryBackground)); }
    .mention-popover {
      margin: 0 12px 8px;
      max-height: 260px;
      overflow: auto;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 12px;
      background: var(--vscode-quickInput-background, var(--vscode-editor-background));
      box-shadow: 0 16px 40px rgba(0, 0, 0, .32);
    }
    .mention-popover[hidden] { display: none; }
    .mention-item {
      width: 100%;
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 9px;
      align-items: center;
      border: 0;
      color: var(--vscode-quickInput-foreground, var(--vscode-foreground));
      background: transparent;
      padding: 8px 10px;
      text-align: left;
    }
    .mention-item + .mention-item { border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 45%, transparent); }
    .mention-item:hover, .mention-item.active { background: var(--vscode-list-hoverBackground, var(--vscode-button-secondaryBackground)); }
    .mention-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; }
    .mention-detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .turns {
      display: flex;
      flex-direction: column;
      gap: 18px;
      width: 100%;
      max-width: 820px;
      margin: 0 auto;
    }
    .desktop-chat-shell.is-empty .turns { display: none; }
    .turn { display: grid; gap: 7px; }
    .turn.user { justify-items: end; }
    .turn.assistant, .turn.system { justify-items: start; }
    .turn-meta {
      display: flex;
      align-items: center;
      gap: 7px;
      color: var(--vscode-descriptionForeground);
      font-size: 10.5px;
      padding: 0 4px;
    }
    .avatar {
      width: 22px;
      height: 22px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      font-size: 11px;
      font-weight: 800;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-foreground);
    }
    .assistant .avatar { background: linear-gradient(135deg, var(--shogo-orange-strong), var(--shogo-orange)); color: #fff; }
    .bubble {
      max-width: min(680px, 94%);
      border: 0;
      border-radius: 18px;
      padding: 11px 13px;
      line-height: 1.5;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .assistant .bubble {
      background: transparent;
      padding-left: 4px;
    }
    .user .bubble {
      background: color-mix(in srgb, var(--vscode-button-secondaryBackground) 82%, transparent);
    }
    .system .bubble {
      max-width: 100%;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      font-size: 12px;
    }
    .action-list {
      width: min(640px, 94%);
      display: grid;
      gap: 8px;
    }
    .action-card {
      border: 1px solid color-mix(in srgb, var(--shogo-orange) 24%, var(--vscode-panel-border));
      border-radius: 13px;
      padding: 9px;
      background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--shogo-orange) 6%);
    }
    .action-top { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
    .action-title { font-weight: 750; font-size: 12px; }
    .action-meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 3px; overflow-wrap: anywhere; }
    .action-buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      margin-top: 8px;
    }
    .action-button {
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 9px;
      padding: 5px 8px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font-size: 12px;
    }
    .action-button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .action-button.danger {
      color: var(--vscode-errorForeground, var(--vscode-button-secondaryForeground));
      background: color-mix(in srgb, var(--vscode-errorForeground, #f87171) 12%, var(--vscode-button-secondaryBackground));
    }
    .action-button[disabled] { opacity: .62; cursor: default; }
    .action-review { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 6px; }
    .composer-wrap {
      position: sticky;
      bottom: 0;
      z-index: 10;
      width: 100%;
      max-width: 820px;
      margin: auto auto 0;
      padding: 8px 0 0;
      background: linear-gradient(to top, var(--vscode-sideBar-background) 76%, transparent);
    }
    .desktop-chat-shell.is-empty .composer-wrap {
      position: relative;
      bottom: auto;
      max-width: 760px;
      margin: 0 auto;
      padding: 0;
      background: transparent;
    }
    .composer-card {
      border: 1px solid color-mix(in srgb, var(--vscode-input-border, var(--vscode-panel-border)) 82%, var(--vscode-foreground));
      border-radius: 22px;
      background: color-mix(in srgb, var(--vscode-input-background) 92%, var(--vscode-editor-background));
      overflow: hidden;
      box-shadow: none;
    }
    .composer-card:focus-within {
      border-color: color-mix(in srgb, var(--vscode-focusBorder) 74%, var(--vscode-panel-border));
    }
    textarea {
      width: 100%;
      min-height: 76px;
      max-height: 240px;
      resize: vertical;
      display: block;
      border: 0;
      outline: none;
      padding: 14px 16px 8px;
      color: var(--vscode-input-foreground);
      background: transparent;
      line-height: 1.45;
      font-size: 14px;
    }
    .desktop-chat-shell.is-empty textarea {
      min-height: clamp(178px, 28vh, 260px);
      padding: 20px 20px 10px;
      font-size: 15px;
    }
    textarea::placeholder { color: color-mix(in srgb, var(--vscode-input-placeholderForeground) 86%, transparent); }
    .composer-toolbar {
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      padding: 8px 12px 12px;
      border-top: 0;
    }
    .left-tools, .right-tools {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 7px;
      min-width: 0;
    }
    .left-tools { flex: 999 1 260px; }
    .right-tools { flex: 1 1 250px; justify-content: flex-end; }
    .desktop-chat-shell.is-empty .left-tools { flex: 0 1 auto; }
    .desktop-chat-shell.is-empty .right-tools { flex: 1 1 auto; }
    .chip-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-height: 30px;
      padding: 5px 9px;
      font-size: 12px;
      white-space: nowrap;
    }
    .pill-button, .mode-select.primary {
      color: var(--vscode-foreground);
      background: var(--vscode-button-secondaryBackground);
      border-radius: 999px;
      font-weight: 650;
    }
    .mode-select {
      min-height: 30px;
      max-width: 150px;
      border: 1px solid transparent;
      color: var(--vscode-button-secondaryForeground);
      background: transparent;
      border-radius: 9px;
      padding: 0 5px;
      outline: none;
    }
    .mode-select:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-button-secondaryBackground)); }
    .mode-handoff { margin-left: 0; }
    .mode-note { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 4px; }
    .ops-panel {
      margin-top: 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 13px;
      background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-button-secondaryBackground));
      overflow: hidden;
    }
    .ops-panel[hidden] { display: none; }
    .ops-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
    .ops-title { font-weight: 750; font-size: 12px; }
    .ops-body { display: grid; gap: 8px; padding: 10px; }
    .timeline { display: grid; gap: 6px; max-height: 150px; overflow: auto; }
    .timeline-item { border-left: 2px solid var(--shogo-orange); padding: 2px 0 2px 8px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .timeline-item strong { display: block; color: var(--vscode-foreground); font-size: 11.5px; }
    .debug-pre {
      max-height: 210px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      border-radius: 10px;
      padding: 8px;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
    }
    .queued-note { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .send-button {
      min-width: 34px;
      min-height: 34px;
      padding: 6px 10px;
      color: var(--vscode-button-foreground);
      background: linear-gradient(135deg, var(--shogo-orange-strong), var(--shogo-orange));
      border-radius: 12px;
      font-weight: 800;
      font-size: 14px;
    }
    .send-button:hover { filter: brightness(1.08); }
    .hint-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin-top: 7px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    @media (max-width: 620px) {
      .conversation { padding: 14px 10px 10px; }
      .composer-wrap { max-width: none; }
      .left-tools, .right-tools { flex: 1 1 100%; }
      .left-tools { justify-content: flex-start; }
      .right-tools { justify-content: flex-end; }
      .desktop-chat-shell.is-empty .composer-toolbar { align-items: stretch; flex-direction: column; }
    }
    @media (max-width: 430px) {
      .chat-header { padding: 0 6px; }
      .brand-wrap { padding: 0 8px; }
      .title { font-size: 14px; }
      .header-actions { gap: 2px; }
      .composer-toolbar { align-items: stretch; flex-direction: column; }
      .left-tools, .right-tools { justify-content: space-between; }
      .chip-button, .mode-select, .send-button { flex: 1 1 auto; }
      .mode-select { max-width: none; }
      .hint-row { flex-direction: column; }
    }
    @media (max-width: 330px) {
      .conversation { padding: 10px 8px 8px; }
      .chip-button, .send-button { padding-left: 7px; padding-right: 7px; }
      .icon-button { width: 28px; height: 28px; }
    }
  </style>
</head>
<body>
  <main id="shell" class="desktop-chat-shell is-empty" data-shogo-desktop-chat-ui="true">
    <header class="chat-header">
      <div class="brand-wrap" aria-label="Current chat tab">
        <div class="brand-mark" aria-hidden="true">▱</div>
        <div class="brand-copy">
          <div class="eyebrow">Shogo Agent</div>
          <div class="title-row"><span class="title">New Agent</span><span class="title-close" aria-hidden="true">×</span></div>
        </div>
      </div>
      <div class="header-actions">
        <button id="newChat" class="icon-button" title="New chat" aria-label="New chat">＋</button>
        <button id="toggleOps" class="icon-button" title="History and operations" aria-label="History and operations">◷</button>
        <button id="openContextPickerTop" class="icon-button" title="Pick context" aria-label="Pick context">@</button>
        <button id="addActiveFileTop" class="icon-button" title="Attach active file" aria-label="Attach active file">□</button>
      </div>
    </header>

    <section id="scroll" class="conversation">
      <section id="statusPanel" class="desktop-card session-card" hidden>
        <div class="session-top">
          <div>
            <div class="session-title">Chat context</div>
            <div id="status" class="session-subtitle">Loading workspace context…</div>
            <div id="modeNote" class="mode-note">Agent can edit and run reviewed actions.</div>
          </div>
          <div>
            <div id="bridgePill" class="bridge-pill">Local</div>
            <button id="handoffPlan" class="chip-button mode-handoff" title="Implement the last plan in Agent mode" hidden>Implement plan</button>
          </div>
        </div>
        <section id="opsPanel" class="ops-panel">
          <div class="ops-header"><span class="ops-title">Recent activity</span><button id="clearTimeline" class="chip-button">Clear</button></div>
          <div class="ops-body">
            <div id="queuedNote" class="queued-note"></div>
            <div id="timeline" class="timeline"></div>
            <details>
              <summary class="queued-note">Chat Debug / last request payload</summary>
              <pre id="debugPayload" class="debug-pre">No request captured yet.</pre>
            </details>
          </div>
        </section>
      </section>

      <section id="messages" class="turns" aria-live="polite"></section>

      <section class="composer-wrap" aria-label="Chat composer">
        <div class="composer-card">
          <textarea id="prompt" placeholder="Plan, Build, / for skills, @ for context" aria-label="Message Shogo"></textarea>
          <div id="contextSuggest" class="mention-popover" role="listbox" hidden></div>
          <div id="context" class="context-strip" aria-label="Attached context"></div>
          <div class="composer-toolbar">
            <div class="left-tools">
              <button id="openContextPicker" class="chip-button" title="Pick context">@ Context</button>
              <button id="addSelection" class="chip-button" title="Attach selected code">＋ Selection</button>
              <button id="addActiveFile" class="chip-button" title="Attach active file">File</button>
            </div>
            <div class="right-tools">
              <select id="mode" class="mode-select primary" title="Chat mode" aria-label="Chat mode">
                <option value="agent" selected>∞ Agent</option>
                <option value="plan">Plan</option>
                <option value="edit">Edit</option>
                <option value="ask">Ask</option>
              </select>
              <select id="model" class="mode-select" title="Model" aria-label="Model">
                <option value="auto">Auto</option>
                <option value="fast">Fast</option>
                <option value="capable">Composer 2.5</option>
              </select>
              <button id="steer" class="chip-button" title="Steer the running request" hidden>Steer</button>
              <button id="stop" class="chip-button" title="Stop the running request" hidden>Stop</button>
              <button id="send" class="send-button" type="button" title="Send with Enter" aria-label="Send message">↵</button>
            </div>
          </div>
        </div>
        <div class="hint-row">
          <span>Enter to send · Shift+Enter for newline · @ or # for context · / for skills</span>
          <span id="modeHint">Agent mode</span>
        </div>
      </section>
    </section>
  </main>

  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    function reportWebviewError(error) {
      const message = error && error.message ? error.message : String(error || 'Unknown webview error');
      try { vscode.postMessage({ type: 'webviewError', message: message }); } catch {}
    }
    window.addEventListener('error', function(event) { reportWebviewError(event.error || event.message); });
    window.addEventListener('unhandledrejection', function(event) { reportWebviewError(event.reason); });
    const shellEl = document.getElementById('shell');
    const statusPanelEl = document.getElementById('statusPanel');
    const statusEl = document.getElementById('status');
    const bridgePillEl = document.getElementById('bridgePill');
    const modeNoteEl = document.getElementById('modeNote');
    const modeHintEl = document.getElementById('modeHint');
    const handoffPlanEl = document.getElementById('handoffPlan');
    const toggleOpsEl = document.getElementById('toggleOps');
    const opsPanelEl = document.getElementById('opsPanel');
    const queuedNoteEl = document.getElementById('queuedNote');
    const timelineEl = document.getElementById('timeline');
    const debugPayloadEl = document.getElementById('debugPayload');
    const clearTimelineEl = document.getElementById('clearTimeline');
    const contextEl = document.getElementById('context');
    const messagesEl = document.getElementById('messages');
    const scrollEl = document.getElementById('scroll');
    const promptEl = document.getElementById('prompt');
    const modeEl = document.getElementById('mode');
    const modelEl = document.getElementById('model');
    const steerEl = document.getElementById('steer');
    const stopEl = document.getElementById('stop');
    const sendEl = document.getElementById('send');
    const contextSuggestEl = document.getElementById('contextSuggest');
    let mentionStart = -1;
    let mentionQuery = '';
    let mentionPrefix = '@';
    let suggestMode = 'context';
    let activeSuggestionIndex = 0;
    let runtimeRequestRunning = false;
    let allowNextLineBreak = false;
    let contextSuggestDebounce = 0;
    let pendingState = null;
    let stateFrame = 0;

    function modeLabel(mode) {
      if (mode === 'ask') return 'Ask';
      if (mode === 'edit') return 'Edit';
      if (mode === 'plan') return 'Plan';
      return 'Agent';
    }

    function modeDescription(mode) {
      if (mode === 'ask') return 'Ask mode is read-only: explain, answer, and suggest next steps.';
      if (mode === 'edit') return 'Edit mode allows reviewed file edits, but blocks shell commands.';
      if (mode === 'plan') return 'Plan mode is read-only and prepares an implementation handoff.';
      return 'Agent mode allows reviewed edits, open-file actions, and confirmed commands.';
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>'"]/g, function(ch) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch];
      });
    }

    function formatTime(value) {
      try {
        return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      } catch {
        return '';
      }
    }

    function roleLabel(role) {
      if (role === 'user') return 'You';
      if (role === 'system') return 'System';
      return 'Shogo';
    }

    function roleInitial(role) {
      if (role === 'user') return 'Y';
      if (role === 'system') return '!';
      return 'S.';
    }

    function contextIcon(kind) {
      if (kind === 'selection') return '⌁';
      if (kind === 'folder') return '▣';
      if (kind === 'symbol') return '◇';
      if (kind === 'diagnostic') return '⚠';
      if (kind === 'terminal') return '▹';
      return '□';
    }

    function contextKindLabel(kind) {
      return kind === 'activeFile' ? 'active file' : kind;
    }

    function renderContext(items) {
      if (!items.length) {
        contextEl.innerHTML = '';
        return;
      }
      contextEl.innerHTML = items.map(function(item) {
        const icon = contextIcon(item.kind);
        const title = contextKindLabel(item.kind) + ': ' + item.label + (item.detail ? ' — ' + item.detail : '');
        return '<span class="context-chip" title="' + escapeHtml(title) + '" data-open-context-id="' + escapeHtml(item.id) + '"><strong>' + icon + '</strong><span>' + escapeHtml(item.label) + '</span><button class="context-remove" title="Remove context" aria-label="Remove context" data-remove-context-id="' + escapeHtml(item.id) + '">×</button></span>';
      }).join('');
    }

    function currentMention() {
      const cursor = promptEl.selectionStart || 0;
      const before = promptEl.value.slice(0, cursor);
      const slash = before.match(/(^|\\s)\\/([\\w-]*)$/);
      if (slash) return { start: cursor - slash[2].length - 1, prefix: '/', query: slash[2] };
      const match = before.match(/(^|\\s)([#@])([\\w./:-]*)$/);
      if (!match) return null;
      return { start: cursor - match[3].length - 1, prefix: match[2], query: match[3] };
    }

    function requestContextSuggestions() {
      const mention = currentMention();
      if (!mention) {
        mentionStart = -1;
        mentionQuery = '';
        contextSuggestEl.hidden = true;
        activeSuggestionIndex = 0;
        return;
      }
      mentionStart = mention.start;
      mentionQuery = mention.query;
      mentionPrefix = mention.prefix || '@';
      suggestMode = mentionPrefix === '/' ? 'slash' : 'context';
      activeSuggestionIndex = 0;
      window.clearTimeout(contextSuggestDebounce);
      if (suggestMode === 'slash') {
        renderSlashSuggestions(mentionQuery);
        return;
      }
      contextSuggestDebounce = window.setTimeout(function() {
        vscode.postMessage({ type: 'requestContextSuggestions', query: mentionQuery });
      }, 80);
    }

    function renderContextSuggestions(suggestions) {
      if (!suggestions || !suggestions.length || mentionStart < 0) {
        contextSuggestEl.hidden = true;
        return;
      }
      contextSuggestEl.hidden = false;
      contextSuggestEl.innerHTML = suggestions.map(function(item) {
        const active = suggestions.indexOf(item) === activeSuggestionIndex ? ' active' : '';
        return '<button class="mention-item' + active + '" data-add-context-id="' + escapeHtml(item.id) + '" role="option"><strong>' + contextIcon(item.kind) + '</strong><span><span class="mention-label">' + escapeHtml(item.label) + '</span><span class="mention-detail">' + escapeHtml(contextKindLabel(item.kind) + (item.detail ? ' · ' + item.detail : '')) + '</span></span><span>' + escapeHtml(mentionPrefix) + '</span></button>';
      }).join('');
    }

    function renderSlashSuggestions(query) {
      const commands = [
        { id: 'agent', label: 'Agent', detail: 'Plan and execute reviewed workspace actions', mode: 'agent' },
        { id: 'plan', label: 'Plan', detail: 'Create an implementation plan before editing', mode: 'plan' },
        { id: 'edit', label: 'Edit', detail: 'Apply reviewed file edits only', mode: 'edit' },
        { id: 'ask', label: 'Ask', detail: 'Read-only explanation and review', mode: 'ask' }
      ].filter(function(command) { return !query || command.id.indexOf(query.toLowerCase()) === 0 || command.label.toLowerCase().indexOf(query.toLowerCase()) === 0; });
      if (!commands.length) {
        contextSuggestEl.hidden = true;
        return;
      }
      contextSuggestEl.hidden = false;
      contextSuggestEl.innerHTML = commands.map(function(command, index) {
        const active = index === activeSuggestionIndex ? ' active' : '';
        return '<button class="mention-item' + active + '" data-slash-mode="' + escapeHtml(command.mode) + '" role="option"><strong>/</strong><span><span class="mention-label">' + escapeHtml(command.label) + '</span><span class="mention-detail">' + escapeHtml(command.detail) + '</span></span><span>↵</span></button>';
      }).join('');
    }

    function suggestionItems() {
      return Array.from(contextSuggestEl.querySelectorAll('[data-add-context-id], [data-slash-mode]'));
    }

    function moveActiveSuggestion(delta) {
      const items = suggestionItems();
      if (!items.length) return;
      activeSuggestionIndex = (activeSuggestionIndex + delta + items.length) % items.length;
      items.forEach(function(item, index) { item.classList.toggle('active', index === activeSuggestionIndex); });
      items[activeSuggestionIndex].scrollIntoView({ block: 'nearest' });
    }

    function applySlashCommand(mode) {
      if (mentionStart < 0) return;
      const cursor = promptEl.selectionStart || 0;
      promptEl.value = promptEl.value.slice(0, mentionStart) + promptEl.value.slice(cursor).replace(/^\\s*/, '');
      modeEl.value = mode;
      modeNoteEl.textContent = modeDescription(modeEl.value);
      modeHintEl.textContent = modeLabel(modeEl.value) + ' mode';
      vscode.postMessage({ type: 'modeChanged', mode: modeEl.value });
      contextSuggestEl.hidden = true;
      mentionStart = -1;
      promptEl.focus();
    }

    function replaceMentionWithChipLabel(label) {
      if (mentionStart < 0) return;
      const cursor = promptEl.selectionStart || 0;
      promptEl.value = promptEl.value.slice(0, mentionStart) + mentionPrefix + label + ' ' + promptEl.value.slice(cursor);
      contextSuggestEl.hidden = true;
      mentionStart = -1;
      promptEl.focus();
    }

    function renderAction(action) {
      const target = action.filePath || action.uri || action.command || '';
      const isEdit = action.kind === 'workspaceEdit' || action.kind === 'writeFile';
      const pending = action.status === 'pending';
      const canUndo = isEdit && action.status === 'completed' && action.hasCheckpoint;
      const runLabel = pending ? (action.kind === 'runCommand' ? 'Run' : action.kind === 'openFile' ? 'Open' : 'Apply') : action.status;
      const detail = action.error || action.result || action.description || target;
      const review = action.reviewSummary ? '<div class="action-review">' + escapeHtml(action.reviewSummary) + '</div>' : '';
      const buttons = [];
      if (pending && isEdit) buttons.push('<button class="action-button secondary" data-preview-action-id="' + escapeHtml(action.id) + '">Preview diff</button>');
      buttons.push('<button class="action-button" data-action-id="' + escapeHtml(action.id) + '"' + (!pending ? ' disabled' : '') + '>' + escapeHtml(runLabel) + '</button>');
      if (pending && isEdit) buttons.push('<button class="action-button danger" data-reject-action-id="' + escapeHtml(action.id) + '">Reject</button>');
      if (canUndo) buttons.push('<button class="action-button secondary" data-undo-action-id="' + escapeHtml(action.id) + '">Undo checkpoint</button>');
      return '<div class="action-card">'
        + '<div class="action-top"><div><div class="action-title">' + escapeHtml(action.title || action.kind) + '</div><div class="action-meta">' + escapeHtml(action.kind + (target ? ' · ' + target : '')) + '</div></div><span class="bridge-pill">' + escapeHtml(action.status) + '</span></div>'
        + (detail ? '<div class="action-meta">' + escapeHtml(detail) + '</div>' : '')
        + review
        + '<div class="action-buttons">' + buttons.join('') + '</div>'
        + '</div>';
    }

    function renderTimeline(items) {
      if (!items || !items.length) {
        timelineEl.innerHTML = '<div class="queued-note">No operation events yet.</div>';
        return;
      }
      timelineEl.innerHTML = items.slice().reverse().map(function(item) {
        return '<div class="timeline-item"><strong>' + escapeHtml(item.kind + ' · ' + item.title) + '</strong><span>' + escapeHtml(formatTime(item.createdAt) + (item.detail ? ' · ' + item.detail : '')) + '</span></div>';
      }).join('');
    }

    function renderDebugPayload(snapshot) {
      if (!snapshot) {
        debugPayloadEl.textContent = 'No request captured yet.';
        return;
      }
      debugPayloadEl.textContent = JSON.stringify({ createdAt: snapshot.createdAt, bridgeUrl: snapshot.bridgeUrl, headers: snapshot.headers, request: JSON.parse(snapshot.requestBody) }, null, 2);
    }

    function renderMessages(messages) {
      messagesEl.innerHTML = messages.map(function(msg) {
        const actions = msg.actions && msg.actions.length ? '<div class="action-list">' + msg.actions.map(renderAction).join('') + '</div>' : '';
        return '<article class="turn ' + escapeHtml(msg.role) + '">'
          + '<div class="turn-meta"><span class="avatar">' + escapeHtml(roleInitial(msg.role)) + '</span><span>' + escapeHtml(roleLabel(msg.role)) + '</span><span>·</span><span>' + escapeHtml(formatTime(msg.createdAt)) + '</span></div>'
          + '<div class="bubble">' + escapeHtml(msg.text) + '</div>'
          + actions
          + '</article>';
      }).join('');
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }

    function scheduleRenderState(state) {
      pendingState = state;
      if (stateFrame) return;
      stateFrame = window.requestAnimationFrame(function() {
        stateFrame = 0;
        const nextState = pendingState;
        pendingState = null;
        if (nextState) renderState(nextState);
      });
    }

    function renderState(state) {
      const folder = state.workspaceFolders && state.workspaceFolders.length ? state.workspaceFolders[0] : 'No workspace folder';
      const contextCount = state.contextItems.length;
      const diagnosticsCount = state.richContext && state.richContext.diagnostics ? state.richContext.diagnostics.length : 0;
      const visibleCount = state.richContext && state.richContext.visibleEditors ? state.richContext.visibleEditors.length : 0;
      if (state.mode && modeEl.value !== state.mode) modeEl.value = state.mode;
      bridgePillEl.textContent = state.bridgeConfigured ? modeLabel(state.mode || 'agent') : 'Offline';
      modeNoteEl.textContent = modeDescription(state.mode || 'agent');
      modeHintEl.textContent = modeLabel(state.mode || 'agent') + ' mode';
      handoffPlanEl.hidden = !state.canHandoffPlan;
      const running = state.requestStatus === 'running' || state.requestStatus === 'stopping';
      runtimeRequestRunning = running;
      steerEl.hidden = !running;
      stopEl.hidden = !running;
      sendEl.textContent = running ? 'Queue' : '↵';
      sendEl.title = running ? 'Queue as the next follow-up' : 'Send prompt with Enter';
      queuedNoteEl.textContent = state.queuedPrompt ? 'Queued: ' + modeLabel(state.queuedPrompt.mode) + ' · ' + state.queuedPrompt.prompt : (running ? 'Request running. Send queues a follow-up; Steer queues a course-correction note; Stop aborts the request.' : 'Idle. Send starts a new request.');
      renderTimeline(state.operationTimeline || []);
      renderDebugPayload(state.debugSnapshot);
      statusEl.textContent = state.bridgeConfigured
        ? 'Connected to Shogo Desktop agent backend. ' + (running ? 'Request running. ' : '') + 'Context: ' + contextCount + ' item' + (contextCount === 1 ? '' : 's') + ', ' + visibleCount + ' visible editor' + (visibleCount === 1 ? '' : 's') + ', ' + diagnosticsCount + ' diagnostic' + (diagnosticsCount === 1 ? '' : 's') + '.'
        : 'No local Shogo agent bridge configured. Workspace: ' + folder + '. Context: ' + contextCount + ' item' + (contextCount === 1 ? '' : 's') + '.';
      renderContext(state.contextItems);
      renderMessages(state.messages);
      shellEl.classList.toggle('is-empty', !state.messages || state.messages.length === 0);
      if (state.pendingComposerText && !promptEl.value.trim()) {
        promptEl.value = state.pendingComposerText;
        promptEl.focus();
      }
    }

    function sendPrompt() {
      const prompt = promptEl.value.trim();
      if (!prompt) return;
      contextSuggestEl.hidden = true;
      vscode.postMessage({ type: 'sendPrompt', prompt: prompt, mode: modeEl.value, model: modelEl.value, operation: runtimeRequestRunning ? 'queue' : undefined });
      promptEl.value = '';
      promptEl.focus();
    }

    function chooseActiveSuggestion() {
      const active = suggestionItems()[activeSuggestionIndex] || suggestionItems()[0];
      if (!active) return false;
      if (active.dataset.slashMode) {
        applySlashCommand(active.dataset.slashMode);
        return true;
      }
      if (active.dataset.addContextId) {
        const labelEl = active.querySelector('.mention-label');
        replaceMentionWithChipLabel(labelEl ? labelEl.textContent || '' : 'context');
        vscode.postMessage({ type: 'addContextSuggestion', contextId: active.dataset.addContextId });
        return true;
      }
      return false;
    }

    function handlePromptEnter(event) {
      if (event.shiftKey) {
        allowNextLineBreak = true;
        return false;
      }
      if (!contextSuggestEl.hidden && chooseActiveSuggestion()) {
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      event.preventDefault();
      event.stopPropagation();
      sendPrompt();
      return true;
    }

    sendEl.addEventListener('click', function(event) {
      event.preventDefault();
      sendPrompt();
    });
    steerEl.addEventListener('click', function() {
      const prompt = promptEl.value.trim();
      if (!prompt) return;
      contextSuggestEl.hidden = true;
      vscode.postMessage({ type: 'sendPrompt', prompt: prompt, mode: modeEl.value, model: modelEl.value, operation: 'steer' });
      promptEl.value = '';
      promptEl.focus();
    });
    stopEl.addEventListener('click', function() { vscode.postMessage({ type: 'stopRequest' }); });
    toggleOpsEl.addEventListener('click', function() {
      statusPanelEl.hidden = !statusPanelEl.hidden;
      opsPanelEl.hidden = false;
    });
    clearTimelineEl.addEventListener('click', function() { vscode.postMessage({ type: 'clearTimeline' }); });
    modeEl.addEventListener('change', function() {
      modeNoteEl.textContent = modeDescription(modeEl.value);
      modeHintEl.textContent = modeLabel(modeEl.value) + ' mode';
      vscode.postMessage({ type: 'modeChanged', mode: modeEl.value });
    });
    handoffPlanEl.addEventListener('click', function() { vscode.postMessage({ type: 'handoffPlan' }); });
    contextEl.addEventListener('click', function(event) {
      const target = event.target;
      if (!target || !target.dataset) return;
      if (target.dataset.removeContextId) {
        event.stopPropagation();
        vscode.postMessage({ type: 'removeContext', contextId: target.dataset.removeContextId });
        return;
      }
      const chip = target.closest ? target.closest('[data-open-context-id]') : null;
      if (chip && chip.dataset.openContextId) vscode.postMessage({ type: 'openContext', contextId: chip.dataset.openContextId });
    });
    contextSuggestEl.addEventListener('click', function(event) {
      const target = event.target && event.target.closest ? event.target.closest('[data-add-context-id], [data-slash-mode]') : null;
      if (!target || !target.dataset) return;
      if (target.dataset.slashMode) {
        applySlashCommand(target.dataset.slashMode);
        return;
      }
      if (!target.dataset.addContextId) return;
      const labelEl = target.querySelector('.mention-label');
      replaceMentionWithChipLabel(labelEl ? labelEl.textContent || '' : 'context');
      vscode.postMessage({ type: 'addContextSuggestion', contextId: target.dataset.addContextId });
    });
    messagesEl.addEventListener('click', function(event) {
      const target = event.target;
      if (!target || !target.dataset) return;
      if (target.dataset.previewActionId) {
        vscode.postMessage({ type: 'previewAction', actionId: target.dataset.previewActionId });
        return;
      }
      if (target.dataset.rejectActionId) {
        vscode.postMessage({ type: 'rejectAction', actionId: target.dataset.rejectActionId });
        return;
      }
      if (target.dataset.undoActionId) {
        vscode.postMessage({ type: 'undoAction', actionId: target.dataset.undoActionId });
        return;
      }
      if (target.dataset.actionId) vscode.postMessage({ type: 'runAction', actionId: target.dataset.actionId });
    });
    promptEl.addEventListener('keydown', function(event) {
      if (!contextSuggestEl.hidden && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        moveActiveSuggestion(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Enter' && !contextSuggestEl.hidden) {
        handlePromptEnter(event);
        return;
      }
      if (event.key === 'Escape') {
        if (!contextSuggestEl.hidden) {
          event.preventDefault();
          contextSuggestEl.hidden = true;
          return;
        }
        if (!statusPanelEl.hidden) {
          event.preventDefault();
          statusPanelEl.hidden = true;
          return;
        }
      }
      if (event.key === 'Enter') {
        handlePromptEnter(event);
      }
    });
    promptEl.addEventListener('beforeinput', function(event) {
      if (event.inputType === 'insertLineBreak') {
        if (allowNextLineBreak) {
          allowNextLineBreak = false;
          return;
        }
        handlePromptEnter(event);
      }
    });
    document.addEventListener('keydown', function(event) {
      if (event.target === promptEl && event.key === 'Enter') {
        if (event.shiftKey) {
          allowNextLineBreak = true;
          return;
        }
        handlePromptEnter(event);
      }
    }, true);
    promptEl.addEventListener('input', function(event) {
      if (event.inputType === 'insertLineBreak') {
        if (allowNextLineBreak) {
          allowNextLineBreak = false;
          requestContextSuggestions();
          return;
        }
        promptEl.value = promptEl.value.replace(/\\n+$/, '');
        sendPrompt();
        return;
      }
      requestContextSuggestions();
    });
    document.getElementById('newChat').addEventListener('click', function() { vscode.postMessage({ type: 'newChat' }); });
    document.getElementById('openContextPicker').addEventListener('click', function() { vscode.postMessage({ type: 'openContextPicker' }); });
    document.getElementById('openContextPickerTop').addEventListener('click', function() { vscode.postMessage({ type: 'openContextPicker' }); });
    document.getElementById('addSelection').addEventListener('click', function() { vscode.postMessage({ type: 'addSelection' }); });
    document.getElementById('addActiveFile').addEventListener('click', function() { vscode.postMessage({ type: 'addActiveFile' }); });
    document.getElementById('addActiveFileTop').addEventListener('click', function() { vscode.postMessage({ type: 'addActiveFile' }); });
    document.addEventListener('click', function(event) {
      const target = event.target;
      if (target && target.closest && !target.closest('.composer-card')) contextSuggestEl.hidden = true;
      if (target && target.closest && !target.closest('#statusPanel') && !target.closest('#toggleOps')) statusPanelEl.hidden = true;
    });
    window.addEventListener('message', function(event) {
      if (!event.data) return;
      if (event.data.type === 'state') scheduleRenderState(event.data.state);
      if (event.data.type === 'contextSuggestions') renderContextSuggestions(event.data.suggestions || []);
      if (event.data.type === 'focusComposer') promptEl.focus();
      if (event.data.type === 'prefillPrompt' && typeof event.data.text === 'string') {
        promptEl.value = event.data.text;
        if (event.data.mode) {
          modeEl.value = event.data.mode;
          modeNoteEl.textContent = modeDescription(modeEl.value);
          modeHintEl.textContent = modeLabel(modeEl.value) + ' mode';
        }
        promptEl.focus();
      }
    });
    vscode.postMessage({ type: 'ready' });
    promptEl.focus();
  </script>
</body>
</html>`
  }
}

function createStatusBarItem(): any | null {
  const windowApi = vscode.window as any
  if (typeof windowApi.createStatusBarItem !== 'function') return null
  const alignment = (vscode as any).StatusBarAlignment?.Right ?? 2
  return windowApi.createStatusBarItem('shogo.agentChat.status', alignment, 100)
}

function registerReviewDocumentProvider(): vscode.Disposable {
  const workspaceApi = vscode.workspace as any
  if (typeof workspaceApi.registerTextDocumentContentProvider !== 'function') return { dispose() {} }
  return workspaceApi.registerTextDocumentContentProvider('shogo-review', {
    provideTextDocumentContent(uri: vscode.Uri) {
      return reviewDocuments.get(uri.toString()) ?? ''
    },
  })
}

async function showShogoChatContainer(): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.extension.shogo-agent-chat').catch(() => undefined)
}

async function openShogoChatOnStartup(provider: ShogoAgentChatViewProvider): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'shogo.agentChat.native', true).catch(() => undefined)
  await showShogoChatContainer()
  await provider.open(false)
  await provider.focusInput()
  setTimeout(() => {
    void provider.open(false)
  }, 1200)
}

export function activate(context: vscode.ExtensionContext) {
  rememberTextEditor(vscode.window.activeTextEditor)
  const windowApi = vscode.window as any
  const statusBarItem = createStatusBarItem()
  const provider = new ShogoAgentChatViewProvider(context.extensionUri, statusBarItem)

  context.subscriptions.push(
    registerReviewDocumentProvider(),
    vscode.window.registerWebviewViewProvider('shogo.agentChat', provider),
    vscode.commands.registerCommand('shogo.agentChat.open', () => provider.open()),
    vscode.commands.registerCommand('shogo.agentChat.focusInput', () => provider.focusInput()),
    vscode.commands.registerCommand('shogo.agentChat.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('shogo.agentChat.addSelection', () => provider.addSelection()),
    vscode.commands.registerCommand('shogo.agentChat.addActiveFile', () => provider.addActiveFile()),
    vscode.commands.registerCommand('shogo.agentChat.openContextPicker', () => provider.openContextPicker()),
    vscode.commands.registerCommand('shogo.agentChat.explainSelection', () => provider.askAboutSelection('explain')),
    vscode.commands.registerCommand('shogo.agentChat.fixSelection', () => provider.askAboutSelection('fix')),
    windowApi.onDidChangeActiveTextEditor?.((editor: vscode.TextEditor | undefined) => rememberTextEditor(editor)) ?? ({ dispose() {} } as vscode.Disposable),
    windowApi.onDidChangeTextEditorSelection?.((event: { textEditor?: vscode.TextEditor }) => rememberTextEditor(event.textEditor)) ?? ({ dispose() {} } as vscode.Disposable),
    (vscode.workspace as any).onDidDeleteFiles?.((event: { files: readonly vscode.Uri[] }) => provider.removeDeletedContext(event.files)) ?? ({ dispose() {} } as vscode.Disposable),
    vscode.workspace.onDidGrantWorkspaceTrust(() => provider.open()),
    ...(statusBarItem ? [statusBarItem] : []),
  )

  const autoOpen = vscode.workspace.getConfiguration('shogo.agentChat').get<boolean>('autoOpen') !== false
  if (autoOpen) {
    setTimeout(() => {
      void openShogoChatOnStartup(provider)
    }, 500)
  }
}

export function deactivate() {}
