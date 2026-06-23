import * as vscode from 'vscode'
import type { ExtensionServices } from './types'
import type {
  IdeFileResult,
  IdeReadFileResult,
  WebviewToIdeMessage,
  LegacyIdeMessage,
} from './protocol'

declare const process: { env?: Record<string, string | undefined> }

type WebviewMessage = WebviewToIdeMessage | LegacyIdeMessage

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let value = ''
  for (let i = 0; i < 32; i += 1) value += chars.charAt(Math.floor(Math.random() * chars.length))
  return value
}

function getDesktopChatUrl(): string | null {
  const configured = vscode.workspace.getConfiguration('shogo').get<string>('desktopChat.url')
  const envUrl = process.env?.SHOGO_DESKTOP_CHAT_URL
  const url = (configured && configured !== 'about:blank' ? configured : envUrl)?.trim()
  return url || null
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function addCacheBust(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.pathname.startsWith('/(app)/projects/')) {
      parsed.pathname = parsed.pathname.replace('/(app)/projects/', '/projects/')
    }
    parsed.searchParams.set('tab', 'chat-fullscreen')
    parsed.searchParams.set('embed', 'ide')
    parsed.searchParams.set('ideCacheBust', String(Date.now()))
    return parsed.toString()
  } catch {
    const separator = rawUrl.includes('?') ? '&' : '?'
    return `${rawUrl}${separator}tab=chat-fullscreen&embed=ide&ideCacheBust=${Date.now()}`
  }
}

