#!/usr/bin/env node
/**
 * CDP Relay Server for the Playwright MCP Bridge extension — relay protocol v2.
 *
 * Runs under Node.js (not bun) because the ws library's HTTP upgrade
 * handling requires Node's native http server implementation.
 *
 * Why this file exists (SHO-360): the Chrome extension auto-updates from the
 * Web Store, and it only accepts the exact protocol version it was built for
 * (it rejects anything lower with "The client uses an unsupported protocol
 * version" and anything higher with a "update the extension" page). Playwright
 * speaks that protocol from inside a private bundle — `@playwright/mcp` 0.0.68
 * re-exported the v1 relay from `playwright/lib/mcp/extension/cdpRelay.js`, and
 * 0.0.84 moved the v2 relay into `playwright-core/lib/coreBundle.js` without
 * exporting it, so there is no public entry point we can call. Rather than
 * deep-require a minified bundle (which breaks again on the next upstream
 * move), the relay protocol is vendored here.
 *
 * Ported from microsoft/playwright, packages/playwright-core/src/tools/mcp/
 * {cdpRelay, cdpRelayV2, browserModel, protocol}.ts — Apache-2.0,
 * Copyright (c) Microsoft Corporation. See NOTICE.
 *
 * Protocol (stdout, newline-delimited JSON):
 *   { "type": "ready", "cdpEndpoint": "ws://...", "extensionEndpoint": "ws://...", "protocolVersion": 2 }
 *   { "type": "connected" }
 *   { "type": "error", "message": "..." }
 *
 * Usage: node browser-relay.cjs [channel] [executablePath] [connectionTimeoutMs]
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');

/** The extension protocol this relay speaks. The extension accepts only this exact value. */
const RELAY_PROTOCOL_VERSION = 2;

const EXTENSION_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm';
const EXTENSION_INSTALL_URL = `https://chromewebstore.google.com/detail/playwright-extension/${EXTENSION_ID}`;

// ─── Small helpers ───────────────────────────────────────────────────────────

class ManualPromise {
  constructor() {
    this._done = false;
    this._promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
    // A pending handshake nobody awaits yet must not become an unhandled rejection.
    this._promise.catch(() => {});
  }

  isDone() {
    return this._done;
  }

  resolve(value) {
    this._done = true;
    this._resolve(value);
  }

  reject(error) {
    this._done = true;
    this._reject(error);
  }

  then(onFulfilled, onRejected) {
    return this._promise.then(onFulfilled, onRejected);
  }

  catch(onRejected) {
    return this._promise.catch(onRejected);
  }
}

// ─── Browser model (extension tabs → CDP sessions) ───────────────────────────

/**
 * Owns the mapping between Chrome tabs (reached through `chrome.debugger`) and
 * the CDP sessions Playwright expects to see, and translates between them.
 */
class BrowserModel {
  constructor(sendToExtension) {
    // Set only while a Playwright CDP connection is attached (see
    // `connectOverCDP`). Before that, any attempt to emit to Playwright is a
    // no-op — the model is observation-only during the extension handshake.
    this._sendToCDPClient = null;
    // Tabs observed via chrome.tabs.onCreated, whether or not the debugger is attached yet.
    this._knownTabs = new Map();
    // Subset of _knownTabs we've attached the debugger to and assigned a sessionId.
    this._tabSessions = new Map();
    this._autoAttach = false;
    this._nextSessionId = 1;
    this._sendToExtension = sendToExtension;
  }

  // Wires the model's CDP output sink. Called by the handler once the extension
  // handshake is done and a Playwright CDP client is ready to receive events.
  connectOverCDP(sendToCDPClient) {
    this._sendToCDPClient = sendToCDPClient;
  }

  _emit(message) {
    if (this._sendToCDPClient)
      this._sendToCDPClient(message);
  }

  // ─── Extension → model inputs ─────────────────────────────────────────────

  onTabCreated(tab) {
    if (tab.id === undefined)
      return;
    this._knownTabs.set(tab.id, tab);
    if (this._autoAttach)
      void this._attachTab(tab.id).catch(() => {});
  }

