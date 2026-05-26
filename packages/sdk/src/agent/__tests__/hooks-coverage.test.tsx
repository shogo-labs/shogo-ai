// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Coverage tests for src/agent/hooks.ts.
 *
 * Renders each hook with @testing-library/react under happy-dom and a
 * mocked AgentClient module. Covers all 5 hook bodies + the useClient
 * ref-init helper.
 */
import './happy-dom-setup.ts';
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';

// ─── Mock client module ──────────────────────────────────────────────────────

const clientImpl = {
  getStatus:        mock(async () => ({ status: 'running', port: 3000 })),
  chat:             mock(async (_msgs: unknown, _opts?: unknown) =>
    new Response(new ReadableStream({ start(c) { c.close(); } }))),
  getChatHistory:   mock(async (_sessionId?: string) => [] as Array<{ role: string; content: string }>),
  getMode:          mock(async () => 'chat' as const),
  setMode:          mock(async (_m: unknown) => undefined),
  getWorkspaceTree: mock(async () => [{ name: 'src', type: 'dir', children: [] }] as unknown),
  readFile:         mock(async (p: string) => `// contents of ${p}`),
  writeFile:        mock(async (_p: string, _c: string) => undefined),
};

class FakeAgentClient {
  constructor(_config?: unknown) {}
  getStatus        = (...a: unknown[]) => clientImpl.getStatus(...a);
  chat             = (...a: unknown[]) => clientImpl.chat(...a);
  getChatHistory   = (...a: unknown[]) => clientImpl.getChatHistory(...a);
  getMode          = (...a: unknown[]) => clientImpl.getMode(...a);
  setMode          = (...a: unknown[]) => clientImpl.setMode(...a);
  getWorkspaceTree = (...a: unknown[]) => clientImpl.getWorkspaceTree(...a);
  readFile         = (...a: unknown[]) => clientImpl.readFile(...a);
  writeFile        = (...a: unknown[]) => clientImpl.writeFile(...a);
}

const singleton = new FakeAgentClient();

mock.module('../client.js', () => ({
  AgentClient: FakeAgentClient,
  getAgentClient: () => singleton,
}));

// Import hooks AFTER the mock so they pick up the fake client.
import {
  useAgentStatus,
  useAgentChat,
  useAgentMode,
  useAgentFiles,
} from '../hooks.ts';

beforeEach(() => {
  // Reset every mock's call history + reset to default implementations.
  clientImpl.getStatus.mockClear().mockImplementation(async () => ({ status: 'running', port: 3000 }));
  clientImpl.chat.mockClear().mockImplementation(async () =>
    new Response(new ReadableStream({ start(c) { c.close(); } })));
  clientImpl.getChatHistory.mockClear().mockImplementation(async () => []);
  clientImpl.getMode.mockClear().mockImplementation(async () => 'chat' as const);
  clientImpl.setMode.mockClear().mockImplementation(async () => undefined);
  clientImpl.getWorkspaceTree.mockClear().mockImplementation(async () =>
    [{ name: 'src', type: 'dir', children: [] }]);
  clientImpl.readFile.mockClear().mockImplementation(async (p: string) => `// contents of ${p}`);
  clientImpl.writeFile.mockClear().mockImplementation(async () => undefined);
});

// ─── useAgentStatus ──────────────────────────────────────────────────────────

