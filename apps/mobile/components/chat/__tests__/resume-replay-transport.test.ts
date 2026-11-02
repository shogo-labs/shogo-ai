// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test"
import type { UIMessage } from "ai"
import {
  applyMessageSnapshot,
  dropUnfinishedAssistantTail,
  foldSnapshotContinuation,
  isUnfinishedAssistant,
  messageTurnKey,
  replayTurnMessage,
  turnStartOf,
  withResumeReplayReset,
  withSnapshotId,
} from "../resume-replay-transport"

function message(role: UIMessage["role"], parts: unknown[] = []): UIMessage {
  return { id: `${role}-${parts.length}`, role, parts } as UIMessage
}

describe("isUnfinishedAssistant", () => {
  test("a streaming assistant message is unfinished", () => {
    expect(
      isUnfinishedAssistant(
        message("assistant", [{ type: "reasoning", text: "hm" }]),
      ),
    ).toBe(true)
  })

  test("a live data-turn-complete frame marks it finished", () => {
    expect(
      isUnfinishedAssistant(
        message("assistant", [
          { type: "text", text: "done" },
          { type: "data-turn-complete", data: { status: "completed" } },
        ]),
      ),
    ).toBe(false)
  })

  test("persisted timing marks it finished only once completedAt is set", () => {
    const partial = message("assistant", [
      { type: "data-turn-timing", data: { startedAt: 1 } },
    ])
    const done = message("assistant", [
      { type: "data-turn-timing", data: { startedAt: 1, completedAt: 2 } },
    ])
    expect(isUnfinishedAssistant(partial)).toBe(true)
    expect(isUnfinishedAssistant(done)).toBe(false)
  })

  test("a reply the user stopped is finished, not unfinished", () => {
    expect(
      isUnfinishedAssistant(
        message("assistant", [
          { type: "text", text: "half a sen" },
          { type: "data-turn-stopped", data: { turnId: "turn-1" } },
        ]),
      ),
    ).toBe(false)
  })

  test("user messages and an empty list are never dropped", () => {
    expect(isUnfinishedAssistant(message("user"))).toBe(false)
    expect(isUnfinishedAssistant(undefined)).toBe(false)
  })
})

describe("dropUnfinishedAssistantTail", () => {
  test("drops only the trailing unfinished assistant message", () => {
    const history = [message("user"), message("assistant")]
    expect(dropUnfinishedAssistantTail(history)).toEqual([history[0]])
  })

  test("keeps a reply the user stopped", () => {
    const history = [
      message("user"),
      message("assistant", [{ type: "data-turn-stopped", data: { turnId: "t1" } }]),
    ]
    expect(dropUnfinishedAssistantTail(history)).toBe(history)
  })

  test("returns the same array when there is nothing to drop", () => {
    const history = [
      message("user"),
      message("assistant", [{ type: "data-turn-complete", data: {} }]),
    ]
    expect(dropUnfinishedAssistantTail(history)).toBe(history)
  })
})