  onTabRemoved(tabId) {
    this._knownTabs.delete(tabId);
    this._detachTab(tabId);
  }

  onDebuggerEvent(source, method, params) {
    if (source.tabId === undefined)
      return;
    const tabSession = this._tabSessions.get(source.tabId);
    if (!tabSession)
      return;
    const childSessionId = params?.sessionId;
    if (method === 'Target.attachedToTarget' && childSessionId)
      tabSession.childSessions.add(childSessionId);
    else if (method === 'Target.detachedFromTarget' && childSessionId)
      tabSession.childSessions.delete(childSessionId);
    const sessionId = source.sessionId || tabSession.sessionId;
    this._emit({ sessionId, method, params });
  }

  onDebuggerDetach(source) {
    if (source.tabId !== undefined)
      this._detachTab(source.tabId);
  }

  // ─── Playwright → model commands ──────────────────────────────────────────

  /** Turn auto-attach on and attach to every tab we already know about. */
  async enableAutoAttach() {
    this._autoAttach = true;
    const tabIds = [...this._knownTabs.keys()];
    await Promise.all(tabIds.map((tabId) => this._attachTab(tabId).catch(() => {})));
  }

  async createTarget(url) {
    const tab = await this._sendToExtension('chrome.tabs.create', [{ url }]);
    if (tab?.id === undefined)
      throw new Error('Failed to create tab');
    this._knownTabs.set(tab.id, tab);
    const tabSession = await this._attachTab(tab.id);
    return { targetId: tabSession.targetInfo?.targetId };
  }

  async closeTarget(targetId) {
    const tabSession = targetId ? this._findTabSession((s) => s.targetInfo?.targetId === targetId) : undefined;
    if (!tabSession)
      return { success: false };
    await this._sendToExtension('chrome.tabs.remove', [tabSession.tabId]);
    return { success: true };
  }

  getTargetInfo(sessionId) {
    if (!sessionId)
      return undefined;
    return this._findTabSession((s) => s.sessionId === sessionId)?.targetInfo;
  }

  // Forward a browser-level CDP command (Storage.*, Browser.*, etc.) that is not
  // associated with a specific tab. chrome.debugger.sendCommand requires a
  // target, so we route through any attached tab; the command itself is
  // browser-scoped and returns the same result regardless of which tab is used.
  async sendBrowserCommand(method, params) {
    const tabSession = this._tabSessions.values().next().value;
    if (!tabSession)
      throw new Error(`No attached tab to forward browser-level command: ${method}`);
    return await this._sendToExtension('chrome.debugger.sendCommand', [{ tabId: tabSession.tabId }, method, params]);
  }

  /** Forward a CDP command from Playwright to the tab its sessionId resolves to. */
  async sendCommand(sessionId, method, params) {
    let tabSession = this._findTabSession((s) => s.sessionId === sessionId);
    let cdpSessionId;
    if (!tabSession) {
      tabSession = this._findTabSession((s) => s.childSessions.has(sessionId));
      cdpSessionId = sessionId;
    }
    if (!tabSession)
      throw new Error(`No tab found for sessionId: ${sessionId}`);
    return await this._sendToExtension('chrome.debugger.sendCommand', [
      { tabId: tabSession.tabId, sessionId: cdpSessionId },
      method,
      params,
    ]);
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  async _attachTab(tabId) {
    const existing = this._tabSessions.get(tabId);
    if (existing)
      return existing;
    await this._sendToExtension('chrome.debugger.attach', [{ tabId }, '1.3']);
    const result = await this._sendToExtension('chrome.debugger.sendCommand', [{ tabId }, 'Target.getTargetInfo']);
    const targetInfo = result?.targetInfo;
    const sessionId = `pw-tab-${this._nextSessionId++}`;
    const tabSession = { tabId, sessionId, targetInfo, childSessions: new Set() };
    this._tabSessions.set(tabId, tabSession);
    this._emit({
      method: 'Target.attachedToTarget',
      params: {
        sessionId,
        targetInfo: { ...targetInfo, attached: true },
        waitingForDebugger: false,
      },
    });
    return tabSession;
  }

  _detachTab(tabId) {
    const tabSession = this._tabSessions.get(tabId);
    if (!tabSession)
      return;
    this._tabSessions.delete(tabId);
    this._emit({
      method: 'Target.detachedFromTarget',
      params: {
        sessionId: tabSession.sessionId,
        targetId: tabSession.targetInfo?.targetId,
      },
    });
  }

  _findTabSession(predicate) {
    for (const session of this._tabSessions.values()) {
      if (predicate(session))
        return session;
    }
    return undefined;
  }
}

// ─── Protocol v2 handler ─────────────────────────────────────────────────────

class ExtensionProtocolV2 {
  constructor(sendCommand) {
    // Resolved by `extension.initialized`. Purely a handshake signal for the
    // relay — the model itself is oblivious to this phase.
    this._ready = new ManualPromise();
    this._model = new BrowserModel(sendCommand);
  }

