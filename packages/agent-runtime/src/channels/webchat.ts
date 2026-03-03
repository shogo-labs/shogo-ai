/**
 * WebChat Channel Adapter
 *
 * Provides an embeddable chat widget that can be placed on any website via a
 * simple <script> tag. The widget communicates with the agent through SSE
 * (Server-Sent Events) for streaming responses and REST for sending messages.
 *
 * How it works:
 *   1. Agent owner connects the "webchat" channel (optionally customising theme)
 *   2. The agent-runtime serves a small JS widget at /agent/channels/webchat/widget.js
 *   3. Website owner embeds: <script src="https://<agent-url>/agent/channels/webchat/widget.js"></script>
 *   4. Visitors open the chat bubble → messages are POSTed to the agent
 *   5. Responses stream back via SSE for a real-time feel
 *
 * Config keys:
 *   title         — chat window header (default: "Chat with us")
 *   subtitle      — optional subtitle text
 *   primaryColor  — hex colour for the chat bubble / header (default: "#6366f1")
 *   position      — "bottom-right" | "bottom-left" (default: "bottom-right")
 *   welcomeMessage — auto-sent greeting when the user first opens the widget
 *   avatarUrl     — URL for the bot avatar image (optional)
 *   allowedOrigins — comma-separated list of allowed origins, or "*" (default: "*")
 */

import type { ChannelAdapter, IncomingMessage, ChannelStatus } from '../types'
import { randomUUID } from 'crypto'

export interface WebChatSession {
  id: string
  createdAt: number
  lastMessageAt: number
  messageCount: number
  metadata?: Record<string, unknown>
}

export interface WebChatConfig {
  title: string
  subtitle: string
  primaryColor: string
  position: 'bottom-right' | 'bottom-left'
  welcomeMessage: string
  avatarUrl: string
  allowedOrigins: string
}

interface PendingResponse {
  resolve: (text: string) => void
  chunks: string[]
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_CONFIG: WebChatConfig = {
  title: 'Chat with us',
  subtitle: '',
  primaryColor: '#6366f1',
  position: 'bottom-right',
  welcomeMessage: '',
  avatarUrl: '',
  allowedOrigins: '*',
}

export class WebChatAdapter implements ChannelAdapter {
  private messageHandler: ((msg: IncomingMessage) => void) | null = null
  private connected = false
  private error: string | undefined
  private config: WebChatConfig = { ...DEFAULT_CONFIG }
  private sessions = new Map<string, WebChatSession>()
  private messageCount = 0

  /** SSE clients waiting for streamed responses: sessionId -> SSE write callback */
  private sseClients = new Map<string, (event: string, data: string) => void>()

  /** Pending responses keyed by correlationId */
  private pendingResponses = new Map<string, PendingResponse>()

  private replyTimeoutMs = 120_000

  async connect(config: Record<string, string>): Promise<void> {
    this.config = {
      title: config.title || DEFAULT_CONFIG.title,
      subtitle: config.subtitle || DEFAULT_CONFIG.subtitle,
      primaryColor: config.primaryColor || DEFAULT_CONFIG.primaryColor,
      position: (config.position as WebChatConfig['position']) || DEFAULT_CONFIG.position,
      welcomeMessage: config.welcomeMessage || DEFAULT_CONFIG.welcomeMessage,
      avatarUrl: config.avatarUrl || DEFAULT_CONFIG.avatarUrl,
      allowedOrigins: config.allowedOrigins || DEFAULT_CONFIG.allowedOrigins,
    }

    this.connected = true
    this.error = undefined
    console.log(
      `[WebChat] Channel ready (title: "${this.config.title}", ` +
      `position: ${this.config.position}, origins: ${this.config.allowedOrigins})`
    )
  }