// A crash leaves the row the person was already reading on screen. The replay
// that follows only rebuilds the turn it belongs to, so dropping the stored row
// deleted text they had read and the next cache write stored the array without
// it (SHO-274).
describe("a stored partial reply survives a replay of another turn", () => {
  const storedPartial = (turnId: string) =>
    ({
      id: "msg_stored",
      role: "assistant",
      parts: [
        { type: "text", text: "Reading the migration files" },
        { type: "data-turn-timing", data: { startedAt: 1, turnId } },
      ],
    }) as unknown as UIMessage

  const replayOf = (turnId: string) =>
    ({
      id: "msg_replay",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "data-turn-start", data: { turnId } },
      ],
    }) as unknown as UIMessage

  test("it is kept when the replay belongs to a different turn", () => {
    const history = [message("user"), storedPartial("turn-1")]
    expect(dropUnfinishedAssistantTail(history, replayOf("turn-2"))).toBe(history)
  })

  test("it is kept when either side has no turn to compare", () => {
    const history = [message("user"), storedPartial("turn-1")]
    expect(dropUnfinishedAssistantTail(history, null)).toBe(history)
    const noKey = [message("user"), message("assistant", [{ type: "text", text: "half" }, { type: "data-turn-timing", data: { startedAt: 1 } }])] as UIMessage[]
    expect(dropUnfinishedAssistantTail(noKey, replayOf("turn-2"))).toBe(noKey)
  })

  test("it is dropped only when the replay rebuilds that same turn", () => {
    const history = [message("user"), storedPartial("turn-1")]
    expect(dropUnfinishedAssistantTail(history, replayOf("turn-1"))).toEqual([history[0]])
  })

  test("a bubble this window streamed has no stored row, so it still goes", () => {
    const history = [message("user"), message("assistant", [{ type: "reasoning", text: "hm" }])]
    expect(dropUnfinishedAssistantTail(history, replayOf("turn-2"))).toEqual([history[0]])
  })

  test("a row the server declared dead is finished history, not a partial", () => {
    expect(
      isUnfinishedAssistant(
        message("assistant", [
          { type: "text", text: "Reading the migration files" },
          { type: "data-turn-timing", data: { startedAt: 1 } },
          { type: "data-turn-interrupted", data: { reason: "interrupted_exec" } },
        ]),
      ),
    ).toBe(false)
  })
})

describe("foldSnapshotContinuation", () => {
  const user = { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] } as UIMessage
  const snapshot = {
    id: "msg_live",
    role: "assistant",
    parts: [
      { type: "step-start" },
      { type: "text", text: "step one done", state: "done" },
    ],
  } as UIMessage
  // What the SDK appends for the rest of the stream: a new id, only the
  // unfinished step.
  const continuation = {
    id: "sdk-generated",
    role: "assistant",
    parts: [{ type: "step-start" }, { type: "text", text: "writing step two", state: "streaming" }],
  } as UIMessage

  test("shows the snapshot and the SDK's continuation as one message", () => {
    const installed = applyMessageSnapshot([user], snapshot)
    const folded = foldSnapshotContinuation([...installed, continuation], snapshot.id)
    expect(folded).toHaveLength(2)
    expect(folded[0]).toBe(user)
    expect(folded[1].id).toBe("msg_live")
    expect(folded[1].parts).toEqual([...snapshot.parts, ...continuation.parts])
  })

  test("shows the snapshot alone before the continuation arrives", () => {
    const installed = applyMessageSnapshot([user], snapshot)
    expect(foldSnapshotContinuation(installed, snapshot.id)).toBe(installed)
  })

  test("folds a continuation that opens a sub-agent tool part into the snapshot", () => {
    // A runtime mid-turn snapshot ends where the last part closed, so the
    // continuation starts with the part that is still open — here a running
    // `agent_spawn`, not a `start-step`.
    const spawnSnapshot = {
      id: "msg_live",
      role: "assistant",
      parts: [{ type: "step-start" }, { type: "text", text: "spawning qa", state: "done" }],
    } as UIMessage
    const spawnContinuation = {
      id: "sdk-generated",
      role: "assistant",
      parts: [
        {
          type: "tool-agent_spawn",
          toolCallId: "spawn",
          state: "output-available",
          input: { type: "browser_qa" },
          output: { parts: [{ type: "text", text: "clicking", id: "sa-text-0" }] },
          preliminary: true,
        },
      ],
    } as UIMessage

    const installed = applyMessageSnapshot([user], spawnSnapshot)
    const folded = foldSnapshotContinuation([...installed, spawnContinuation], spawnSnapshot.id)
    expect(folded).toHaveLength(2)
    expect(folded[1].id).toBe("msg_live")
    expect(folded[1].parts).toEqual([...spawnSnapshot.parts, ...spawnContinuation.parts])
  })

  test("leaves messages alone once the snapshot is gone or a new turn starts", () => {
    const history = [user, { ...continuation, id: "persisted" } as UIMessage]
    expect(foldSnapshotContinuation(history, snapshot.id)).toBe(history)
    const nextTurn = [user, snapshot, { ...user, id: "u2" } as UIMessage]
    expect(foldSnapshotContinuation(nextTurn, snapshot.id)).toBe(nextTurn)
    expect(foldSnapshotContinuation([user, snapshot, continuation], null)).toEqual([
      user,
      snapshot,
      continuation,
    ])
  })
})