export class ShogoChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null
  private contextDisposables: vscode.Disposable[] = []

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly services: ExtensionServices,
  ) {}

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
    this.installContextListeners(webviewView)
    void this.postIdeContext()
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.shogo-agent-chat')
    this.view?.show?.(true)
  }

  async refresh(): Promise<void> {
    if (this.view) this.view.webview.html = this.render(this.view.webview)
  }

  appendAssistant(_text: string): void {
    void this.refresh()
  }

  syncContext(): void {
    void this.postIdeContext()
  }

  private installContextListeners(webviewView: vscode.WebviewView): void {
    this.contextDisposables.forEach((d) => d.dispose())
    const windowApi = vscode.window as any
    const workspaceApi = vscode.workspace as any
    const viewApi = webviewView as any
    const disposables: vscode.Disposable[] = []
    const addDisposable = (value: unknown): void => {
      if (value && typeof (value as vscode.Disposable).dispose === 'function') disposables.push(value as vscode.Disposable)
    }
    addDisposable(windowApi.onDidChangeActiveTextEditor?.(() => void this.postIdeContext()))
    addDisposable(windowApi.onDidChangeTextEditorSelection?.(() => void this.postIdeContext()))
    addDisposable(workspaceApi.onDidChangeWorkspaceFolders?.(() => void this.postIdeContext()))
    addDisposable(viewApi.onDidChangeVisibility?.(() => {
      if (viewApi.visible) void this.postIdeContext()
    }))
    this.contextDisposables = disposables
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const msg = raw as WebviewMessage
    if (!msg || typeof msg.type !== 'string') return

    if (msg.type === 'openExternal') {
      const url = getDesktopChatUrl()
      if (url) await vscode.env.openExternal(vscode.Uri.parse(url))
      return
    }

    if (msg.type === 'refresh') {
      await this.refresh()
      return
    }

    if (msg.type === 'webview.ready' || msg.type === 'shogo.ide.ready') {
      await this.postHostReady()
      await this.postIdeContext()
      return
    }

    if (msg.type === 'ide.listFiles' || msg.type === 'shogo.ide.listFiles') {
      const items = await this.listFiles(msg.query)
      await this.view?.webview.postMessage({ type: 'ide.fileResults', requestId: msg.requestId, items })
      await this.view?.webview.postMessage({ type: 'shogo.ide.fileResults', requestId: msg.requestId, items })
      return
    }

    if (msg.type === 'ide.readFiles' || msg.type === 'shogo.ide.readFiles') {
      const files = await this.readFiles('paths' in msg && Array.isArray(msg.paths) ? msg.paths : [])
      await this.view?.webview.postMessage({ type: 'ide.readFilesResult', requestId: msg.requestId, files })
      await this.view?.webview.postMessage({ type: 'shogo.ide.readFilesResult', requestId: msg.requestId, files })
      return
    }

    if ((msg.type === 'ide.openFile' || msg.type === 'shogo.ide.openFile') && msg.path) {
      await this.openFile(msg.path)
      return
    }
  }

  private workspaceRelativePath(uri: vscode.Uri): string {
    const workspaceApi = vscode.workspace as any
    const relative = typeof workspaceApi.asRelativePath === 'function'
      ? workspaceApi.asRelativePath(uri, false)
      : uri.fsPath
    return String(relative).replace(/\\/g, '/')
  }

  private async postHostReady(): Promise<void> {
    await this.view?.webview.postMessage({ type: 'ide.hostReady' })
    await this.view?.webview.postMessage({ type: 'shogo.ide.hostReady' })
  }

  private async postIdeContext(): Promise<void> {
    const editor = vscode.window.activeTextEditor
    const folders = vscode.workspace.workspaceFolders ?? []
    const selection = editor?.selection
    const selectedText = editor && selection && !selection.isEmpty ? editor.document.getText(selection) : ''
    const selectionPayload = selection && selectedText
      ? {
          text: selectedText.slice(0, 24_000),
          startLine: selection.start.line + 1,
          endLine: selection.end.line + 1,
          truncated: selectedText.length > 24_000,
        }
      : undefined
    const activeFile = editor
      ? {
          path: this.workspaceRelativePath(editor.document.uri),
          languageId: editor.document.languageId,
          selection: selectionPayload,
        }
      : undefined

    const workspaceFolders = folders.map((folder) => ({
      name: folder.name,
      path: this.workspaceRelativePath(folder.uri),
    }))
    const workspaceItems = await this.listFiles('')
    const storedContext = this.services.contextStore.list().map((item) => ({
      id: item.id,
      kind: item.kind === 'workspace' ? 'folder' : item.kind === 'active-file' ? 'active-file' : 'selection',
      sourceCommand: item.kind === 'selection' ? 'addSelection' : undefined,
      label: item.label,
      path: item.uri,
      languageId: item.languageId,
      text: item.text,
      startLine: item.range ? item.range.startLine + 1 : undefined,
      endLine: item.range ? item.range.endLine + 1 : undefined,
    }))

    await this.view?.webview.postMessage({
      type: 'ide.context',
      activeFile,
      workspaceFolders,
      workspaceItems,
      storedContext,
    })
    await this.view?.webview.postMessage({
      type: 'shogo.ide.context',
      activeFile,
      workspaceFolders,
      workspaceItems,
      storedContext,
    })
  }

  private async listFiles(query?: string): Promise<IdeFileResult[]> {
    const q = (query ?? '').trim().toLowerCase()
    const workspaceApi = vscode.workspace as any
    const fileSystem = workspaceApi.fs
    const fileType = (vscode as any).FileType ?? { File: 1, Directory: 2 }
    const workspaceFolders = vscode.workspace.workspaceFolders ?? []
    const seen = new Set<string>()
    const rootItems: IdeFileResult[] = []
    const folders = new Map<string, IdeFileResult>()
    const files: IdeFileResult[] = []

    const matches = (path: string, name: string): boolean => {
      return !q || path.toLowerCase().includes(q) || name.toLowerCase().includes(q)
    }

    const addItem = (type: IdeFileResult['type'], path: string, target: IdeFileResult[]): void => {
      const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '')
      if (!normalized) return
      const name = normalized.split('/').filter(Boolean).pop() ?? normalized
      if (!matches(normalized, name)) return
      const key = `${type}:${normalized}`
      if (seen.has(key)) return
      seen.add(key)
      target.push({ type, path: normalized, name })
    }

    const addFolderAncestors = (path: string): void => {
      const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
      for (let i = 1; i < parts.length; i += 1) {
        const folderPath = parts.slice(0, i).join('/')
        const folderName = parts[i - 1]
        if (!folderPath || folders.has(folderPath) || !matches(folderPath, folderName)) continue
        folders.set(folderPath, { type: 'folder', path: folderPath, name: folderName })
      }
    }

    if (fileSystem) {
      for (const folder of workspaceFolders) {
        try {
          const entries: [string, number][] = await fileSystem.readDirectory(folder.uri)
          for (const [name, type] of entries.sort(([a], [b]) => a.localeCompare(b))) {
            const uri = vscode.Uri.joinPath(folder.uri, name)
            const path = this.workspaceRelativePath(uri)
            if (type === fileType.Directory) addItem('folder', path, rootItems)
            else if (type === fileType.File) addItem('file', path, rootItems)
          }
        } catch {
          continue
        }
      }
    }

    const foundFiles: vscode.Uri[] = typeof workspaceApi.findFiles === 'function'
      ? await workspaceApi.findFiles('**/*', '**/{node_modules,.git,dist,build,out,.next,coverage,target,vendor}/**', 1000)
      : []

    for (const uri of foundFiles) {
      const path = this.workspaceRelativePath(uri)
      addFolderAncestors(path)
      addItem('file', path, files)
      if (files.length >= 120) break
    }

    const folderItems = Array.from(folders.values()).filter((item) => !seen.has(`folder:${item.path}`)).slice(0, 80)
    for (const item of folderItems) seen.add(`folder:${item.path}`)

    return [...rootItems, ...folderItems, ...files].slice(0, 160)
  }

  private resolveWorkspaceUri(path: string): vscode.Uri | null {
    const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '')
    const folders = vscode.workspace.workspaceFolders ?? []
    for (const folder of folders) {
      const uri = vscode.Uri.joinPath(folder.uri, ...normalized.split('/').filter(Boolean))
      const rel = this.workspaceRelativePath(uri)
      if (rel === normalized || rel.endsWith(`/${normalized}`)) return uri
    }
    return folders[0] ? vscode.Uri.joinPath(folders[0].uri, ...normalized.split('/').filter(Boolean)) : null
  }

  private async readFiles(paths: string[]): Promise<IdeReadFileResult[]> {
    const results: IdeReadFileResult[] = []
    const workspaceApi = vscode.workspace as any
    const vscodeApi = vscode as any
    const fileSystem = workspaceApi.fs
    const fileType = vscodeApi.FileType ?? { File: 1, Directory: 2 }
    const RelativePattern = vscodeApi.RelativePattern
    let totalBytes = 0
    const pushFile = async (path: string): Promise<void> => {
      if (results.length >= 30 || totalBytes >= 256_000) return
      const uri = this.resolveWorkspaceUri(path)
      if (!uri) {
        results.push({ type: 'file', path, error: 'not found' })
        return
      }
      try {
        if (!fileSystem) {
          results.push({ type: 'file', path, error: 'workspace fs unavailable' })
          return
        }
        const stat = await fileSystem.stat(uri)
        if (stat.type === fileType.Directory) {
          const pattern = RelativePattern ? new RelativePattern(uri.fsPath, '**/*') : `${path.replace(/\/$/, '')}/**/*`
          const children: vscode.Uri[] = typeof workspaceApi.findFiles === 'function'
            ? await workspaceApi.findFiles(pattern, '**/{node_modules,.git,dist,build,out,.next,coverage,target,vendor}/**', 30)
            : []
          for (const child of children) await pushFile(this.workspaceRelativePath(child))
          return
        }
        if (stat.type !== fileType.File) return
        const bytes: Uint8Array = await fileSystem.readFile(uri)
        if (bytes.includes(0)) {
          results.push({ type: 'file', path, error: 'binary file skipped' })
          return
        }
        const remaining = Math.max(0, 256_000 - totalBytes)
        const limited = bytes.slice(0, Math.min(bytes.length, remaining, 64_000))
        const contents = new TextDecoder('utf-8').decode(limited)
        totalBytes += limited.length
        results.push({ type: 'file', path, contents, truncated: limited.length < bytes.length })
      } catch (err) {
        results.push({ type: 'file', path, error: err instanceof Error ? err.message : 'could not read' })
      }
    }

    for (const path of paths.slice(0, 30)) await pushFile(path)
    return results
  }

  private async openFile(path: string): Promise<void> {
    const uri = this.resolveWorkspaceUri(path)
    if (!uri) return
    const workspaceApi = vscode.workspace as any
    const windowApi = vscode.window as any
    try {
      const doc = typeof workspaceApi.openTextDocument === 'function'
        ? await workspaceApi.openTextDocument(uri)
        : uri
      if (typeof windowApi.showTextDocument === 'function') {
        await windowApi.showTextDocument(doc, { preview: false })
      }
    } catch (err) {
      void vscode.window.showWarningMessage(`Could not open ${path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }


  private render(webview: vscode.Webview): string {
    const scriptNonce = nonce()
    const chatUrl = getDesktopChatUrl()
    const embedUrl = chatUrl ? addCacheBust(chatUrl) : null
    const safeChatUrl = embedUrl ? escapeHtml(embedUrl) : ''
    const csp = [
      `default-src 'none'`,
      `frame-src 'self' ${webview.cspSource} shogo: https://*.vscode-cdn.net http://localhost:* http://127.0.0.1:* https:`,
      `child-src 'self' ${webview.cspSource} shogo: https://*.vscode-cdn.net http://localhost:* http://127.0.0.1:* https:`,
      `connect-src http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:* https: wss:`,
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
  <title>Shogo Chat</title>
  <style>
    html, body { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); }
    .shell { width: 100%; height: 100%; display: flex; flex-direction: column; background: #0f0f10; }
    button { border: 1px solid var(--vscode-button-border, transparent); border-radius: 6px; padding: 3px 7px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); font: inherit; font-size: 11px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    iframe { flex: 1; width: 100%; height: 100%; border: 0; background: #0f0f10; }
    .empty { flex: 1; display: flex; align-items: center; justify-content: center; padding: 18px; box-sizing: border-box; text-align: center; }
    .card { max-width: 320px; border: 1px solid var(--vscode-panel-border); border-radius: 12px; padding: 16px; background: var(--vscode-editor-background); }
    .card h2 { margin: 0 0 8px; font-size: 14px; }
    .card p { margin: 0 0 12px; color: var(--vscode-descriptionForeground); line-height: 1.45; font-size: 12px; }
  </style>
</head>
<body>
  <div class="shell">
    ${safeChatUrl ? `<iframe id="chatFrame" src="${safeChatUrl}" title="Shogo Chat" allow="clipboard-read; clipboard-write"></iframe>` : `<div class="empty"><div class="card"><h2>Shogo chat URL missing</h2><p>The IDE launched without a Shogo desktop chat URL. Relaunch Shogo-IDE from the project screen so Desktop can pass the project chat route into Code-OSS.</p><button id="refresh">Retry</button></div></div>`}
  </div>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const frame = document.getElementById('chatFrame');
    document.getElementById('refresh')?.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    function postToChat(message) {
      if (frame && frame.contentWindow) frame.contentWindow.postMessage(message, '*');
    }
    const iframeToIdeMessages = new Set([
      'shogo.ide.ready',
      'shogo.ide.listFiles',
      'shogo.ide.readFiles',
      'shogo.ide.openFile',
    ]);
    const ideToIframeMessages = new Set([
      'shogo.ide.hostReady',
      'shogo.ide.context',
      'shogo.ide.fileResults',
      'shogo.ide.readFilesResult',
    ]);
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || typeof message.type !== 'string') return;
      if (iframeToIdeMessages.has(message.type)) {
        vscode.postMessage(message);
        return;
      }
      if (ideToIframeMessages.has(message.type)) {
        postToChat(message);
      }
    });
    if (frame) {
      frame.addEventListener('load', () => {
        postToChat({ type: 'shogo.ide.hostReady' });
      });
    }
  </script>
</body>
</html>`
  }
}
