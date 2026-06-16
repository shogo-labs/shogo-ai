import * as vscode from 'vscode'

type Role = 'system' | 'user' | 'assistant'

type IdeActionStatus = 'pending' | 'running' | 'completed' | 'failed'

type IdeActionKind = 'workspaceEdit' | 'writeFile' | 'runCommand' | 'openFile'

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
}

interface ChatMessage {
  id: string
  role: Role
  text: string
  createdAt: string
  actions?: IdeAction[]
}

interface ContextItem {
  id: string
  kind: 'selection' | 'activeFile'
  label: string
  uri: string
  text?: string
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
  actionId?: string
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
  return {
    url: configuredUrl ? configuredUrl.replace(/\/$/, '') : null,
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
  const editor = vscode.window.activeTextEditor
  if (!editor) return null
  const document = editor.document
  return {
    id: `activeFile:${document.uri.toString()}`,
    kind: 'activeFile',
    label: relativePath(document.uri),
    uri: document.uri.toString(),
    text: document.getText().slice(0, 24000),
  }
}

function collectSelection(): ContextItem | null {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.selection.isEmpty) return null
  const document = editor.document
  const text = document.getText(editor.selection)
  return {
    id: `selection:${document.uri.toString()}:${editor.selection.start.line}:${editor.selection.start.character}:${Date.now()}`,
    kind: 'selection',
    label: `${relativePath(document.uri)}:${editor.selection.start.line + 1}`,
    uri: document.uri.toString(),
    text: text.slice(0, 24000),
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
  const activeEditor = vscode.window.activeTextEditor
  const activeDocument = activeEditor?.document
  const activeSelection = activeEditor?.selection
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

async function readAgentStream(response: Response, onText: (text: string) => void, onAction: (action: IdeAction) => void): Promise<AgentStreamResult> {
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
  private readonly messages: ChatMessage[] = [
    createMessage('assistant', 'Hi, I’m Shogo. This chat is bridged to the local Shogo Desktop agent backend. Ask about this project, attach context, and keep working from the right-side IDE panel.'),
  ]
  private readonly contextItems = new Map<string, ContextItem>()

  constructor(private readonly extensionUri: vscode.Uri, private readonly statusBarItem: any | null = null) {
    this.updateNativeStatus()
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
    await vscode.commands.executeCommand('workbench.view.extension.shogo-agent-chat')
    this.view?.show?.(preserveFocus)
    await this.postState()
  }

  async focusInput(): Promise<void> {
    await this.open(false)
    await this.view?.webview.postMessage({ type: 'focusComposer' })
  }

  async prefillPrompt(text: string): Promise<void> {
    this.pendingComposerText = text
    await this.open(false)
    await this.view?.webview.postMessage({ type: 'prefillPrompt', text })
  }

  async askAboutSelection(intent: 'explain' | 'fix'): Promise<void> {
    const item = collectSelection()
    if (!item) {
      this.messages.push(createMessage('system', 'Select code in the editor before asking Shogo about it.'))
      await this.focusInput()
      return
    }
    this.contextItems.set(item.id, item)
    const prompt = intent === 'fix'
      ? `Fix the selected code in ${item.label}. Propose an edit action when you are confident.`
      : `Explain the selected code in ${item.label}. Include key behavior, edge cases, and any risks.`
    this.messages.push(createMessage('system', `Added selection context: ${item.label}`))
    await this.prefillPrompt(prompt)
    await this.postState()
  }

  async newChat(): Promise<void> {
    this.chatSessionId = buildSessionId()
    this.messages.splice(0, this.messages.length, createMessage('assistant', 'Started a new Shogo Agent Chat. Add context or ask about the workspace.'))
    this.contextItems.clear()
    await this.postState()
  }

  async addSelection(): Promise<void> {
    const item = collectSelection()
    if (!item) {
      this.messages.push(createMessage('system', 'Select code in the editor before adding selection context.'))
    } else {
      this.contextItems.set(item.id, item)
      this.messages.push(createMessage('system', `Added selection context: ${item.label}`))
    }
    await this.open()
  }

  async addActiveFile(): Promise<void> {
    const item = await collectActiveFile()
    if (!item) {
      this.messages.push(createMessage('system', 'Open a file before adding active file context.'))
    } else {
      this.contextItems.set(item.id, item)
      this.messages.push(createMessage('system', `Added active file context: ${item.label}`))
    }
    await this.open()
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const msg = raw as WebviewMessage
    if (!msg || typeof msg.type !== 'string') return

    if (msg.type === 'ready') {
      await this.postState()
      return
    }

    if (msg.type === 'newChat') {
      await this.newChat()
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

    if (msg.type === 'clearContext') {
      this.contextItems.clear()
      this.messages.push(createMessage('system', 'Context cleared.'))
      await this.postState()
      return
    }

    if (msg.type === 'runAction') {
      if (typeof msg.actionId === 'string') await this.runAction(msg.actionId)
      return
    }

    if (msg.type === 'sendPrompt') {
      const prompt = typeof msg.prompt === 'string' ? msg.prompt.trim() : ''
      if (!prompt) return
      this.pendingComposerText = ''
      this.messages.push(createMessage('user', prompt))
      const assistantMessage = createMessage('assistant', 'Thinking…')
      this.messages.push(assistantMessage)
      await this.postState()
      const response = await this.sendPrompt(prompt, msg.model, (text) => {
        assistantMessage.text = text || 'Thinking…'
        void this.postState()
      }, (action) => {
        assistantMessage.actions = [...(assistantMessage.actions ?? []), action]
        void this.postState()
      })
      if (response.ok === false) {
        assistantMessage.role = 'system'
        assistantMessage.text = response.error || 'Shogo Agent Chat request failed.'
      } else {
        assistantMessage.text = response.message || 'Shogo returned an empty response.'
        if (response.actions?.length) assistantMessage.actions = response.actions
      }
      await this.postState()
    }
  }

  private buildAgentMessages(prompt: string): Array<{ role: 'user' | 'assistant'; parts: Array<{ type: 'text'; text: string }> }> {
    const context = Array.from(this.contextItems.values())
    const contextText = summarizeContextForPrompt(context)
    const history = this.messages
      .filter((message) => (message.role === 'user' || message.role === 'assistant') && message.text.trim() && message.text !== 'Thinking…')
      .map((message) => toAgentMessage(message.role as 'user' | 'assistant', message.text))

    if (history.length === 0 || history[history.length - 1].role !== 'user') {
      history.push(toAgentMessage('user', `${prompt}${contextText}`))
    } else {
      const last = history[history.length - 1]
      last.parts = [{ type: 'text', text: `${prompt}${contextText}` }]
    }

    return history
  }

  private async sendPrompt(prompt: string, model: string | undefined, onText: (text: string) => void, onAction: (action: IdeAction) => void): Promise<BridgeResponse> {
    const bridge = getBridgeConfig()
    const context = Array.from(this.contextItems.values())
    const ideContext = collectRichIdeContext(context)
    if (!bridge.url) {
      return {
        ok: false,
        error: `Shogo Desktop agent bridge is not configured. Launch Shogo IDE from Shogo Desktop so it can pass the local agent URL, or set shogo.agentChat.bridgeUrl to ${getWorkspaceFolders()[0] ? 'the local Desktop API URL' : 'http://localhost:39100'}.`,
      }
    }

    try {
      const response = await fetch(`${bridge.url}/agent/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-chat-session-id': this.chatSessionId,
          ...(bridge.token ? { authorization: `Bearer ${bridge.token}` } : {}),
        },
        body: JSON.stringify({
          messages: this.buildAgentMessages(prompt),
          chatSessionId: this.chatSessionId,
          interactionMode: 'agent',
          ...(model && model !== 'auto' ? { agentMode: model } : {}),
          ide: ideContext,
          ideContext,
          ideActionProtocol: {
            version: 1,
            actions: ['workspaceEdit', 'writeFile', 'runCommand', 'openFile'],
            delivery: 'stream-event',
            eventTypes: ['ide-action', 'shogo-ide-action'],
            requiresUserConfirmation: true,
            shellCommandsRequireWorkspaceTrust: true,
          },
        }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as BridgeResponse
        return { ok: false, error: body.error || `Shogo agent backend returned HTTP ${response.status}.` }
      }

      const stream = await readAgentStream(response, onText, onAction)
      if (stream.error) return { ok: false, error: stream.error, actions: stream.actions }
      return { ok: true, message: stream.text || 'Shogo returned an empty response.', actions: stream.actions }
    } catch (error) {
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

  private async writeTextFile(uri: vscode.Uri, content: string): Promise<void> {
    const fsApi = (vscode.workspace as any).fs
    if (!fsApi?.writeFile) throw new Error('VS Code workspace file API is unavailable.')
    await fsApi.writeFile(uri, new TextEncoder().encode(content))
  }

  private async executeIdeAction(action: IdeAction): Promise<string> {
    if ((action.kind === 'workspaceEdit' || action.kind === 'writeFile' || action.kind === 'runCommand') && !vscode.workspace.isTrusted) {
      throw new Error('Workspace trust is required before Shogo can edit files or run commands.')
    }

    if (action.kind === 'openFile') {
      const document = await (vscode.workspace as any).openTextDocument(this.resolveActionUri(action))
      await (vscode.window as any).showTextDocument(document, { preview: false })
      return `Opened ${action.filePath || action.uri}.`
    }

    if (action.kind === 'writeFile') {
      if (typeof action.content !== 'string') throw new Error('writeFile action is missing content.')
      await this.writeTextFile(this.resolveActionUri(action), action.content)
      return `Wrote ${action.filePath || action.uri}.`
    }

    if (action.kind === 'workspaceEdit') {
      if (typeof action.content === 'string' && !action.find) {
        await this.writeTextFile(this.resolveActionUri(action), action.content)
        return `Updated ${action.filePath || action.uri}.`
      }
      if (!action.find) throw new Error('workspaceEdit action needs either content or find/replace text.')
      const uri = this.resolveActionUri(action)
      const document = await (vscode.workspace as any).openTextDocument(uri)
      const original = document.getText()
      if (!original.includes(action.find)) throw new Error(`Could not find requested text in ${action.filePath || action.uri}.`)
      await this.writeTextFile(uri, original.replace(action.find, action.replace ?? ''))
      return `Applied edit to ${action.filePath || action.uri}.`
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

  private async runAction(actionId: string): Promise<void> {
    const action = this.findAction(actionId)
    if (!action || action.status === 'running') return
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
        nativePhase: 8,
        workspaceTrusted: vscode.workspace.isTrusted,
        workspaceFolders: getWorkspaceFolders(),
        richContext: collectRichIdeContext(Array.from(this.contextItems.values())),
        contextItems: Array.from(this.contextItems.values()).map((item) => ({
          id: item.id,
          kind: item.kind,
          label: item.label,
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
      grid-template-rows: auto 1fr auto;
      background: var(--vscode-sideBar-background);
    }
    .chat-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 58px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      background: var(--vscode-sideBarSectionHeader-background, var(--vscode-sideBar-background));
    }
    .brand-wrap { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .brand-mark {
      width: 34px;
      height: 34px;
      border-radius: 12px;
      display: grid;
      place-items: center;
      flex: none;
      background: linear-gradient(135deg, var(--shogo-orange-strong), var(--shogo-orange));
      color: white;
      font-weight: 900;
      letter-spacing: -.08em;
      box-shadow: 0 10px 28px color-mix(in srgb, var(--shogo-orange) 34%, transparent);
    }
    .brand-copy { min-width: 0; }
    .eyebrow {
      color: var(--shogo-orange-strong);
      font-size: 10px;
      font-weight: 800;
      letter-spacing: .24em;
      text-transform: uppercase;
      line-height: 1.2;
    }
    .title-row { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .title { font-size: 14px; font-weight: 750; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .status-dot { width: 7px; height: 7px; border-radius: 999px; background: #22c55e; box-shadow: 0 0 0 3px color-mix(in srgb, #22c55e 20%, transparent); }
    .header-actions { display: flex; align-items: center; gap: 6px; flex: none; }
    .icon-button, .text-button, .send-button, .chip-button {
      border: 1px solid transparent;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border-radius: 10px;
    }
    .icon-button {
      width: 31px;
      height: 31px;
      padding: 0;
      display: grid;
      place-items: center;
      font-size: 15px;
    }
    .icon-button:hover, .text-button:hover, .chip-button:hover { background: var(--vscode-button-hoverBackground); color: var(--vscode-button-foreground); }
    .conversation {
      min-height: 0;
      overflow: auto;
      padding: 14px 12px 20px;
    }
    .desktop-card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-editor-background);
      overflow: hidden;
      margin-bottom: 12px;
    }
    .session-card { padding: 12px; }
    .session-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .session-title { font-weight: 750; margin-bottom: 4px; }
    .session-subtitle { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.45; }
    .bridge-pill {
      border: 1px solid color-mix(in srgb, var(--shogo-orange) 35%, var(--vscode-panel-border));
      color: color-mix(in srgb, var(--shogo-orange-strong) 80%, var(--vscode-foreground));
      background: color-mix(in srgb, var(--shogo-orange) 10%, transparent);
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 11px;
      white-space: nowrap;
    }
    .context-strip { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 11px; }
    .context-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      min-width: 0;
      border: 1px solid var(--vscode-button-secondaryBackground);
      border-radius: 999px;
      padding: 5px 9px;
      color: var(--vscode-descriptionForeground);
      background: color-mix(in srgb, var(--vscode-button-secondaryBackground) 55%, transparent);
      font-size: 11px;
      line-height: 1;
    }
    .context-chip span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .turns { display: flex; flex-direction: column; gap: 12px; }
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
      max-width: min(640px, 94%);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 16px;
      padding: 10px 11px;
      line-height: 1.48;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .assistant .bubble {
      background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--shogo-orange) 8%);
      border-color: color-mix(in srgb, var(--shogo-orange) 22%, var(--vscode-panel-border));
    }
    .user .bubble {
      background: color-mix(in srgb, var(--vscode-button-secondaryBackground) 88%, var(--shogo-orange) 5%);
      border-color: transparent;
    }
    .system .bubble {
      max-width: 100%;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-textBlockQuote-background);
      border-style: dashed;
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
    .action-button {
      margin-top: 8px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 9px;
      padding: 5px 8px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font-size: 12px;
    }
    .action-button[disabled] { opacity: .62; cursor: default; }
    .composer-wrap {
      padding: 12px;
      border-top: 1px solid var(--vscode-panel-border);
      background: color-mix(in srgb, var(--vscode-sideBar-background) 94%, #000);
    }
    .composer-card {
      border: 1px solid var(--vscode-focusBorder, var(--vscode-panel-border));
      border-radius: var(--shogo-radius-lg);
      background: var(--vscode-input-background);
      overflow: hidden;
      box-shadow: 0 12px 32px rgba(0, 0, 0, .18);
    }
    textarea {
      width: 100%;
      min-height: 86px;
      max-height: 210px;
      resize: vertical;
      display: block;
      border: 0;
      outline: none;
      padding: 13px 14px 8px;
      color: var(--vscode-input-foreground);
      background: transparent;
      line-height: 1.45;
    }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    .composer-toolbar {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      padding: 8px;
      border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 62%, transparent);
    }
    .left-tools, .right-tools { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .chip-button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 31px;
      padding: 6px 9px;
      font-size: 12px;
      white-space: nowrap;
    }
    .mode-select {
      min-height: 31px;
      max-width: 142px;
      border: 1px solid var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border-radius: 10px;
      padding: 0 8px;
      outline: none;
    }
    .send-button {
      min-height: 34px;
      padding: 7px 12px;
      color: var(--vscode-button-foreground);
      background: linear-gradient(135deg, var(--shogo-orange-strong), var(--shogo-orange));
      font-weight: 750;
    }
    .send-button:hover { filter: brightness(1.08); }
    .hint-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin-top: 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    @media (max-width: 430px) {
      .chat-header { padding: 9px 10px; }
      .eyebrow { display: none; }
      .title { font-size: 13px; }
      .composer-toolbar { align-items: stretch; flex-direction: column; }
      .left-tools, .right-tools { justify-content: space-between; }
      .mode-select { flex: 1; max-width: none; }
      .send-button { flex: 1; }
    }
  </style>
</head>
<body>
  <main class="desktop-chat-shell" data-shogo-desktop-chat-ui="true">
    <header class="chat-header">
      <div class="brand-wrap">
        <div class="brand-mark">S.</div>
        <div class="brand-copy">
          <div class="eyebrow">Shogo Agent</div>
          <div class="title-row"><span class="title">Chat</span><span class="status-dot" aria-hidden="true"></span></div>
        </div>
      </div>
      <div class="header-actions">
        <button id="newChat" class="icon-button" title="New chat" aria-label="New chat">＋</button>
        <button id="addActiveFileTop" class="icon-button" title="Attach active file" aria-label="Attach active file">□</button>
        <button id="addSelectionTop" class="icon-button" title="Attach selection" aria-label="Attach selection">⌁</button>
      </div>
    </header>

    <section id="scroll" class="conversation">
      <section class="desktop-card session-card">
        <div class="session-top">
          <div>
            <div class="session-title">Ask Shogo about your code</div>
            <div id="status" class="session-subtitle">Loading workspace context…</div>
          </div>
          <div id="bridgePill" class="bridge-pill">Local</div>
        </div>
        <div id="context" class="context-strip"></div>
      </section>
      <section id="messages" class="turns" aria-live="polite"></section>
    </section>

    <section class="composer-wrap">
      <div class="composer-card">
        <textarea id="prompt" placeholder="Ask Shogo to fix, explain, refactor, or review this code"></textarea>
        <div class="composer-toolbar">
          <div class="left-tools">
            <button id="addSelection" class="chip-button" title="Attach selected code">＋ Selection</button>
            <button id="addActiveFile" class="chip-button" title="Attach active file">File</button>
          </div>
          <div class="right-tools">
            <select id="model" class="mode-select" title="Model">
              <option value="auto">Auto</option>
              <option value="fast">Fast</option>
              <option value="capable">Capable</option>
            </select>
            <button id="send" class="send-button">Send</button>
          </div>
        </div>
      </div>
      <div class="hint-row">
        <span>⌘/Ctrl + Enter to send</span>
        <span>Agent mode</span>
      </div>
    </section>
  </main>

  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const statusEl = document.getElementById('status');
    const bridgePillEl = document.getElementById('bridgePill');
    const contextEl = document.getElementById('context');
    const messagesEl = document.getElementById('messages');
    const scrollEl = document.getElementById('scroll');
    const promptEl = document.getElementById('prompt');
    const modelEl = document.getElementById('model');

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

    function renderContext(items) {
      if (!items.length) {
        contextEl.innerHTML = '<span class="context-chip"><span>No context attached</span></span>';
        return;
      }
      contextEl.innerHTML = items.map(function(item) {
        const icon = item.kind === 'selection' ? '⌁' : '□';
        return '<span class="context-chip"><strong>' + icon + '</strong><span>' + escapeHtml(item.label) + '</span></span>';
      }).join('');
    }

    function renderAction(action) {
      const target = action.filePath || action.uri || action.command || '';
      const disabled = action.status !== 'pending';
      const label = action.status === 'pending' ? (action.kind === 'runCommand' ? 'Run' : action.kind === 'openFile' ? 'Open' : 'Apply') : action.status;
      const detail = action.error || action.result || action.description || target;
      return '<div class="action-card">'
        + '<div class="action-top"><div><div class="action-title">' + escapeHtml(action.title || action.kind) + '</div><div class="action-meta">' + escapeHtml(action.kind + (target ? ' · ' + target : '')) + '</div></div><span class="bridge-pill">' + escapeHtml(action.status) + '</span></div>'
        + (detail ? '<div class="action-meta">' + escapeHtml(detail) + '</div>' : '')
        + '<button class="action-button" data-action-id="' + escapeHtml(action.id) + '"' + (disabled ? ' disabled' : '') + '>' + escapeHtml(label) + '</button>'
        + '</div>';
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

    function renderState(state) {
      const folder = state.workspaceFolders && state.workspaceFolders.length ? state.workspaceFolders[0] : 'No workspace folder';
      const contextCount = state.contextItems.length;
      const diagnosticsCount = state.richContext && state.richContext.diagnostics ? state.richContext.diagnostics.length : 0;
      const visibleCount = state.richContext && state.richContext.visibleEditors ? state.richContext.visibleEditors.length : 0;
      bridgePillEl.textContent = state.bridgeConfigured ? 'Agent' : 'Offline';
      statusEl.textContent = state.bridgeConfigured
        ? 'Connected to Shogo Desktop agent backend. Context: ' + contextCount + ' item' + (contextCount === 1 ? '' : 's') + ', ' + visibleCount + ' visible editor' + (visibleCount === 1 ? '' : 's') + ', ' + diagnosticsCount + ' diagnostic' + (diagnosticsCount === 1 ? '' : 's') + '.'
        : 'No local Shogo agent bridge configured. Workspace: ' + folder + '. Context: ' + contextCount + ' item' + (contextCount === 1 ? '' : 's') + '.';
      renderContext(state.contextItems);
      renderMessages(state.messages);
      if (state.pendingComposerText && !promptEl.value.trim()) {
        promptEl.value = state.pendingComposerText;
        promptEl.focus();
      }
    }

    function sendPrompt() {
      const prompt = promptEl.value.trim();
      if (!prompt) return;
      vscode.postMessage({ type: 'sendPrompt', prompt: prompt, model: modelEl.value });
      promptEl.value = '';
      promptEl.focus();
    }

    document.getElementById('send').addEventListener('click', sendPrompt);
    messagesEl.addEventListener('click', function(event) {
      const target = event.target;
      if (!target || !target.dataset || !target.dataset.actionId) return;
      vscode.postMessage({ type: 'runAction', actionId: target.dataset.actionId });
    });
    promptEl.addEventListener('keydown', function(event) {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        sendPrompt();
      }
    });
    document.getElementById('newChat').addEventListener('click', function() { vscode.postMessage({ type: 'newChat' }); });
    document.getElementById('addSelection').addEventListener('click', function() { vscode.postMessage({ type: 'addSelection' }); });
    document.getElementById('addSelectionTop').addEventListener('click', function() { vscode.postMessage({ type: 'addSelection' }); });
    document.getElementById('addActiveFile').addEventListener('click', function() { vscode.postMessage({ type: 'addActiveFile' }); });
    document.getElementById('addActiveFileTop').addEventListener('click', function() { vscode.postMessage({ type: 'addActiveFile' }); });
    window.addEventListener('message', function(event) {
      if (!event.data) return;
      if (event.data.type === 'state') renderState(event.data.state);
      if (event.data.type === 'focusComposer') promptEl.focus();
      if (event.data.type === 'prefillPrompt') {
        promptEl.value = event.data.text || '';
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

async function openShogoChatOnStartup(provider: ShogoAgentChatViewProvider): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'shogo.agentChat.native', true).catch(() => undefined)
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').catch(() => undefined)
  await provider.open(false)
  await provider.focusInput()
  setTimeout(() => {
    void provider.open(false)
  }, 1200)
}

export function activate(context: vscode.ExtensionContext) {
  const statusBarItem = createStatusBarItem()
  const provider = new ShogoAgentChatViewProvider(context.extensionUri, statusBarItem)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('shogo.agentChat', provider),
    vscode.commands.registerCommand('shogo.agentChat.open', () => provider.open()),
    vscode.commands.registerCommand('shogo.agentChat.focusInput', () => provider.focusInput()),
    vscode.commands.registerCommand('shogo.agentChat.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('shogo.agentChat.addSelection', () => provider.addSelection()),
    vscode.commands.registerCommand('shogo.agentChat.addActiveFile', () => provider.addActiveFile()),
    vscode.commands.registerCommand('shogo.agentChat.explainSelection', () => provider.askAboutSelection('explain')),
    vscode.commands.registerCommand('shogo.agentChat.fixSelection', () => provider.askAboutSelection('fix')),
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