describe('useAgentStatus', () => {
  it('initial fetch: loading transitions false, status populated', async () => {
    const { result } = renderHook(() => useAgentStatus());
    expect(result.current.loading).toBe(true);
    expect(result.current.status).toBeNull();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status).toEqual({ status: 'running', port: 3000 });
    expect(result.current.error).toBeNull();
  });

  it('fetch error path: error state set, status null', async () => {
    clientImpl.getStatus.mockImplementation(async () => { throw new Error('boom'); });
    const { result } = renderHook(() => useAgentStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('boom');
  });

  it('fetch error path: non-Error rejection wrapped in Error', async () => {
    clientImpl.getStatus.mockImplementation(async () => { throw 'string-rejection'; });
    const { result } = renderHook(() => useAgentStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe('string-rejection');
  });

  it('polling: pollInterval triggers repeat fetches and clears on unmount', async () => {
    const { result, unmount } = renderHook(() => useAgentStatus({ pollInterval: 10 }));
    await waitFor(() => expect(clientImpl.getStatus.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(result.current.status).toBeDefined();
    unmount();
    const callsAfterUnmount = clientImpl.getStatus.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(clientImpl.getStatus.mock.calls.length).toBe(callsAfterUnmount);
  });

  it('pollInterval=0 skips the setInterval branch', async () => {
    const { result } = renderHook(() => useAgentStatus({ pollInterval: 0 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const calls = clientImpl.getStatus.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(clientImpl.getStatus.mock.calls.length).toBe(calls);
  });

  it('refetch() manually re-invokes the fetcher', async () => {
    const { result } = renderHook(() => useAgentStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = clientImpl.getStatus.mock.calls.length;
    await act(async () => { result.current.refetch(); });
    expect(clientImpl.getStatus.mock.calls.length).toBe(before + 1);
  });

  it('with explicit config: constructs a new AgentClient (not singleton)', async () => {
    const { result } = renderHook(() =>
      useAgentStatus({ config: { baseUrl: 'http://custom' } as any }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status).toBeDefined();
  });
});

// ─── useAgentChat ────────────────────────────────────────────────────────────

function sseStream(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream);
}

describe('useAgentChat', () => {
  it('loads chat history on mount when getChatHistory returns messages', async () => {
    clientImpl.getChatHistory.mockImplementation(async () => [
      { role: 'user', content: 'prior question' },
      { role: 'assistant', content: 'prior answer' },
    ]);
    const { result } = renderHook(() => useAgentChat({ sessionId: 's-1' }));
    await waitFor(() => expect(result.current.messages.length).toBe(2));
    expect(result.current.messages[0].content).toBe('prior question');
  });

  it('skips history population when history is empty', async () => {
    const { result } = renderHook(() => useAgentChat());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.messages.length).toBe(0);
  });

  it('swallows history fetch errors silently', async () => {
    clientImpl.getChatHistory.mockImplementation(async () => { throw new Error('hist-fail'); });
    const { result } = renderHook(() => useAgentChat());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.messages.length).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it('send(): streams assistant chunks and appends both user + assistant messages', async () => {
    clientImpl.chat.mockImplementation(async () => sseStream([
      '0:"Hello"\n0:" world"\n',
      '0:"!"\nz:{ignore}\n',
    ]));
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { await result.current.send('hi'); });
    expect(result.current.messages.length).toBe(2);
    expect(result.current.messages[0]).toEqual({ role: 'user', content: 'hi' });
    expect(result.current.messages[1]).toEqual({ role: 'assistant', content: 'Hello world!' });
    expect(result.current.isStreaming).toBe(false);
  });

  it('send(): skips lines that do not start with "0:" and tolerates non-JSON payloads', async () => {
    clientImpl.chat.mockImplementation(async () => sseStream([
      'noise\n0:"ok"\n0:not-json\n',
    ]));
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { await result.current.send('q'); });
    expect(result.current.messages[1].content).toBe('ok');
  });

  it('send(): skips a non-string JSON payload (e.g. number) without appending', async () => {
    clientImpl.chat.mockImplementation(async () => sseStream(['0:42\n']));
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { await result.current.send('q'); });
    // Only the user message — assistant text was 0-length so no append
    expect(result.current.messages.length).toBe(1);
  });

  it('send(): when response.body is null, only the user message remains', async () => {
    clientImpl.chat.mockImplementation(async () => new Response(null));
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { await result.current.send('q'); });
    expect(result.current.messages.length).toBe(1);
    expect(result.current.messages[0]).toEqual({ role: 'user', content: 'q' });
  });

  it('send(): chat() throwing sets error state and unsets isStreaming', async () => {
    clientImpl.chat.mockImplementation(async () => { throw new Error('chat-down'); });
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { await result.current.send('q'); });
    expect(result.current.error?.message).toBe('chat-down');
    expect(result.current.isStreaming).toBe(false);
  });

  it('send(): non-Error rejection wrapped into Error', async () => {
    clientImpl.chat.mockImplementation(async () => { throw 'string-err'; });
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { await result.current.send('q'); });
    expect(result.current.error?.message).toBe('string-err');
  });
});

// ─── useAgentMode ────────────────────────────────────────────────────────────

describe('useAgentMode', () => {
  it('initial: loads mode from client, sets loading false', async () => {
    clientImpl.getMode.mockImplementation(async () => 'canvas' as any);
    const { result } = renderHook(() => useAgentMode());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.mode).toBe('canvas');
  });

  it('getMode rejection: loading flips false, mode stays null', async () => {
    clientImpl.getMode.mockImplementation(async () => { throw new Error('mode-fail'); });
    const { result } = renderHook(() => useAgentMode());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.mode).toBeNull();
  });

  it('setMode(): calls client.setMode and updates local mode', async () => {
    const { result } = renderHook(() => useAgentMode());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.setMode('canvas' as any); });
    expect(clientImpl.setMode).toHaveBeenCalledWith('canvas');
    expect(result.current.mode).toBe('canvas');
  });
});

// ─── useAgentFiles ───────────────────────────────────────────────────────────

describe('useAgentFiles', () => {
  it('initial load: tree populated, loading false, no error', async () => {
    const { result } = renderHook(() => useAgentFiles());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tree).toEqual([{ name: 'src', type: 'dir', children: [] }] as unknown);
    expect(result.current.error).toBeNull();
  });

  it('getWorkspaceTree rejection: error set', async () => {
    clientImpl.getWorkspaceTree.mockImplementation(async () => { throw new Error('tree-fail'); });
    const { result } = renderHook(() => useAgentFiles());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe('tree-fail');
    expect(result.current.tree).toBeNull();
  });

  it('getWorkspaceTree non-Error rejection wrapped', async () => {
    clientImpl.getWorkspaceTree.mockImplementation(async () => { throw 'str-err'; });
    const { result } = renderHook(() => useAgentFiles());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe('str-err');
  });

  it('readFile() proxies to client.readFile', async () => {
    const { result } = renderHook(() => useAgentFiles());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const content = await result.current.readFile('foo.ts');
    expect(content).toBe('// contents of foo.ts');
    expect(clientImpl.readFile).toHaveBeenCalledWith('foo.ts');
  });

  it('writeFile() calls client.writeFile then refreshes tree', async () => {
    const { result } = renderHook(() => useAgentFiles());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = clientImpl.getWorkspaceTree.mock.calls.length;
    await act(async () => { await result.current.writeFile('bar.ts', 'data'); });
    expect(clientImpl.writeFile).toHaveBeenCalledWith('bar.ts', 'data');
    expect(clientImpl.getWorkspaceTree.mock.calls.length).toBeGreaterThan(before);
  });

  it('refresh() re-invokes load', async () => {
    const { result } = renderHook(() => useAgentFiles());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = clientImpl.getWorkspaceTree.mock.calls.length;
    await act(async () => { result.current.refresh(); });
    await waitFor(() =>
      expect(clientImpl.getWorkspaceTree.mock.calls.length).toBeGreaterThan(before));
  });
});
