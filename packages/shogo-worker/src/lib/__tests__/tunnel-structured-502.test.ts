// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pin the wire shape of the structured 502 response WorkerTunnel sends
 * when a resolver declines to forward a tunneled request. Studio reads
 * `code`, `message`, and `path` from the body so a future debugger can
 * tell what was attempted without log archaeology.
 */
import { describe, expect, it } from 'bun:test';
import { WorkerTunnel, type ResolveRejection, type RuntimeResolver } from '../tunnel.ts';

class FakeWebSocket {
  readyState = 1; // WebSocket.OPEN
  sent: string[] = [];
  send(msg: string): void {
    this.sent.push(msg);
  }
  close(): void {
    this.readyState = 3; // WebSocket.CLOSED
  }
}

function makeResolver(overrides: Partial<RuntimeResolver> = {}): RuntimeResolver {
  return {
    resolveLocalUrl: async () => null,
    deriveRuntimeToken: () => null,
    getActiveProjects: () => [],
    status: () => null,
    ...overrides,
  };
}

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

describe('WorkerTunnel structured 502', () => {
  it('echoes resolver-provided code+message and the original path', async () => {
    const rejection: ResolveRejection = {
      code: 'CLI_WORKER_HAS_NO_DATA_API',
      message: 'cli-worker only serves /agent/* paths; tried: /api/projects',
    };
    const resolver = makeResolver({
      describeRejection: () => rejection,
    });
    const tunnel = new WorkerTunnel({
      apiKey: 'shogo_sk_x',
      cloudUrl: 'https://api.test',
      resolver,
      logger: silentLogger,
    });
    const fake = new FakeWebSocket();
    tunnel._testing().installFakeWs(fake as unknown as WebSocket);

    await tunnel._testing().handleRequest({
      type: 'request',
      requestId: 'r-1',
      method: 'GET',
      path: '/api/projects?workspaceId=ws-1',
      stream: false,
    });

    expect(fake.sent.length).toBe(1);
    const frame = JSON.parse(fake.sent[0]!);
    expect(frame.type).toBe('response');
    expect(frame.requestId).toBe('r-1');
    expect(frame.status).toBe(502);
    expect(frame.headers?.['content-type']).toBe('application/json');

    const body = JSON.parse(frame.body);
    expect(body.code).toBe('CLI_WORKER_HAS_NO_DATA_API');
    expect(body.message).toBe(rejection.message);
    // Tunnel always echoes back the ORIGINAL path (with query) so a
    // browser request's URL survives the round-trip into the 502 body.
    expect(body.path).toBe('/api/projects?workspaceId=ws-1');
  });

  it('falls back to a generic NO_LOCAL_RUNTIME body when resolver omits describeRejection', async () => {
    const resolver = makeResolver();
    const tunnel = new WorkerTunnel({
      apiKey: 'shogo_sk_x',
      cloudUrl: 'https://api.test',
      resolver,
      logger: silentLogger,
    });
    const fake = new FakeWebSocket();
    tunnel._testing().installFakeWs(fake as unknown as WebSocket);

    await tunnel._testing().handleRequest({
      type: 'request',
      requestId: 'r-2',
      method: 'GET',
      path: '/whatever',
      stream: false,
    });

    expect(fake.sent.length).toBe(1);
    const body = JSON.parse(JSON.parse(fake.sent[0]!).body);
    expect(body.code).toBe('NO_LOCAL_RUNTIME');
    expect(body.path).toBe('/whatever');
    expect(body.message).toContain('/whatever');
  });
});