  /** Resolves once the extension has completed its initial handshake. */
  ready() {
    return this._ready;
  }

  connectOverCDP(sendToCDPClient) {
    this._model.connectOverCDP(sendToCDPClient);
  }

  /** Rejects a pending ready() so a blocked handshake bails out instead of hanging. */
  onExtensionDisconnect(reason) {
    if (!this._ready.isDone())
      this._ready.reject(new Error(`Extension disconnected before initialization: ${reason}`));
  }

  handleExtensionEvent(method, params) {
    switch (method) {
      case 'chrome.debugger.onEvent': {
        const [source, cdpMethod, cdpParams] = params;
        this._model.onDebuggerEvent(source, cdpMethod, cdpParams);
        break;
      }
      case 'chrome.debugger.onDetach': {
        const [source] = params;
        this._model.onDebuggerDetach(source);
        break;
      }
      case 'chrome.tabs.onCreated': {
        const [tab] = params;
        this._model.onTabCreated(tab);
        break;
      }
      case 'chrome.tabs.onRemoved': {
        const [tabId] = params;
        this._model.onTabRemoved(tabId);
        break;
      }
      case 'extension.initialized': {
        this._ready.resolve();
        break;
      }
    }
  }

  /**
   * Handles a protocol-specific CDP command. Returns { result } if handled,
   * undefined to fall through to forwarding to the extension.
   */
  async handleCDPCommand(method, params, sessionId) {
    switch (method) {
      case 'Target.setAutoAttach': {
        if (sessionId)
          return undefined;
        await this._model.enableAutoAttach();
        return { result: {} };
      }
      case 'Target.createTarget':
        return { result: await this._model.createTarget(params?.url) };
      case 'Target.closeTarget':
        return { result: await this._model.closeTarget(params?.targetId) };
      case 'Target.getTargetInfo':
        return { result: this._model.getTargetInfo(sessionId) };
    }
    return undefined;
  }

  async forwardToExtension(method, params, sessionId) {
    if (!sessionId)
      return await this._model.sendBrowserCommand(method, params);
    return await this._model.sendCommand(sessionId, method, params);
  }
}

// ─── Extension WebSocket connection ─────────────────────────────────────────

class ExtensionConnection {
  constructor(ws) {
    this._callbacks = new Map();
    this._lastId = 0;
    this._ws = ws;
    this._ws.on('message', (data) => this._onMessage(data));
    this._ws.on('close', (code, reason) => this._onClose(code, reason));
    this._ws.on('error', (error) => this._onError(error));
  }