  async disconnect(): Promise<void> {
    for (const [, pending] of this.pendingResponses) {
      clearTimeout(pending.timer)
      pending.resolve('[WebChat disconnected]')
    }
    this.pendingResponses.clear()
    this.sseClients.clear()
    this.sessions.clear()
    this.connected = false
    console.log('[WebChat] Disconnected')
  }

  async sendMessage(channelId: string, content: string): Promise<void> {
    const pending = this.pendingResponses.get(channelId)
    if (pending) {
      clearTimeout(pending.timer)
      pending.resolve(content)
      this.pendingResponses.delete(channelId)
    }

    const sessionId = this.extractSessionId(channelId)
    const sseWriter = this.sseClients.get(sessionId)
    if (sseWriter) {
      sseWriter('message', JSON.stringify({
        type: 'agent_message',
        content,
        timestamp: Date.now(),
      }))
    }
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler
  }

  getStatus(): ChannelStatus {
    return {
      type: 'webchat',
      connected: this.connected,
      error: this.error,
      metadata: {
        messageCount: this.messageCount,
        activeSessions: this.sessions.size,
        sseClients: this.sseClients.size,
        config: {
          title: this.config.title,
          position: this.config.position,
          primaryColor: this.config.primaryColor,
        },
      },
    }
  }

