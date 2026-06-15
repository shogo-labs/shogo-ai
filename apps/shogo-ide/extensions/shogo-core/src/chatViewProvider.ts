import * as vscode from 'vscode'
import type { ChatTranscriptMessage, ExtensionServices, ExtensionState } from './types'

interface WebviewMessage {
  type: string
  prompt?: string
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let value = ''
  for (let i = 0; i < 32; i += 1) value += chars.charAt(Math.floor(Math.random() * chars.length))
  return value
}

function message(role: ChatTranscriptMessage['role'], text: string): ChatTranscriptMessage {
  return {
    id: `${role}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
    role,
    text,
    createdAt: new Date().toISOString(),
  }
}

export class ShogoChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null
  private readonly messages: ChatTranscriptMessage[] = [
    message('system', 'Shogo Core Phase 3 is active. Add selection/context, check agent health, or send a prompt to test the extension shell.'),
  ]

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
    void this.refresh()
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.shogo')
    this.view?.show?.(true)
    await this.refresh()
  }

  async refresh(): Promise<void> {
    const state: ExtensionState = {
      health: await this.services.agentClient.getHealth(),
      contextItems: this.services.contextStore.list(),
      messages: this.messages,
      workspaceTrusted: vscode.workspace.isTrusted,
    }
    await this.view?.webview.postMessage({ type: 'state', state })
  }

  appendAssistant(text: string): void {
    this.messages.push(message('assistant', text))
    void this.refresh()
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const msg = raw as WebviewMessage
    if (!msg || typeof msg.type !== 'string') return

    if (msg.type === 'ready') {
      await this.refresh()
      return
    }

    if (msg.type === 'clearContext') {
      this.services.contextStore.clear()
      this.messages.push(message('system', 'Context cleared.'))
      await this.refresh()
      return
    }

    if (msg.type === 'addSelection') {
      const editor = vscode.window.activeTextEditor
      const item = editor ? this.services.contextStore.addSelection(editor) : null
      this.messages.push(message('system', item ? `Added context: ${item.label}` : 'Select code before adding context.'))
      await this.refresh()
      return
    }

    if (msg.type === 'sendPrompt') {
      const prompt = typeof msg.prompt === 'string' ? msg.prompt.trim() : ''
      if (!prompt) return
      this.messages.push(message('user', prompt))
      await this.refresh()
      const workspaceFolders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.toString()) ?? []
      const response = await this.services.agentClient.sendChat({
        prompt,
        context: this.services.contextStore.list(),
        workspaceTrusted: vscode.workspace.isTrusted,
        workspaceFolders,
      })
      this.messages.push(message(response.ok ? 'assistant' : 'system', response.ok ? response.message : response.error || 'Shogo agent request failed.'))
      await this.refresh()
    }
  }

  private render(webview: vscode.Webview): string {
    const scriptNonce = nonce()
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
  <title>Shogo</title>
  <style>
    :root { color-scheme: dark light; }
    body { margin: 0; padding: 12px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); }
    button, textarea { font: inherit; }
    .header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
    .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; }
    .logo { width: 24px; height: 24px; border-radius: 7px; background: #f97316; display: grid; place-items: center; color: white; }
    .pill { border: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); border-radius: 999px; padding: 2px 8px; font-size: 11px; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 10px; margin-bottom: 10px; background: var(--vscode-editor-background); }
    .muted { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.45; }
    .context { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .chip { border: 1px solid var(--vscode-button-secondaryBackground); border-radius: 999px; padding: 3px 8px; font-size: 11px; color: var(--vscode-descriptionForeground); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .messages { display: flex; flex-direction: column; gap: 8px; max-height: 48vh; overflow: auto; }
    .msg { border-radius: 9px; padding: 8px; white-space: pre-wrap; line-height: 1.45; }
    .system { background: var(--vscode-textBlockQuote-background); color: var(--vscode-descriptionForeground); }
    .user { background: var(--vscode-button-secondaryBackground); }
    .assistant { background: color-mix(in srgb, #f97316 18%, var(--vscode-editor-background)); }
    .composer { display: flex; flex-direction: column; gap: 8px; }
    textarea { resize: vertical; min-height: 76px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 8px; padding: 8px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    button { border: 0; border-radius: 7px; padding: 7px 10px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand"><span class="logo">⌘</span><span>Shogo</span></div>
    <span id="trust" class="pill">Phase 3</span>
  </div>

  <section class="card">
    <div id="health" class="muted">Loading Shogo agent status…</div>
    <div id="context" class="context"></div>
  </section>

  <section class="card messages" id="messages"></section>

  <section class="card composer">
    <textarea id="prompt" placeholder="Ask Shogo about this workspace…"></textarea>
    <div class="actions">
      <button id="send">Send</button>
      <button id="addSelection" class="secondary">Add selection</button>
      <button id="clearContext" class="secondary">Clear context</button>
    </div>
  </section>

  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const health = document.getElementById('health');
    const trust = document.getElementById('trust');
    const context = document.getElementById('context');
    const messages = document.getElementById('messages');
    const prompt = document.getElementById('prompt');

    function escapeHtml(value) {
      return String(value).replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
    }

    function renderState(state) {
      trust.textContent = state.workspaceTrusted ? 'Trusted workspace' : 'Restricted mode';
      health.textContent = state.health.message;
      context.innerHTML = state.contextItems.length
        ? state.contextItems.map((item) => '<span class="chip">' + escapeHtml(item.kind + ': ' + item.label) + '</span>').join('')
        : '<span class="chip">No context attached</span>';
      messages.innerHTML = state.messages.map((msg) => '<div class="msg ' + msg.role + '">' + escapeHtml(msg.text) + '</div>').join('');
      messages.scrollTop = messages.scrollHeight;
    }

    document.getElementById('send').addEventListener('click', () => {
      vscode.postMessage({ type: 'sendPrompt', prompt: prompt.value });
      prompt.value = '';
    });
    document.getElementById('addSelection').addEventListener('click', () => vscode.postMessage({ type: 'addSelection' }));
    document.getElementById('clearContext').addEventListener('click', () => vscode.postMessage({ type: 'clearContext' }));
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'state') renderState(event.data.state);
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`
  }
}