function chunkStream(chunks: unknown[]): ReadableStream<any> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

async function readAll(stream: ReadableStream<any> | null): Promise<unknown[]> {
  const out: unknown[] = []
  if (!stream) return out
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) return out
    out.push(value)
  }
}

describe("withResumeReplayReset", () => {
  const request = { chatId: "c1" }
  const chunks = [{ type: "start" }, { type: "text-start", id: "t" }]

  test("runs beforeReplay only when a replay stream comes back", async () => {
    let resets = 0
    const withStream = withResumeReplayReset(
      {
        sendMessages: async () => chunkStream(chunks),
        reconnectToStream: async () => chunkStream(chunks),
      },
      () => resets++,
    )
    const without = withResumeReplayReset(
      {
        sendMessages: async () => chunkStream(chunks),
        reconnectToStream: async () => null,
      },
      () => resets++,
    )

    expect(await readAll(await withStream.reconnectToStream(request))).toEqual(chunks)
    expect(resets).toBe(1)
    expect(await without.reconnectToStream(request)).toBeNull()
    expect(resets).toBe(1)
  })

  test("sendMessages passes straight through without a reset", async () => {
    let resets = 0
    const transport = withResumeReplayReset(
      {
        sendMessages: async () => chunkStream(chunks),
        reconnectToStream: async () => null,
      },
      () => resets++,
    )

    const result = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "c1",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    })
    expect(await readAll(result)).toEqual(chunks)
    expect(resets).toBe(0)
  })

  test("keeps the transcript when the replay has nothing left to rebuild", async () => {
    let resets = 0
    const heartbeat = [
      { type: "data-turn-seq", data: { turnId: "turn-1", seq: 91 }, transient: true },
    ]
    const heartbeatOnly = withResumeReplayReset(
      {
        sendMessages: async () => chunkStream(chunks),
        reconnectToStream: async () => chunkStream(heartbeat),
      },
      () => resets++,
      () => {},
    )
    const empty = withResumeReplayReset(
      {
        sendMessages: async () => chunkStream(chunks),
        reconnectToStream: async () => chunkStream([]),
      },
      () => resets++,
      () => {},
    )

    expect(await readAll(await heartbeatOnly.reconnectToStream(request))).toEqual(heartbeat)
    expect(resets, "a heartbeat-only replay drops nothing, so it must not reset").toBe(0)

    expect(await readAll(await empty.reconnectToStream(request))).toEqual([])
    expect(resets, "an empty replay drops nothing, so it must not reset").toBe(0)
  })

  test("resets once the replay really starts rebuilding the message", async () => {
    let resets = 0
    const transport = withResumeReplayReset(
      {
        sendMessages: async () => chunkStream(chunks),
        reconnectToStream: async () => chunkStream(chunks),
      },
      () => resets++,
      () => {},
    )

    expect(await readAll(await transport.reconnectToStream(request))).toEqual(chunks)
    expect(resets).toBe(1)
  })
})

