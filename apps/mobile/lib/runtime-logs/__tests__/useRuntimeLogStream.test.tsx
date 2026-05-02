// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { MockEventSource } from '../../../test/helpers/mockEventSource'
import {
  __resetRuntimeLogStoreForTest,
  type RuntimeLogEntry,
} from '../runtime-log-store'
import {
  __resetRuntimeLogStreamForTest,
  useRuntimeLogStream,
} from '../useRuntimeLogStream'

const PROJECT = 'proj-X'

function Probe(props: {
  projectId: string
  agentUrl: string | null
  messages?: any[]
  fetcher?: typeof fetch
  eventSourceFactory?: (url: string) => EventSource
  expose: (r: ReturnType<typeof useRuntimeLogStream>) => void
}) {
  const r = useRuntimeLogStream({
    projectId: props.projectId,
    agentUrl: props.agentUrl,
    messages: props.messages,
    fetcher: props.fetcher,
    eventSourceFactory: props.eventSourceFactory,
  })
  props.expose(r)
  return null
}

beforeEach(() => {
  __resetRuntimeLogStoreForTest()
  __resetRuntimeLogStreamForTest()
  MockEventSource.last = null
  MockEventSource.all = []
})

afterEach(() => {
  __resetRuntimeLogStoreForTest()
  __resetRuntimeLogStreamForTest()
})

function makeServerEntry(
  overrides: Partial<RuntimeLogEntry> = {},
): RuntimeLogEntry {
  return {
    seq: overrides.seq ?? 1,
    ts: overrides.ts ?? Date.now(),
    source: overrides.source ?? 'console',
    level: overrides.level ?? 'info',
    text: overrides.text ?? 'line',
    ...(overrides.surfaceId ? { surfaceId: overrides.surfaceId } : {}),
  }
}

describe('useRuntimeLogStream — SSE happy path', () => {
  test('opens an EventSource and pushes incoming entries into the store', async () => {
    let latest: ReturnType<typeof useRuntimeLogStream> | null = null
    const factory = (url: string) => new MockEventSource(url) as unknown as EventSource

    render(
      <Probe
        projectId={PROJECT}
        agentUrl="http://agent.test"
        eventSourceFactory={factory}
        expose={(r) => {
          latest = r
        }}
      />,
    )

    expect(MockEventSource.last).not.toBeNull()
    expect(MockEventSource.last!.url).toContain(
      'http://agent.test/agent/runtime-logs/stream',
    )

    await act(async () => {
      MockEventSource.last!.emit(makeServerEntry({ seq: 1, text: 'hello' }))
      MockEventSource.last!.emit(
        makeServerEntry({ seq: 2, level: 'error', text: 'boom' }),
      )
    })

    expect(latest!.entries.map((e) => e.text)).toEqual(['hello', 'boom'])
    expect(latest!.unseenErrors).toBe(1)
    expect(latest!.transport).toBe('sse')
  })

  test('marks every pushed entry with origin=sse', async () => {
    let latest: ReturnType<typeof useRuntimeLogStream> | null = null
    const factory = (url: string) => new MockEventSource(url) as unknown as EventSource
    render(
      <Probe
        projectId={PROJECT}
        agentUrl="http://agent.test"
        eventSourceFactory={factory}
        expose={(r) => {
          latest = r
        }}
      />,
    )
    await act(async () => {
      MockEventSource.last!.emit(makeServerEntry({ seq: 1 }))
    })
    expect(latest!.entries[0]!.origin).toBe('sse')
  })

  test('drops malformed JSON without throwing', async () => {
    let latest: ReturnType<typeof useRuntimeLogStream> | null = null
    const factory = (url: string) => new MockEventSource(url) as unknown as EventSource
    render(
      <Probe
        projectId={PROJECT}
        agentUrl="http://agent.test"
        eventSourceFactory={factory}
        expose={(r) => {
          latest = r
        }}
      />,
    )
    await act(async () => {
      MockEventSource.last!.emit('not json {{{')
    })
    expect(latest!.entries).toHaveLength(0)
  })

  test('closes the EventSource on unmount', async () => {
    const factory = (url: string) => new MockEventSource(url) as unknown as EventSource
    const { unmount } = render(
      <Probe
        projectId={PROJECT}
        agentUrl="http://agent.test"
        eventSourceFactory={factory}
        expose={() => {}}
      />,
    )
    const es = MockEventSource.last!
    expect(es.closed).toBe(false)
    unmount()
    expect(es.closed).toBe(true)
  })
})