  async send(method, params) {
    if (this._ws.readyState !== WebSocket.OPEN)
      throw new Error(`Unexpected WebSocket state: ${this._ws.readyState}`);
    const id = ++this._lastId;
    this._ws.send(JSON.stringify({ id, method, params }));
    const error = new Error(`Protocol error: ${method}`);
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, { resolve, reject, error });
    });
  }

  close(message) {
    if (this._ws.readyState === WebSocket.OPEN)
      this._ws.close(1000, message);
  }

  _onMessage(data) {
    const eventData = data.toString();
    let parsed;
    try {
      parsed = JSON.parse(eventData);
    } catch {
      this._ws.close();
      return;
    }
    try {
      this._handleParsedMessage(parsed);
    } catch {
      this._ws.close();
    }
  }

  _handleParsedMessage(object) {
    if (object.id && this._callbacks.has(object.id)) {
      const callback = this._callbacks.get(object.id);
      this._callbacks.delete(object.id);
      if (object.error) {
        const error = callback.error;
        error.message = object.error;
        callback.reject(error);
      } else {
        callback.resolve(object.result);
      }
    } else if (!object.id && this.onmessage) {
      this.onmessage(object.method, object.params);
    }
  }

  _onClose(code, reason) {
    const message = reason ? reason.toString() : '';
    this._dispose();
    if (this.onclose)
      this.onclose(message);
  }

  _onError() {
    this._dispose();
  }

  _dispose() {
    for (const callback of this._callbacks.values())
      callback.reject(new Error('WebSocket closed'));
    this._callbacks.clear();
  }
}

// ─── Chrome launch (opens the extension's connect page) ─────────────────────

function chromeUserDataDirs() {
  const home = os.homedir();
  if (process.platform === 'darwin')
    return [path.join(home, 'Library', 'Application Support', 'Google', 'Chrome')];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [path.join(localAppData, 'Google', 'Chrome', 'User Data')];
  }
  return [path.join(home, '.config', 'google-chrome')];
}

/**
 * Reads the protocol version the installed Playwright MCP Bridge extension
 * speaks, straight from the extension's `connect.js` (`var
 * SUPPORTED_PROTOCOL_VERSION = 2;`). Best effort: an extension layout we don't
 * recognise yields an empty list, and the caller falls back to a plain timeout.
 */
function findInstalledExtensionProtocolVersions(userDataDirs = chromeUserDataDirs()) {
  const found = [];
  for (const userDataDir of userDataDirs) {
    let profiles = [];
    try {
      profiles = fs.readdirSync(userDataDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const profile of profiles) {
      const extensionRoot = path.join(userDataDir, profile, 'Extensions', EXTENSION_ID);
      let extensionVersions = [];
      try {
        extensionVersions = fs.readdirSync(extensionRoot);
      } catch {
        continue;
      }
      for (const extensionDirectory of extensionVersions) {
        const connectScript = path.join(extensionRoot, extensionDirectory, 'lib', 'ui', 'connect.js');
        let source;
        try {
          source = fs.readFileSync(connectScript, 'utf8');
        } catch {
          continue;
        }
        const match = source.match(/SUPPORTED_PROTOCOL_VERSION\s*=\s*(\d+)/);
        if (!match)
          continue;
        found.push({
          profile,
          // Chrome installs into `<version>_<n>`; report the version people see.
          extensionVersion: extensionDirectory.replace(/_\d+$/, ''),
          protocolVersion: Number(match[1]),
        });
      }
    }
  }
  return found;
}

/**
 * Chrome channel/alias → executable. Playwright's registry resolves this from
 * its private bundle, so the handful of channels we actually launch are listed
 * here. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` overrides everything.
 */
function resolveExecutablePath(channel) {
  const mac = {
    chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    chromium: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    msedge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  };
  const win = (name) => {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const root of roots) {
      const candidate = path.join(root, name);
      if (fs.existsSync(candidate))
        return candidate;
    }
    return undefined;
  };
  const normalized = channel === 'chrome' || channel === 'chromium' ? 'chrome' : channel;
  if (process.platform === 'darwin') {
    const candidate = mac[channel] || mac[normalized];
    if (candidate && fs.existsSync(candidate))
      return candidate;
    return undefined;
  }
  if (process.platform === 'win32') {
    if (normalized === 'chrome')
      return win(path.join('Google', 'Chrome', 'Application', 'chrome.exe'));
    if (channel === 'chromium')
      return win(path.join('Chromium', 'Application', 'chrome.exe'));
    if (channel === 'msedge')
      return win(path.join('Microsoft', 'Edge', 'Application', 'msedge.exe'));
    return undefined;
  }
  // linux
  const candidates = normalized === 'chrome'
    ? ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']
    : channel === 'chromium'
      ? ['/usr/bin/chromium', '/usr/bin/chromium-browser']
      : [];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate))
      return candidate;
  }
  return undefined;
}