describe("withResumeReplayReset message snapshot", () => {
  const request = { chatId: "c1" }
  const snapshotMessage = { id: "m1", role: "assistant", parts: [{ type: "text", text: "so far" }] } as UIMessage
  const snapshotChunk = { type: "data-message-snapshot", data: { message: snapshotMessage }, transient: true }
  const rest = [{ type: "start-step" }, { type: "text-start", id: "0" }]

  function wrap(streamChunks: unknown[], calls: string[]) {
    return withResumeReplayReset(
      {
        sendMessages: async () => chunkStream([]),
        reconnectToStream: async () => chunkStream(streamChunks),
      },
      () => calls.push("reset"),
      (m) => calls.push(`snapshot:${m.id}`),
    )
  }

  test("applies the snapshot, strips its chunk and skips the replay reset", async () => {
    const calls: string[] = []
    const out = await readAll(await wrap([snapshotChunk, ...rest], calls).reconnectToStream(request))
    expect(out).toEqual(rest)
    expect(calls).toEqual(["snapshot:m1"])
  })

  test("names an id-less snapshot after its turn, so the continuation folds into it", async () => {
    // Runtimes before the 2.4.1 fix send the snapshot with `id: ""`.
    const calls: string[] = []
    const idless = {
      ...snapshotChunk,
      data: {
        message: {
          id: "",
          role: "assistant",
          parts: [{ type: "data-turn-start", data: { turnId: "t9" } }, { type: "text", text: "so far" }],
        },
      },
    }
    await readAll(await wrap([idless, ...rest], calls).reconnectToStream(request))
    expect(calls).toEqual(["snapshot:turn-t9"])

    const snapshot = withSnapshotId(idless.data.message as UIMessage)!
    const continuation = { id: "sdk-generated", role: "assistant", parts: [{ type: "text", text: "latest action" }] } as UIMessage
    const shown = foldSnapshotContinuation([message("user"), snapshot, continuation], snapshot.id)
    expect(shown).toHaveLength(2)
    expect(shown[1]!.parts.map((p: any) => p.text).filter(Boolean)).toEqual(["so far", "latest action"])
  })

  test("an id-less snapshot without a turn start still gets a non-empty id", () => {
    const named = withSnapshotId({ id: "", role: "assistant", parts: [] } as UIMessage)!
    expect(named.id).toMatch(/^turn-snapshot-/)
    expect(withSnapshotId(snapshotMessage)).toBe(snapshotMessage)
  })

  test("falls back to the reset for a runtime that replays the stream", async () => {
    const calls: string[] = []
    const replay = [{ type: "start" }, ...rest]
    expect(await readAll(await wrap(replay, calls).reconnectToStream(request))).toEqual(replay)
    expect(calls).toEqual(["reset"])
  })

  test("a snapshot is not applied for a 204", async () => {
    const calls: string[] = []
    const transport = withResumeReplayReset(
      { sendMessages: async () => chunkStream([]), reconnectToStream: async () => null },
      () => calls.push("reset"),
      () => calls.push("snapshot"),
    )
    expect(await transport.reconnectToStream(request)).toBeNull()
    expect(calls).toEqual([])
  })

  test("a silent stream is treated as a replay once the peek times out, keeping later chunks", async () => {
    const calls: string[] = []
    let push!: (chunk: unknown) => void
    let close!: () => void
    const live = new ReadableStream<any>({
      start(controller) {
        push = (chunk) => controller.enqueue(chunk)
        close = () => controller.close()
      },
    })
    const transport = withResumeReplayReset(
      { sendMessages: async () => chunkStream([]), reconnectToStream: async () => live },
      () => calls.push("reset"),
      () => calls.push("snapshot"),
    )
    const stream = (await transport.reconnectToStream(request))!
    expect(calls).toEqual(["reset"])
    push({ type: "late" })
    close()
    expect(await readAll(stream)).toEqual([{ type: "late" }])
  })

  test("without onSnapshot the snapshot chunk is left alone and the reset runs", async () => {
    const calls: string[] = []
    const transport = withResumeReplayReset(
      { sendMessages: async () => chunkStream([]), reconnectToStream: async () => chunkStream([snapshotChunk]) },
      () => calls.push("reset"),
    )
    expect(await readAll(await transport.reconnectToStream(request))).toEqual([snapshotChunk])
    expect(calls).toEqual(["reset"])
  })
})