  getConfig(): WebChatConfig {
    return { ...this.config }
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  getOrCreateSession(sessionId?: string): WebChatSession {
    if (sessionId && this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!
    }

    const id = sessionId || randomUUID()
    const session: WebChatSession = {
      id,
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    }
    this.sessions.set(id, session)
    return session
  }

  // ---------------------------------------------------------------------------
  // SSE registration
  // ---------------------------------------------------------------------------

  registerSSEClient(sessionId: string, writer: (event: string, data: string) => void): void {
    this.sseClients.set(sessionId, writer)
  }

  removeSSEClient(sessionId: string): void {
    this.sseClients.delete(sessionId)
  }

  // ---------------------------------------------------------------------------
  // Inbound message processing
  // ---------------------------------------------------------------------------

  async processIncoming(body: {
    message: string
    sessionId: string
    metadata?: Record<string, unknown>
  }): Promise<{ reply: string }> {
    if (!this.messageHandler) {
      throw new Error('WebChat channel not initialized — no message handler')
    }

    this.messageCount++
    const session = this.getOrCreateSession(body.sessionId)
    session.lastMessageAt = Date.now()
    session.messageCount++

    const correlationId = `webchat-${session.id}-${Date.now()}-${this.messageCount}`

    return new Promise<{ reply: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(correlationId)
        resolve({ reply: 'Sorry, the request timed out. Please try again.' })
      }, this.replyTimeoutMs)

      this.pendingResponses.set(correlationId, {
        resolve: (reply: string) => resolve({ reply }),
        chunks: [],
        timer,
      })

      const msg: IncomingMessage = {
        text: body.message,
        channelId: correlationId,
        channelType: 'webchat',
        senderId: session.id,
        senderName: 'Visitor',
        timestamp: Date.now(),
        metadata: {
          ...body.metadata,
          correlationId,
          sessionId: session.id,
          webchat: true,
        },
      }

      this.messageHandler!(msg)
    })
  }

  // ---------------------------------------------------------------------------
  // Origin validation
  // ---------------------------------------------------------------------------

  isOriginAllowed(origin: string | undefined): boolean {
    if (this.config.allowedOrigins === '*') return true
    if (!origin) return false
    const allowed = this.config.allowedOrigins.split(',').map(o => o.trim())
    return allowed.includes(origin)
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private extractSessionId(correlationId: string): string {
    // correlationId format: webchat-{sessionId}-{timestamp}-{count}
    const parts = correlationId.split('-')
    if (parts.length >= 6) {
      // UUID has 5 parts, so sessionId spans indices 1-5
      return parts.slice(1, 6).join('-')
    }
    return correlationId
  }

  // ---------------------------------------------------------------------------
  // Static: register Hono routes for WebChat
  // ---------------------------------------------------------------------------

  static registerRoutes(app: any, getAdapter: () => WebChatAdapter | null): void {
    // Get widget configuration (used by the embedded widget to initialize)
    app.get('/agent/channels/webchat/config', (c: any) => {
      const adapter = getAdapter()
      if (!adapter || !adapter.connected) {
        return c.json({ error: 'WebChat channel not connected' }, 503)
      }

      const origin = c.req.header('origin')
      if (!adapter.isOriginAllowed(origin)) {
        return c.json({ error: 'Origin not allowed' }, 403)
      }

      const config = adapter.getConfig()
      return c.json({
        title: config.title,
        subtitle: config.subtitle,
        primaryColor: config.primaryColor,
        position: config.position,
        welcomeMessage: config.welcomeMessage,
        avatarUrl: config.avatarUrl,
      })
    })

    // Create or resume a chat session
    app.post('/agent/channels/webchat/session', (c: any) => {
      const adapter = getAdapter()
      if (!adapter || !adapter.connected) {
        return c.json({ error: 'WebChat channel not connected' }, 503)
      }

      const origin = c.req.header('origin')
      if (!adapter.isOriginAllowed(origin)) {
        return c.json({ error: 'Origin not allowed' }, 403)
      }

      const sessionId = c.req.header('x-webchat-session')
      const session = adapter.getOrCreateSession(sessionId || undefined)
      return c.json({ sessionId: session.id, created: !sessionId })
    })

    // Send a message from the widget
    app.post('/agent/channels/webchat/message', async (c: any) => {
      const adapter = getAdapter()
      if (!adapter || !adapter.connected) {
        return c.json({ error: 'WebChat channel not connected' }, 503)
      }

      const origin = c.req.header('origin')
      if (!adapter.isOriginAllowed(origin)) {
        return c.json({ error: 'Origin not allowed' }, 403)
      }

      let body: any
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400)
      }

      const message = body.message
      const sessionId = body.sessionId
      if (!message || typeof message !== 'string') {
        return c.json({ error: 'Missing required field: "message"' }, 400)
      }
      if (!sessionId) {
        return c.json({ error: 'Missing required field: "sessionId"' }, 400)
      }

      try {
        const result = await adapter.processIncoming({
          message,
          sessionId,
          metadata: body.metadata,
        })

        return c.json({ reply: result.reply })
      } catch (err: any) {
        console.error('[WebChat] Processing error:', err.message)
        return c.json({ error: `Processing failed: ${err.message}` }, 500)
      }
    })

    // SSE endpoint for streaming responses
    app.get('/agent/channels/webchat/events/:sessionId', (c: any) => {
      const adapter = getAdapter()
      if (!adapter || !adapter.connected) {
        return c.json({ error: 'WebChat channel not connected' }, 503)
      }

      const origin = c.req.header('origin')
      if (!adapter.isOriginAllowed(origin)) {
        return c.json({ error: 'Origin not allowed' }, 403)
      }

      const sessionId = c.req.param('sessionId')

      return new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder()

            const write = (event: string, data: string) => {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))
            }

            // Send initial connection event
            write('connected', JSON.stringify({ sessionId, timestamp: Date.now() }))

            // Send welcome message if configured
            const config = adapter.getConfig()
            if (config.welcomeMessage) {
              write('message', JSON.stringify({
                type: 'agent_message',
                content: config.welcomeMessage,
                timestamp: Date.now(),
                isWelcome: true,
              }))
            }

            adapter.registerSSEClient(sessionId, write)

            // Heartbeat every 30s to keep connection alive
            const heartbeat = setInterval(() => {
              try {
                write('ping', JSON.stringify({ timestamp: Date.now() }))
              } catch {
                clearInterval(heartbeat)
                adapter.removeSSEClient(sessionId)
              }
            }, 30_000)

            // Cleanup on close
            c.req.raw.signal?.addEventListener('abort', () => {
              clearInterval(heartbeat)
              adapter.removeSSEClient(sessionId)
            })
          },
        }),
        {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
          },
        }
      )
    })

    // Serve the embeddable widget JavaScript
    app.get('/agent/channels/webchat/widget.js', (c: any) => {
      const adapter = getAdapter()
      const baseUrl = new URL(c.req.url)
      const agentBaseUrl = `${baseUrl.protocol}//${baseUrl.host}`

      return new Response(generateWidgetScript(agentBaseUrl), {
        headers: {
          'Content-Type': 'application/javascript',
          'Cache-Control': 'public, max-age=300',
          'Access-Control-Allow-Origin': '*',
        },
      })
    })

    // Health check
    app.get('/agent/channels/webchat/health', (c: any) => {
      const adapter = getAdapter()
      if (!adapter) {
        return c.json({ status: 'not_configured' })
      }
      return c.json({
        status: adapter.connected ? 'healthy' : 'disconnected',
        ...adapter.getStatus(),
      })
    })
  }
}

