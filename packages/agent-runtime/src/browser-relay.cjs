#!/usr/bin/env node
/**
 * CDP Relay Server for the Playwright MCP Bridge extension.
 *
 * Runs under Node.js (not bun) because the ws library's HTTP upgrade
 * handling requires Node's native http server implementation.
 *
 * Protocol (stdout, newline-delimited JSON):
 *   { "type": "ready", "cdpEndpoint": "ws://...", "extensionEndpoint": "ws://..." }
 *   { "type": "connected" }
 *   { "type": "error", "message": "..." }
 */
'use strict';

const path = require('path');
const http = require('http');

const channel = process.argv[2] || 'chrome';
const executablePath = process.argv[3] || undefined;
const connectionTimeout = parseInt(process.argv[4] || '90000', 10);

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

(async () => {
  try {
    const mcpPkgDir = path.dirname(require.resolve('@playwright/mcp/package.json'));
    const pwPkgDir = path.dirname(require.resolve('playwright/package.json', { paths: [mcpPkgDir] }));
    const { CDPRelayServer } = require(path.join(pwPkgDir, 'lib/mcp/extension/cdpRelay.js'));

    const server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const relay = new CDPRelayServer(server, channel, undefined, executablePath || undefined);

    emit({
      type: 'ready',
      cdpEndpoint: relay.cdpEndpoint(),
      extensionEndpoint: relay.extensionEndpoint(),
    });

    process.env.PWMCP_TEST_CONNECTION_TIMEOUT = String(connectionTimeout);

    const abortController = new AbortController();
    await relay.ensureExtensionConnectionForMCPContext(
      { name: 'Shogo', version: '1.0' },
      abortController.signal,
      undefined,
    );

    emit({ type: 'connected' });

    process.on('SIGTERM', () => { relay.stop(); server.close(); process.exit(0); });
    process.on('SIGINT', () => { relay.stop(); server.close(); process.exit(0); });
  } catch (err) {
    emit({ type: 'error', message: err.message });
    process.exit(1);
  }
})();