describe('useRuntimeLogStream — polling fallback', () => {
  test('falls back to GET /agent/runtime-logs on EventSource error', async () => {
    let latest: ReturnType<typeof useRuntimeLogStream> | null = null
    const factory = (url: string) => new MockEventSource(url) as unknown as EventSource

    let pollResolved = false
    const fetcher = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString()
      expect(url).toContain('/agent/runtime-logs')
      pollResolved = true
      return new Response(
        JSON.stringify({
          entries: [makeServerEntry({ seq: 5, text: 'from-poll' })],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    render(
      <Probe
        projectId={PROJECT}
        agentUrl="http://agent.test"
        eventSourceFactory={factory}
        fetcher={fetcher}
        expose={(r) => {
          latest = r
        }}
      />,
    )

    await act(async () => {
      MockEventSource.last!.fail()
    })
    // Give the poll tick a moment to resolve.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(pollResolved).toBe(true)
    expect(latest!.entries.map((e) => e.text)).toEqual(['from-poll'])
    expect(latest!.entries[0]!.origin).toBe('poll')
    expect(latest!.transport).toBe('poll')
  })
})

describe('useRuntimeLogStream — exec entry merge', () => {
  function makeChatExecMessage(
    id: string,
    command: string,
    state: 'result' | 'output-available' | 'pending' = 'result',
    overrides: { exitCode?: number; stdout?: string; stderr?: string } = {},
  ) {
    return {
      role: 'assistant',
      createdAt: new Date(2025, 0, 1).toISOString(),
      parts: [
        {
          type: 'tool-invocation',
          toolInvocation: {
            toolName: 'exec',
            toolCallId: id,
            state,
            args: { command },
            result: state === 'pending' ? undefined : {
              stdout: overrides.stdout ?? 'output',
              stderr: overrides.stderr ?? '',
              exitCode: overrides.exitCode ?? 0,
            },
          },
        },
      ],
    }
  }

  test('chat exec calls land in the buffer with origin=exec', async () => {
    let latest: ReturnType<typeof useRuntimeLogStream> | null = null
    const factory = (url: string) => new MockEventSource(url) as unknown as EventSource

    render(
      <Probe
        projectId={PROJECT}
        agentUrl="http://agent.test"
        eventSourceFactory={factory}
        messages={[makeChatExecMessage('exec-1', 'ls')]}
        expose={(r) => {
          latest = r
        }}
      />,
    )

    expect(latest!.entries).toHaveLength(1)
    expect(latest!.entries[0]!.source).toBe('exec')
    expect(latest!.entries[0]!.origin).toBe('exec')
    expect(latest!.entries[0]!.text).toContain('$ ls')
  })

  test('non-zero exit code marks the entry level=error', async () => {
    let latest: ReturnType<typeof useRuntimeLogStream> | null = null
    const factory = (url: string) => new MockEventSource(url) as unknown as EventSource

    render(
      <Probe
        projectId={PROJECT}
        agentUrl="http://agent.test"
        eventSourceFactory={factory}
        messages={[
          makeChatExecMessage('exec-fail', 'bun build', 'result', {
            exitCode: 1,
            stderr: 'tsc: type error',
          }),
        ]}
        expose={(r) => {
          latest = r
        }}
      />,
    )

    expect(latest!.entries[0]!.level).toBe('error')
    expect(latest!.unseenErrors).toBe(1)
  })

  test('the same exec id is not pushed twice across re-renders', async () => {
    let latest: ReturnType<typeof useRuntimeLogStream> | null = null
    const factory = (url: string) => new MockEventSource(url) as unknown as EventSource

    const messagesA = [makeChatExecMessage('exec-1', 'ls')]
    const messagesB = [
      makeChatExecMessage('exec-1', 'ls'),
      makeChatExecMessage('exec-2', 'pwd'),
    ]

    const { rerender } = render(
      <Probe
        projectId={PROJECT}
        agentUrl="http://agent.test"
        eventSourceFactory={factory}
        messages={messagesA}
        expose={(r) => {
          latest = r
        }}
      />,
    )
    expect(latest!.entries).toHaveLength(1)

    rerender(
      <Probe
        projectId={PROJECT}
        agentUrl="http://agent.test"
        eventSourceFactory={factory}
        messages={messagesB}
        expose={(r) => {
          latest = r
        }}
      />,
    )
    expect(latest!.entries).toHaveLength(2)
    expect(latest!.entries.map((e) => e.text)).toEqual([
      '$ ls\noutput',
      '$ pwd\noutput',
    ])
  })

  test('still-pending exec calls (exitCode=-1) are skipped', async () => {
    let latest: ReturnType<typeof useRuntimeLogStream> | null = null
    const factory = (url: string) => new MockEventSource(url) as unknown as EventSource

    render(
      <Probe
        projectId={PROJECT}
        agentUrl="http://agent.test"
        eventSourceFactory={factory}
        messages={[makeChatExecMessage('pending', 'sleep 5', 'pending')]}
        expose={(r) => {
          latest = r
        }}
      />,
    )
    expect(latest!.entries).toHaveLength(0)
  })
})

describe('useRuntimeLogStream — guard rails', () => {
  test('agentUrl=null does not open EventSource', () => {
    render(
      <Probe
        projectId={PROJECT}
        agentUrl={null}
        eventSourceFactory={(u) => new MockEventSource(u) as unknown as EventSource}
        expose={() => {}}
      />,
    )
    expect(MockEventSource.last).toBeNull()
  })

  test('agentUrl change closes the old stream and opens a new one', () => {
    const factory = (url: string) => new MockEventSource(url) as unknown as EventSource
    const { rerender } = render(
      <Probe
        projectId={PROJECT}
        agentUrl="http://a.test"
        eventSourceFactory={factory}
        expose={() => {}}
      />,
    )
    const first = MockEventSource.last!
    rerender(
      <Probe
        projectId={PROJECT}
        agentUrl="http://b.test"
        eventSourceFactory={factory}
        expose={() => {}}
      />,
    )
    expect(first.closed).toBe(true)
    expect(MockEventSource.all).toHaveLength(2)
    expect(MockEventSource.all[1]!.url).toContain('http://b.test')
  })
})