function buildConnectUrl({ extensionEndpoint, token, clientName }) {
  const url = new URL(`chrome-extension://${EXTENSION_ID}/connect.html`);
  url.searchParams.set('mcpRelayUrl', extensionEndpoint);
  url.searchParams.set('client', JSON.stringify({ name: clientName, version: undefined }));
  url.searchParams.set('protocolVersion', String(RELAY_PROTOCOL_VERSION));
  if (token)
    url.searchParams.set('token', token);
  return url.toString();
}

function connectPageArgs({ channel, userDataDir, profileDirectory, url }) {
  const args = [];
  if (userDataDir)
    args.push(`--user-data-dir=${userDataDir}`);
  if (profileDirectory)
    args.push(`--profile-directory=${profileDirectory}`);
  if (process.platform === 'linux' && channel === 'chromium')
    args.push('--no-sandbox');
  args.push(url);
  return args;
}

// ─── Relay server ───────────────────────────────────────────────────────────

class CDPRelayServer {
  /**
   * @param {object} options
   * @param {string} [options.channel]        browser channel (`chrome`, `chromium`, `msedge`)
   * @param {string} [options.executablePath] explicit browser executable
   * @param {string} [options.userDataDir]    Chrome user data dir (defaults to the channel's)
   * @param {string} [options.profileDirectory]
   * @param {string} [options.token]          PLAYWRIGHT_MCP_EXTENSION_TOKEN
   * @param {number} [options.connectionTimeout]
   * @param {(info: object) => any} [options.launchBrowser]  test seam; defaults to spawning Chrome
   */
  constructor(options = {}) {
    this._cdpConnection = null;
    this._extensionConnection = null;
    this._extensionConnectionPromise = new ManualPromise();
    this._channel = options.channel || 'chrome';
    this._executablePath = options.executablePath || undefined;
    this._customUserDataDir = options.userDataDir || undefined;
    this._profileDirectory = options.profileDirectory || undefined;
    this._token = options.token || undefined;
    this._connectionTimeout = options.connectionTimeout ?? 90000;
    this._launchError = undefined;
    this._launchBrowser = options.launchBrowser || ((info) => {
      if (!info.executablePath) {
        throw new Error(
          `Could not find a "${info.channel}" executable to open the Playwright extension's connect page. ` +
          'Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to the browser binary.',
        );
      }
      const child = spawn(info.executablePath, connectPageArgs(info), {
        windowsHide: true,
        detached: true,
        shell: false,
        stdio: 'ignore',
      });
      // A missing browser must not crash the relay — the handshake timeout
      // reports it, with this message attached.
      child.on('error', (error) => { this._launchError = error; });
    });

    const sendCommand = (method, params) => {
      if (!this._extensionConnection)
        throw new Error('Extension not connected');
      return this._extensionConnection.send(method, params);
    };
    this._handler = new ExtensionProtocolV2(sendCommand);

    const uuid = require('crypto').randomUUID();
    this._cdpPath = `/cdp/${uuid}`;
    this._extensionPath = `/extension/${uuid}`;

    this._httpServer = http.createServer((request, response) => {
      response.statusCode = 404;
      response.end();
    });
    this._wsServer = new WebSocketServer({ noServer: true });
    this._httpServer.on('upgrade', (request, socket, head) => {
      const { pathname } = new URL(request.url || '/', 'ws://127.0.0.1');
      if (pathname === this._cdpPath) {
        this._wsServer.handleUpgrade(request, socket, head, (ws) => this._handlePlaywrightConnection(ws));
      } else if (pathname === this._extensionPath) {
        this._wsServer.handleUpgrade(request, socket, head, (ws) => this._handleExtensionConnection(ws));
      } else {
        socket.destroy();
      }
    });
  }

  async start() {
    await new Promise((resolve, reject) => {
      this._httpServer.once('error', reject);
      this._httpServer.listen(0, '127.0.0.1', resolve);
    });
    this._port = this._httpServer.address().port;
    this._host = `ws://127.0.0.1:${this._port}`;
  }