// Coming back to a chat mid-turn loads the part of the reply saved so far, then
// replays the turn from seq 0. The replay has to say which turn it rebuilds, or
// the saved partial is kept and the full replay is appended after it — the
// reply shows twice, and a reload repeats it (SHO-278).
describe("withResumeReplayReset tells the drop which turn the replay rebuilds", () => {
  const request = { chatId: "c1" }
  const TURN = "turn-278"

  const persistedPartial = {
    id: "msg_persisted",
    role: "assistant",
    parts: [
      { type: "text", text: "Reading the migration files" },
      { type: "data-turn-timing", data: { startedAt: 1, turnId: TURN } },
    ],
  } as unknown as UIMessage

  const replayOf = (turnId: string) => [
    { type: "start" },
    { type: "data-turn-start", data: { turnId, chatSessionId: "s1", startedAt: 1 } },
    { type: "start-step" },
    { type: "text-start", id: "0" },
    { type: "text-delta", id: "0", delta: "Reading the migration files" },
  ]

  function transportOf(chunks: unknown[], onReplay: (start?: any) => void) {
    return withResumeReplayReset(
      {
        sendMessages: async () => chunkStream([]),
        reconnectToStream: async () => chunkStream(chunks),
      },
      onReplay,
      () => {},
    )
  }

  test("the replay's own turn replaces the persisted partial, leaving one reply", async () => {
    const starts: any[] = []
    const transport = transportOf(replayOf(TURN), (start) => starts.push(start))

    const out = await readAll(await transport.reconnectToStream(request))

    expect(starts).toEqual([{ turnId: TURN, startedAt: 1 }])
    expect(out).toEqual(replayOf(TURN))

    // What the caller drops with: the replay's turn, nothing else.
    const replayMessage = {
      id: "replay",
      role: "assistant",
      parts: [{ type: "data-turn-start", data: starts[0] }],
    } as unknown as UIMessage
    const history = [message("user"), persistedPartial]
    const afterDrop = dropUnfinishedAssistantTail(history, replayMessage)
    expect(afterDrop).toEqual([history[0]])
    expect(messageTurnKey(persistedPartial)).toBe(`turn:${TURN}`)
  })

  test("replayTurnMessage carries the turn the drop compares against", () => {
    const start = { turnId: TURN, startedAt: 1 }
    expect(messageTurnKey(replayTurnMessage(start))).toBe(`turn:${TURN}`)
    expect(messageTurnKey(replayTurnMessage({ startedAt: 7 }))).toBe("at:7")
  })

  test("a replay of another turn keeps the persisted partial (SHO-274 C1)", async () => {
    const starts: any[] = []
    const transport = transportOf(replayOf("turn-other"), (start) => starts.push(start))

    await readAll(await transport.reconnectToStream(request))

    expect(starts).toEqual([{ turnId: "turn-other", startedAt: 1 }])
    const history = [message("user"), persistedPartial]
    expect(dropUnfinishedAssistantTail(history, replayTurnMessage(starts[0]))).toBe(history)
  })

  test("the look-ahead loses no chunk and keeps the order", async () => {
    const chunks = replayOf(TURN)
    const transport = transportOf(chunks, () => {})
    expect(await readAll(await transport.reconnectToStream(request))).toEqual(chunks)
  })

  test("a replay with no data-turn-start behaves as before: no turn, partial kept", async () => {
    const starts: any[] = []
    const chunks = [{ type: "start" }, { type: "text-start", id: "0" }]
    const transport = transportOf(chunks, (start) => starts.push(start))

    expect(await readAll(await transport.reconnectToStream(request))).toEqual(chunks)
    expect(starts).toEqual([undefined])

    const history = [message("user"), persistedPartial]
    expect(dropUnfinishedAssistantTail(history, null)).toBe(history)
  })

  test("a turn start that is the first chunk is read without a look-ahead", async () => {
    const starts: any[] = []
    const chunks = [{ type: "data-turn-start", data: { turnId: TURN } }, { type: "start-step" }]
    const transport = transportOf(chunks, (start) => starts.push(start))

    expect(await readAll(await transport.reconnectToStream(request))).toEqual(chunks)
    expect(starts).toEqual([{ turnId: TURN }])
  })

  test("turnStartOf reads the runtime's frame and ignores everything else", () => {
    expect(turnStartOf({ type: "data-turn-start", data: { turnId: "t", startedAt: 5 } })).toEqual({
      turnId: "t",
      startedAt: 5,
    })
    expect(turnStartOf({ type: "data-turn-start", data: { startedAt: 5 } })).toEqual({ startedAt: 5 })
    expect(turnStartOf({ type: "data-turn-start", data: {} })).toBeUndefined()
    expect(turnStartOf({ type: "data-turn-seq", data: { turnId: "t" } })).toBeUndefined()
    expect(turnStartOf(undefined)).toBeUndefined()
  })
})
