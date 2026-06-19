import * as vscode from 'vscode'
import type { ExtensionServices } from './types'

declare const process: { env?: Record<string, string | undefined> }

interface WebviewMessage {
  type: string
}

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

export class ShogoChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null

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

  private async handleMessage(raw: unknown): Promise<void> {
    const msg = raw as WebviewMessage
    if (!msg || typeof msg.type !== 'string') return

    if (msg.type === 'openExternal') {
      const url = getDesktopChatUrl()
      if (url) await vscode.env.openExternal(vscode.Uri.parse(url))
      return
    }

    if (msg.type === 'addSelection') {
      const editor = vscode.window.activeTextEditor
      const item = editor ? this.services.contextStore.addSelection(editor) : null
      await vscode.window.showInformationMessage(item ? `Added to Shogo context: ${item.label}` : 'Select code before adding it to Shogo context.')
      return
    }

    if (msg.type === 'refresh') {
      await this.refresh()
    }
  }

  private render(webview: vscode.Webview): string {
    const scriptNonce = nonce()
    const chatUrl = getDesktopChatUrl()
    const safeChatUrl = chatUrl ? escapeHtml(chatUrl) : ''
    const csp = [
      `default-src 'none'`,
      `frame-src 'self' ${webview.cspSource} https://*.vscode-cdn.net http://localhost:* http://127.0.0.1:* https:`,
      `child-src 'self' ${webview.cspSource} https://*.vscode-cdn.net http://localhost:* http://127.0.0.1:* https:`,
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
    .toolbar { min-height: 34px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); box-sizing: border-box; }
    .brand { min-width: 0; display: flex; align-items: center; gap: 7px; font-weight: 700; }
    .logo { width: 20px; height: 20px; border-radius: 6px; display: grid; place-items: center; background: #f97316; color: #fff; font-size: 12px; }
    .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .actions { display: flex; align-items: center; gap: 6px; }
    button { border: 1px solid var(--vscode-button-border, transparent); border-radius: 6px; padding: 4px 7px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); font: inherit; font-size: 11px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    iframe { flex: 1; width: 100%; border: 0; background: #0f0f10; }
    .empty { flex: 1; display: flex; align-items: center; justify-content: center; padding: 18px; box-sizing: border-box; text-align: center; }
    .card { max-width: 320px; border: 1px solid var(--vscode-panel-border); border-radius: 12px; padding: 16px; background: var(--vscode-editor-background); }
    .card h2 { margin: 0 0 8px; font-size: 14px; }
    .card p { margin: 0 0 12px; color: var(--vscode-descriptionForeground); line-height: 1.45; font-size: 12px; }
    .fallback { position: absolute; inset: 42px 8px auto 8px; display: none; padding: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 9px; background: var(--vscode-editor-background); color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.4; }
    .fallback.visible { display: block; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="toolbar">
      <div class="brand"><span class="logo">⚡</span><span class="title">Shogo Chat</span></div>
      <div class="actions">
        <button id="addSelection" title="Add the current editor selection to Shogo context">+ Selection</button>
        <button id="openExternal" title="Open Shogo chat in the desktop app">Open</button>
        <button id="refresh" title="Reload Shogo chat">Reload</button>
      </div>
    </div>
    ${safeChatUrl ? `<iframe id="chatFrame" src="${safeChatUrl}" title="Shogo Chat" allow="clipboard-read; clipboard-write"></iframe><div id="fallback" class="fallback">Loading Shogo chat… If this stays here, click Open to use the same chat in the desktop app.</div>` : `<div class="empty"><div class="card"><h2>Shogo chat URL missing</h2><p>The IDE launched without a Shogo desktop chat URL. Relaunch Shogo-IDE from the project screen so Desktop can pass the project chat route into Code-OSS.</p><button id="refresh">Retry</button></div></div>`}
  </div>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('openExternal')?.addEventListener('click', () => vscode.postMessage({ type: 'openExternal' }));
    document.getElementById('addSelection')?.addEventListener('click', () => vscode.postMessage({ type: 'addSelection' }));
    document.getElementById('refresh')?.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    const frame = document.getElementById('chatFrame');
    const fallback = document.getElementById('fallback');
    if (frame && fallback) {
      const timer = setTimeout(() => fallback.classList.add('visible'), 3500);
      frame.addEventListener('load', () => {
        clearTimeout(timer);
        fallback.classList.remove('visible');
      });
    }
  </script>
</body>
</html>`
  }
}