  cdpEndpoint() {
    return `${this._host}${this._cdpPath}`;
  }

  extensionEndpoint() {
    return `${this._host}${this._extensionPath}`;
  }

  async establishExtensionConnection(clientName) {
    const url = buildConnectUrl({
      extensionEndpoint: this.extensionEndpoint(),
      token: this._token,
      clientName,
    });
    await this._launchBrowser({
      channel: this._channel,
      executablePath: this._executablePath,
      userDataDir: this._customUserDataDir,
      profileDirectory: this._profileDirectory,
      extensionEndpoint: this.extensionEndpoint(),
      url,
      token: this._token,
      clientName,
    });

    const timeoutMs = this._connectionTimeout;
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const launchError = this._launchError ? ` The browser could not be started: ${this._launchError.message}.` : '';
        reject(new Error(
          `The Playwright MCP Bridge extension did not connect within ${Math.round(timeoutMs / 1000)}s.` +
          launchError +
          ` Shogo's relay speaks extension protocol ${RELAY_PROTOCOL_VERSION}; make sure the extension is installed in ` +
          'the Chrome profile Shogo opened and that the token saved in Shogo matches the extension\'s token.',
        ));
      }, timeoutMs);
    });

    try {
      await Promise.race([
        (async () => {
          await this._extensionConnectionPromise;
          await this._handler.ready();
        })(),
        timedOut,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  stop() {
    this._closeConnections('Server stopped');
    try {
      this._wsServer.close();
    } catch {
      // already closed
    }
    try {
      this._httpServer.close();
    } catch {
      // already closed
    }
  }

  _closeConnections(reason) {
    this._closeCDPConnection(reason);
    this._closeExtensionConnection(reason);
  }

  _closeExtensionConnection(reason) {
    if (this._extensionConnection)
      this._extensionConnection.close(reason);
    if (!this._extensionConnectionPromise.isDone())
      this._extensionConnectionPromise.reject(new Error(reason));
  }

  _closeCDPConnection(reason) {
    if (this._cdpConnection?.readyState === WebSocket.OPEN)
      this._cdpConnection.close(1000, reason);
  }

  _handleExtensionConnection(ws) {
    if (this._extensionConnection) {
      ws.close(1000, 'Another extension connection already established');
      return;
    }
    const connection = new ExtensionConnection(ws);
    this._extensionConnection = connection;
    // A fresh handler so a reconnecting extension gets a fresh handshake — the
    // old one's `ready()` promise can only settle once.
    this._handler = new ExtensionProtocolV2((method, params) => connection.send(method, params));
    this._extensionConnection.onclose = (reason) => {
      if (this._extensionConnection === connection) {
        this._extensionConnection = null;
        if (this._extensionConnectionPromise.isDone())
          this._extensionConnectionPromise = new ManualPromise();
      }
      this._handler.onExtensionDisconnect(reason);
      this._closeCDPConnection(`Extension disconnected: ${reason}`);
    };
    this._extensionConnection.onmessage = (method, params) => this._handler.handleExtensionEvent(method, params);
    this._extensionConnectionPromise.resolve();
  }

  _handlePlaywrightConnection(ws) {
    if (!this._extensionConnection) {
      ws.close(1000, 'Extension not connected');
      return;
    }
    if (this._cdpConnection) {
      ws.close(1000, 'Another CDP client already connected');
      return;
    }
    this._cdpConnection = ws;
    this._handler.connectOverCDP((message) => this._sendToCDPClient(message));
    ws.on('message', async (data) => {
      try {
        await this._handlePlaywrightMessage(JSON.parse(data.toString()));
      } catch {
        // Malformed CDP frame — Playwright will surface its own timeout.
      }
    });
    ws.on('close', () => {
      if (this._cdpConnection === ws)
        this._cdpConnection = null;
      this._closeExtensionConnection('Playwright client disconnected');
    });
    ws.on('error', () => {});
  }

  async _handlePlaywrightMessage(message) {
    const { id, sessionId, method, params } = message;
    try {
      const result = await this._handleCDPCommand(method, params, sessionId);
      this._sendToCDPClient({ id, sessionId, result });
    } catch (error) {
      this._sendToCDPClient({ id, sessionId, error: { message: error.message } });
    }
  }

  async _handleCDPCommand(method, params, sessionId) {
    switch (method) {
      case 'Browser.getVersion': {
        return {
          protocolVersion: '1.3',
          product: 'Chrome/Extension-Bridge',
          userAgent: 'CDP-Bridge-Server/1.0.0',
        };
      }
      case 'Browser.setDownloadBehavior':
        return {};
    }
    const handled = await this._handler.handleCDPCommand(method, params, sessionId);
    if (handled)
      return handled.result;
    return await this._handler.forwardToExtension(method, params, sessionId);
  }

  _sendToCDPClient(message) {
    this._cdpConnection?.send(JSON.stringify(message));
  }
}

// ─── CLI entry point ────────────────────────────────────────────────────────

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** Human-readable mismatch error naming both sides, or null when the versions line up. */
function protocolMismatchError(installed) {
  if (!installed.length)
    return null;
  if (installed.some((info) => info.protocolVersion === RELAY_PROTOCOL_VERSION))
    return null;
  const described = installed
    .map((info) => `protocol ${info.protocolVersion} (extension v${info.extensionVersion}, profile "${info.profile}")`)
    .join(', ');
  const newer = installed.every((info) => info.protocolVersion > RELAY_PROTOCOL_VERSION);
  return (
    `Playwright extension protocol mismatch: the installed Playwright MCP Bridge extension speaks ${described}, ` +
    `but Shogo's relay speaks protocol ${RELAY_PROTOCOL_VERSION}. ` +
    (newer
      ? `Update Shogo Desktop so its relay speaks protocol ${installed[0].protocolVersion}.`
      : `Update the Playwright MCP Bridge extension from the Chrome Web Store (${EXTENSION_INSTALL_URL}).`)
  );
}

async function main() {
  const channel = process.argv[2] || 'chrome';
  const executablePathArg = process.argv[3] || undefined;
  const connectionTimeout = parseInt(process.argv[4] || '90000', 10);
  const token = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  const executablePath = executablePathArg || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || resolveExecutablePath(channel);

  // An extension that speaks a different protocol never completes the
  // handshake — it shows its own page instead. Say which side is out of date
  // instead of waiting out the timeout. `protocolMismatchError` returns null
  // when no extension was found, so a Chrome we cannot inspect is not an error.
  const mismatch = protocolMismatchError(findInstalledExtensionProtocolVersions());
  if (mismatch) {
    emit({ type: 'error', message: mismatch, protocolVersion: RELAY_PROTOCOL_VERSION });
    process.exit(1);
  }

  const relay = new CDPRelayServer({
    channel,
    executablePath,
    token,
    connectionTimeout,
  });

  // Install the shutdown handlers before anything is observable. `cleanupRelay`
  // kills the relay as soon as it reads a line, so a handler registered after
  // the first `emit` loses the race: the signal is delivered while the process
  // is still between the write and the `process.on` call, and the default
  // disposition kills it (exit 143) instead of shutting down cleanly.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown)
      return;
    shuttingDown = true;
    relay.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  try {
    await relay.start();
    emit({
      type: 'ready',
      cdpEndpoint: relay.cdpEndpoint(),
      extensionEndpoint: relay.extensionEndpoint(),
      protocolVersion: RELAY_PROTOCOL_VERSION,
    });
    await relay.establishExtensionConnection('Shogo');
    emit({ type: 'connected', protocolVersion: RELAY_PROTOCOL_VERSION });
  } catch (error) {
    emit({ type: 'error', message: error.message, protocolVersion: RELAY_PROTOCOL_VERSION });
    relay.stop();
    process.exit(1);
  }
}

module.exports = {
  CDPRelayServer,
  BrowserModel,
  ExtensionProtocolV2,
  RELAY_PROTOCOL_VERSION,
  EXTENSION_ID,
  buildConnectUrl,
  findInstalledExtensionProtocolVersions,
  protocolMismatchError,
  resolveExecutablePath,
};

if (require.main === module)
  void main();
