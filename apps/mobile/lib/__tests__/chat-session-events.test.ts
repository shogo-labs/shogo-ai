// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-190: a list that mounts mid-turn has to learn what is already running.
 * The bus remembers the last snapshot per scope and replays it to a new
 * subscriber — but never the one-shot "this turn ended" signal, which is news
 * about a moment, not state.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chatActivityEvents, chatSessionEvents } from "../chat-session-events";

const unsubscribers: Array<() => void> = [];
const touchedScopes: Array<{ workspaceId?: string; projectId?: string }> = [];

type Scope = { workspaceId?: string; projectId?: string };

function subscribe() {
  const events: Array<Record<string, unknown>> = [];
  unsubscribers.push(chatActivityEvents.subscribe((event) => events.push(event)));
  return events;
}

/** Emit with the scope remembered, so cleanup can empty every slot after. */
function emit(scope: Scope, event: Omit<Parameters<typeof chatActivityEvents.emit>[0], "workspaceId" | "projectId">) {
  if (!touchedScopes.some((s) => JSON.stringify(s) === JSON.stringify(scope))) {
    touchedScopes.push(scope);
  }
  chatActivityEvents.emit({ ...scope, ...event });
}

afterEach(() => {
  while (unsubscribers.length > 0) unsubscribers.pop()!();
  // Leave the bus empty for the next file in this process.
  for (const scope of touchedScopes.splice(0)) {
    chatActivityEvents.emit({
      ...scope,
      streamingSessionIds: [],
      completedSessionIds: [],
    });
  }
});

describe("chatActivityEvents replay", () => {
  test("a new subscriber is told about a turn that started before it existed", () => {
    emit(
      { workspaceId: "ws-1" },
      { streamingSessionIds: ["chat-1"], completedSessionIds: [] },
    );

    const fresh = subscribe();

    expect(fresh).toHaveLength(1);
    expect(fresh[0].streamingSessionIds).toEqual(["chat-1"]);
  });

  test("replay is per scope: a workspace subscriber never inherits a project's state", () => {
    emit(
      { projectId: "project-1" },
      { streamingSessionIds: ["chat-p"], completedSessionIds: [] },
    );

    const subscriber = subscribe();

    expect(subscriber).toHaveLength(1);
    expect(subscriber[0].projectId).toBe("project-1");
    // The scope is on the event, so a listener filters it out by identity
    // rather than by guessing from the ids.
    expect(subscriber[0].workspaceId).toBeUndefined();
  });

  test("an empty emit clears the slot so no stale spinner is replayed", () => {
    emit(
      { workspaceId: "ws-2" },
      { streamingSessionIds: ["chat-1"], completedSessionIds: [] },
    );
    emit(
      { workspaceId: "ws-2" },
      { streamingSessionIds: [], completedSessionIds: [] },
    );

    expect(subscribe().filter((event) => event.workspaceId === "ws-2")).toHaveLength(
      0,
    );
  });

  test("the one-shot finish signal is never replayed", () => {
    emit(
      { workspaceId: "ws-3" },
      {
        streamingSessionIds: [],
        completedSessionIds: ["chat-9"],
        finishedSessionIds: ["chat-9"],
      },
    );

    const fresh = subscribe().filter((event) => event.workspaceId === "ws-3");

    expect(fresh).toHaveLength(1);
    expect(fresh[0].finishedSessionIds).toBeUndefined();
    expect(fresh[0].completedSessionIds).toEqual(["chat-9"]);
  });
});

describe("chatSessionEvents touch", () => {
  test("a send carries only the row that moved time", () => {
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = chatSessionEvents.subscribe((event) =>
      events.push(event),
    );

    chatSessionEvents.emit({ touchedSessionId: "chat-1", lastActiveAt: 42 });

    expect(events).toEqual([{ touchedSessionId: "chat-1", lastActiveAt: 42 }]);
    unsubscribe();
  });
});