// ---------------------------------------------------------------------------
// Embeddable Widget JavaScript (self-contained, no dependencies)
// ---------------------------------------------------------------------------

function generateWidgetScript(agentBaseUrl: string): string {
  return `(function() {
  "use strict";
  if (window.__shogoWebChat) return;
  window.__shogoWebChat = true;

  var AGENT_URL = "${agentBaseUrl}";
  var SESSION_KEY = "shogo_webchat_session";
  var HISTORY_KEY = "shogo_webchat_history";

  var config = null;
  var sessionId = null;
  var isOpen = false;
  var isLoading = false;
  var container, bubble, chatWindow, messagesEl, inputEl;

  function getStoredSession() {
    try { return localStorage.getItem(SESSION_KEY); } catch(e) { return null; }
  }
  function storeSession(id) {
    try { localStorage.setItem(SESSION_KEY, id); } catch(e) {}
  }
  function getStoredHistory() {
    try {
      var h = localStorage.getItem(HISTORY_KEY);
      return h ? JSON.parse(h) : [];
    } catch(e) { return []; }
  }
  function storeHistory(messages) {
    try {
      var last50 = messages.slice(-50);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(last50));
    } catch(e) {}
  }

  function init() {
    fetch(AGENT_URL + "/agent/channels/webchat/config")
      .then(function(r) { return r.json(); })
      .then(function(cfg) {
        config = cfg;
        createWidget();
        initSession();
      })
      .catch(function(err) {
        console.warn("[Shogo WebChat] Failed to load config:", err);
      });
  }

  function initSession() {
    var existing = getStoredSession();
    fetch(AGENT_URL + "/agent/channels/webchat/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(existing ? { "X-WebChat-Session": existing } : {})
      },
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      sessionId = data.sessionId;
      storeSession(sessionId);
      connectSSE();
    })
    .catch(function(err) {
      console.warn("[Shogo WebChat] Session init failed:", err);
    });
  }

  function connectSSE() {
    if (!sessionId) return;
    var es = new EventSource(AGENT_URL + "/agent/channels/webchat/events/" + sessionId);

    es.addEventListener("message", function(e) {
      try {
        var data = JSON.parse(e.data);
        if (data.type === "agent_message") {
          addMessage("agent", data.content);
          setLoading(false);
        }
      } catch(err) {}
    });

    es.addEventListener("connected", function() {});
    es.addEventListener("ping", function() {});

    es.onerror = function() {
      setTimeout(function() { connectSSE(); }, 5000);
    };
  }

  function sendMessage(text) {
    if (!text.trim() || !sessionId || isLoading) return;
    addMessage("user", text);
    setLoading(true);

    fetch(AGENT_URL + "/agent/channels/webchat/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, sessionId: sessionId })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.reply) {
        addMessage("agent", data.reply);
      }
      setLoading(false);
    })
    .catch(function(err) {
      addMessage("agent", "Sorry, something went wrong. Please try again.");
      setLoading(false);
    });
  }

  var chatMessages = [];

  function addMessage(role, content) {
    chatMessages.push({ role: role, content: content, time: Date.now() });
    storeHistory(chatMessages);
    renderMessages();
  }

  function setLoading(val) {
    isLoading = val;
    if (inputEl) inputEl.disabled = val;
    var dots = container && container.querySelector(".shogo-typing");
    if (dots) dots.style.display = val ? "flex" : "none";
  }

  function renderMessages() {
    if (!messagesEl) return;
    messagesEl.innerHTML = "";
    chatMessages.forEach(function(msg) {
      var div = document.createElement("div");
      div.className = "shogo-msg shogo-msg-" + msg.role;
      div.textContent = msg.content;
      messagesEl.appendChild(div);
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function createWidget() {
    var color = config.primaryColor || "#6366f1";
    var pos = config.position || "bottom-right";
    var isLeft = pos === "bottom-left";

    var style = document.createElement("style");
    style.textContent = \`
      .shogo-container { position:fixed; bottom:20px; \${isLeft?"left":"right"}:20px; z-index:99999; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
      .shogo-bubble { width:56px; height:56px; border-radius:50%; background:\${color}; cursor:pointer; display:flex; align-items:center; justify-content:center; box-shadow:0 4px 12px rgba(0,0,0,0.15); transition:transform 0.2s,box-shadow 0.2s; border:none; }
      .shogo-bubble:hover { transform:scale(1.08); box-shadow:0 6px 20px rgba(0,0,0,0.2); }
      .shogo-bubble svg { width:26px; height:26px; fill:white; }
      .shogo-window { display:none; position:absolute; bottom:70px; \${isLeft?"left":"right"}:0; width:380px; max-width:calc(100vw - 40px); height:520px; max-height:calc(100vh - 120px); background:#fff; border-radius:16px; box-shadow:0 8px 30px rgba(0,0,0,0.12); overflow:hidden; flex-direction:column; animation:shogo-slide-up 0.25s ease-out; }
      .shogo-window.open { display:flex; }
      @keyframes shogo-slide-up { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
      .shogo-header { background:\${color}; color:#fff; padding:16px 20px; display:flex; align-items:center; gap:12px; }
      .shogo-header-text h3 { margin:0; font-size:15px; font-weight:600; }
      .shogo-header-text p { margin:2px 0 0; font-size:12px; opacity:0.85; }
      .shogo-close { background:none; border:none; color:#fff; cursor:pointer; margin-left:auto; padding:4px; opacity:0.8; font-size:20px; line-height:1; }
      .shogo-close:hover { opacity:1; }
      .shogo-messages { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:8px; }
      .shogo-msg { max-width:85%; padding:10px 14px; border-radius:16px; font-size:14px; line-height:1.45; word-wrap:break-word; white-space:pre-wrap; }
      .shogo-msg-user { align-self:flex-end; background:\${color}; color:#fff; border-bottom-right-radius:4px; }
      .shogo-msg-agent { align-self:flex-start; background:#f0f0f0; color:#1a1a1a; border-bottom-left-radius:4px; }
      .shogo-typing { display:none; align-self:flex-start; padding:10px 14px; background:#f0f0f0; border-radius:16px; border-bottom-left-radius:4px; gap:4px; align-items:center; }
      .shogo-typing span { width:6px; height:6px; border-radius:50%; background:#999; animation:shogo-dot 1.4s infinite; }
      .shogo-typing span:nth-child(2) { animation-delay:0.2s; }
      .shogo-typing span:nth-child(3) { animation-delay:0.4s; }
      @keyframes shogo-dot { 0%,60%,100%{opacity:0.3;transform:scale(0.8)} 30%{opacity:1;transform:scale(1)} }
      .shogo-input-bar { display:flex; padding:12px; border-top:1px solid #e5e5e5; gap:8px; background:#fff; }
      .shogo-input-bar input { flex:1; border:1px solid #ddd; border-radius:24px; padding:10px 16px; font-size:14px; outline:none; transition:border-color 0.2s; }
      .shogo-input-bar input:focus { border-color:\${color}; }
      .shogo-input-bar button { width:38px; height:38px; border-radius:50%; background:\${color}; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:opacity 0.2s; }
      .shogo-input-bar button:disabled { opacity:0.5; cursor:default; }
      .shogo-input-bar button svg { width:18px; height:18px; fill:#fff; }
      .shogo-avatar { width:32px; height:32px; border-radius:50%; background:rgba(255,255,255,0.2); display:flex; align-items:center; justify-content:center; flex-shrink:0; }
      .shogo-avatar img { width:100%; height:100%; border-radius:50%; object-fit:cover; }
      .shogo-avatar svg { width:18px; height:18px; fill:#fff; }
      .shogo-powered { text-align:center; padding:6px; font-size:10px; color:#aaa; background:#fafafa; }
      .shogo-powered a { color:#888; text-decoration:none; }
      @media (max-width:480px) {
        .shogo-window { width:100vw; height:100vh; max-height:100vh; bottom:0; \${isLeft?"left":"right"}:-20px; border-radius:0; }
        .shogo-container { bottom:12px; \${isLeft?"left":"right"}:12px; }
      }
    \`;
    document.head.appendChild(style);

    container = document.createElement("div");
    container.className = "shogo-container";

    // Chat bubble
    bubble = document.createElement("button");
    bubble.className = "shogo-bubble";
    bubble.setAttribute("aria-label", "Open chat");
    bubble.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/><path d="M7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/></svg>';
    bubble.onclick = toggleChat;
    container.appendChild(bubble);

    // Chat window
    chatWindow = document.createElement("div");
    chatWindow.className = "shogo-window";
    chatWindow.innerHTML = [
      '<div class="shogo-header">',
        '<div class="shogo-avatar">' + (config.avatarUrl ? '<img src="' + config.avatarUrl + '" alt="avatar">' : '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>') + '</div>',
        '<div class="shogo-header-text"><h3>' + (config.title || "Chat with us") + '</h3>' + (config.subtitle ? '<p>' + config.subtitle + '</p>' : '') + '</div>',
        '<button class="shogo-close" aria-label="Close chat">&times;</button>',
      '</div>',
      '<div class="shogo-messages"></div>',
      '<div class="shogo-typing"><span></span><span></span><span></span></div>',
      '<div class="shogo-input-bar">',
        '<input type="text" placeholder="Type a message..." aria-label="Message">',
        '<button aria-label="Send"><svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>',
      '</div>',
      '<div class="shogo-powered">Powered by <a href="https://shogo.ai" target="_blank" rel="noopener">Shogo</a></div>',
    ].join("");

    container.appendChild(chatWindow);
    document.body.appendChild(container);

    messagesEl = chatWindow.querySelector(".shogo-messages");
    inputEl = chatWindow.querySelector(".shogo-input-bar input");

    chatWindow.querySelector(".shogo-close").onclick = toggleChat;
    chatWindow.querySelector(".shogo-input-bar button").onclick = function() {
      sendMessage(inputEl.value);
      inputEl.value = "";
    };
    inputEl.addEventListener("keydown", function(e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage(inputEl.value);
        inputEl.value = "";
      }
    });

    // Restore history
    chatMessages = getStoredHistory();
    if (chatMessages.length > 0) {
      renderMessages();
    }
  }

  function toggleChat() {
    isOpen = !isOpen;
    if (chatWindow) chatWindow.classList.toggle("open", isOpen);
    if (bubble) bubble.style.display = isOpen ? "none" : "flex";
    if (isOpen && inputEl) inputEl.focus();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();`
}
