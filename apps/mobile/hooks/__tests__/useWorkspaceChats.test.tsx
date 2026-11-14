// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-190: what a workspace chat row says about a turn.
 *
 * The list used to learn "running" only from the screen that was on screen, so
 * a chat you navigated away from (or one a schedule started) never spun. The
 * hook now takes the server's answer as the base, paints a local start at once,
 * stops a local finish at once, and derives the unread dot itself.
 */
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createReactNativeMock } from "../../test/react-native-mock";

const CHATS = () => [
  {
    id: "chat-1",
    workspaceId: "w1",
    name: "Birthday party",
    createdAt: "2026-10-01T09:00:00.000Z",
    lastActiveAt: "2026-10-01T10:00:00.000Z",
    isPinned: false,
    isArchived: false,
  },
  {
    id: "chat-2",
    workspaceId: "w1",
    name: "Trip ideas",
    createdAt: "2026-10-02T09:00:00.000Z",
    lastActiveAt: "2026-10-02T10:00:00.000Z",
    isPinned: false,
    isArchived: false,
  },
];

const stableHttp = { name: "http" };
const stableActions = { updateChatSession: async () => {}, deleteChatSession: async () => {} };
const stableChatSessions = { get: () => undefined, loadById: async () => {} };

let sessionsResult: () => any[] = () => CHATS();
let activeChatsResult: () => Promise<unknown[]> = async () => [];
const listWorkspaceSessions = mock(async () => sessionsResult());
const listWorkspaceActiveChats = mock(async () => (await activeChatsResult()) as any[])
const createWorkspaceSession = mock(async () => ({ id: "chat-new", workspaceId: "w1" }))

const appStateListeners = new Set<(state: string) => void>();
const AppState = {
  currentState: "active",
  addEventListener: (_event: string, handler: (state: string) => void) => {
    appStateListeners.add(handler);
    return { remove: () => appStateListeners.delete(handler) };
  },
};

// The device cache (SHO-391) keeps AsyncStorage rows; a Map stands in for it.
const deviceStore = new Map<string, string>();

mock.module("react-native", () =>
  createReactNativeMock({ AppState } as any),
);
mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => deviceStore.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      deviceStore.set(k, v);
    },
    removeItem: async (k: string) => {
      deviceStore.delete(k);
    },
    getAllKeys: async () => [...deviceStore.keys()],
    multiRemove: async (keys: string[]) => {
      keys.forEach((k) => deviceStore.delete(k));
    },
  },
}));
// The list is cached per user + server + workspace: this is who we are.
mock.module(resolve(import.meta.dir, "../../contexts/auth"), () => ({
  useAuth: () => ({ user: { id: "u1" } }),
}));
mock.module(resolve(import.meta.dir, "../../contexts/active-instance"), () => ({
  useActiveInstance: () => ({ instance: null }),
}));
mock.module(resolve(import.meta.dir, "../../lib/api"), () => ({
  api: { listWorkspaceSessions, listWorkspaceActiveChats, createWorkspaceSession },
}));
mock.module(resolve(import.meta.dir, "../../contexts/domain"), () => ({
  useDomainHttp: () => stableHttp,
  useDomainActions: () => stableActions,
  useChatSessionCollection: () => stableChatSessions,
}));

const { useWorkspaceChats } = await import("../useWorkspaceChats");
const { chatActivityEvents, chatSessionEvents } = await import(
  "../../lib/chat-session-events"
);
const { workspaceActivity } = await import("../../lib/workspace-activity");
const workspaceChatsCache = await import("../../lib/workspace-chats-cache");

function turn(id: string, startedAt = "2026-10-03T10:00:00.000Z") {
  return {
    chatSessionId: id,
    turnId: `turn-${id}`,
    sessionName: id,
    isPrimary: false,
    projectId: null,
    projectName: null,
    projectHidden: false,
    startedAt,
  };
}

/**
 * Let the poll's promise land and React re-render. Bun's fake timers move the
 * timer queue, not `Date.now`, so each flush also starts a fresh shared
 * activity window (SHO-277) — the same thing 5 s of real time would do.
 */
async function flush() {
  workspaceActivity.reset()
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Mount the hook and do the list load the panels do on focus. */
async function mount() {
  const rendered = renderHook(() => useWorkspaceChats("w1"));
  await act(async () => {
    await rendered.result.current.refresh();
  });
  await flush();
  return rendered;
}

function advance(ms: number) {
  let left = ms;
  while (left > 0) {
    const step = Math.min(100, left);
    act(() => {
      jest.advanceTimersByTime(step);
    });
    left -= step;
  }
}

let emittedScopes: Array<Record<string, unknown>> = [];

function emitActivity(event: {
  streamingSessionIds: string[];
  completedSessionIds: string[];
  finishedSessionIds?: string[];
}) {
  emittedScopes.push({ workspaceId: "w1", ...event });
  chatActivityEvents.emit({ workspaceId: "w1", ...event });
}

beforeEach(async () => {
  cleanup();
  // One shared activity cache per window (SHO-277).
  workspaceActivity.reset();
  await workspaceChatsCache.clearWorkspaceChatsCache();
  deviceStore.clear();
  appStateListeners.clear();
  AppState.currentState = "active";
  sessionsResult = () => CHATS();
  activeChatsResult = async () => [];
  listWorkspaceSessions.mockClear();
  // A previous case may have pointed this at a throwing server.
  listWorkspaceSessions.mockImplementation(async () => sessionsResult());
  createWorkspaceSession.mockClear();
  listWorkspaceActiveChats.mockClear();
  emittedScopes = [];
});

afterEach(() => {
  jest.useRealTimers();
  cleanup();
  // Empty the replay slots this file filled, so the next file starts clean.
  for (const scope of emittedScopes) {
    chatActivityEvents.emit({
      workspaceId: scope.workspaceId as string,
      streamingSessionIds: [],
      completedSessionIds: [],
    });
  }
});

describe("useWorkspaceChats running state", () => {
  test("a turn the server reports running spins, with no local event at all", async () => {
    activeChatsResult = async () => [turn("chat-2")];

    const { result } = await mount();

    expect([...result.current.streamingIds]).toEqual(["chat-2"]);
    expect(listWorkspaceSessions).toHaveBeenCalledWith(stableHttp, "w1");
  });

  test("chat ids that are not in this list (a project chat) never spin a row", async () => {
    activeChatsResult = async () => [turn("project-chat-1")];

    const { result } = await mount();

    expect(result.current.streamingIds.size).toBe(0);
  });

  test("a finished turn stops the spinner at once and flags an unread dot", async () => {
    const { result } = await mount();

    act(() => emitActivity({ streamingSessionIds: ["chat-2"], completedSessionIds: [] }));
    expect(result.current.streamingIds.has("chat-2")).toBe(true);

    act(() =>
      emitActivity({
        streamingSessionIds: [],
        completedSessionIds: ["chat-2"],
        finishedSessionIds: ["chat-2"],
      }),
    );
    expect(result.current.streamingIds.has("chat-2")).toBe(false);
    expect(result.current.completedIds.has("chat-2")).toBe(true);
  });

  test("the chat on screen is read, so its turn ending flags nothing", async () => {
    const { result } = await mount();

    act(() => {
      result.current.markSeen("chat-2");
      emitActivity({ streamingSessionIds: ["chat-2"], completedSessionIds: [] });
    });
    act(() =>
      emitActivity({
        streamingSessionIds: [],
        completedSessionIds: [],
        finishedSessionIds: ["chat-2"],
      }),
    );

    expect(result.current.completedIds.has("chat-2")).toBe(false);
    expect(result.current.streamingIds.has("chat-2")).toBe(false);
  });

  test("markSeen clears the dot, and markSeen(null) keeps it for the next chat", async () => {
    const { result } = await mount();

    act(() => {
      result.current.markSeen(null);
      emitActivity({ streamingSessionIds: ["chat-2"], completedSessionIds: [] });
    });
    act(() =>
      emitActivity({
        streamingSessionIds: [],
        completedSessionIds: [],
        finishedSessionIds: ["chat-2"],
      }),
    );
    expect(result.current.completedIds.has("chat-2")).toBe(true);

    act(() => result.current.markSeen("chat-2"));
    expect(result.current.completedIds.has("chat-2")).toBe(false);
  });

  test("a blank emit (the screen switching chats) does not stop a running row", async () => {
    const { result } = await mount();

    act(() => emitActivity({ streamingSessionIds: ["chat-2"], completedSessionIds: [] }));
    act(() => emitActivity({ streamingSessionIds: [], completedSessionIds: [] }));

    expect(result.current.streamingIds.has("chat-2")).toBe(true);
  });

  test("a newer turn the server reports on the same chat spins again", async () => {
    const { result } = await mount();

    act(() => emitActivity({ streamingSessionIds: ["chat-2"], completedSessionIds: [] }));
    act(() =>
      emitActivity({
        streamingSessionIds: [],
        completedSessionIds: [],
        finishedSessionIds: ["chat-2"],
      }),
    );
    expect(result.current.streamingIds.has("chat-2")).toBe(false);

    // Something else (a schedule, another window) started a new turn on it.
    activeChatsResult = async () => [turn("chat-2", "2099-01-01T00:00:00.000Z")];
    act(() => appStateListeners.forEach((fn) => fn("background")));
    act(() => appStateListeners.forEach((fn) => fn("active")));
    await flush();

    expect(result.current.streamingIds.has("chat-2")).toBe(true);
  });

  test("a turn that ends while you are on another screen gets the dot from the poll", async () => {
    activeChatsResult = async () => [turn("chat-2")];
    const { result } = await mount();
    expect(result.current.streamingIds.has("chat-2")).toBe(true);

    // The user is reading chat-1 while chat-2 finishes elsewhere.
    act(() => result.current.markSeen("chat-1"));
    activeChatsResult = async () => [];
    act(() => appStateListeners.forEach((fn) => fn("background")));
    act(() => appStateListeners.forEach((fn) => fn("active")));
    await flush();

    expect(result.current.streamingIds.has("chat-2")).toBe(false);
    expect(result.current.completedIds.has("chat-2")).toBe(true);
  });

  test("the chat on screen ending in a poll flags nothing", async () => {
    activeChatsResult = async () => [turn("chat-2")];
    const { result } = await mount();

    act(() => result.current.markSeen("chat-2"));
    activeChatsResult = async () => [];
    act(() => appStateListeners.forEach((fn) => fn("background")));
    act(() => appStateListeners.forEach((fn) => fn("active")));
    await flush();

    expect(result.current.streamingIds.has("chat-2")).toBe(false);
    expect(result.current.completedIds.has("chat-2")).toBe(false);
  });

  test("a quick reply that ends before any poll sees it running still gets the dot", async () => {
    jest.useFakeTimers();
    const { result } = await mount();

    // A send in chat-1, then the user leaves for chat-2 straight away.
    act(() => emitActivity({ streamingSessionIds: ["chat-1"], completedSessionIds: [] }));
    act(() => result.current.markSeen("chat-2"));
    act(() => emitActivity({ streamingSessionIds: [], completedSessionIds: [] }));
    expect(result.current.streamingIds.has("chat-1")).toBe(true);
    const afterSend = listWorkspaceActiveChats.mock.calls.length;

    // It is over 3s later. No finished event arrives (that chat's screen is not
    // on screen), and the server never reports the turn. The local start alone
    // keeps the fast cadence, so a poll comes at 5s rather than 15s.
    advance(5_000);
    await flush();
    expect(listWorkspaceActiveChats.mock.calls.length).toBe(afterSend + 1);
    expect(result.current.completedIds.has("chat-1")).toBe(false);

    // Past the grace window the missing turn reads as an ending: spinner off,
    // dot on — the quick reply that finished while you were elsewhere.
    advance(5_000);
    await flush();

    expect(result.current.streamingIds.has("chat-1")).toBe(false);
    expect(result.current.completedIds.has("chat-1")).toBe(true);
  });

  test("a failed poll keeps the last known set instead of flashing the spinner off", async () => {
    activeChatsResult = async () => [turn("chat-2")];
    const { result } = await mount();
    expect(result.current.streamingIds.has("chat-2")).toBe(true);

    activeChatsResult = async () => {
      throw new Error("offline");
    };
    jest.useFakeTimers();
    activeChatsResult = async () => {
      throw new Error("offline");
    };
    // Force the next poll with a foreground bounce.
    act(() => appStateListeners.forEach((fn) => fn("background")));
    act(() => appStateListeners.forEach((fn) => fn("active")));
    await flush();

    expect(result.current.streamingIds.has("chat-2")).toBe(true);

    // A failure must not drop the fast cadence: the next poll is 5s out, not 15.
    const failedAt = listWorkspaceActiveChats.mock.calls.length;
    advance(5_000);
    await flush();
    expect(listWorkspaceActiveChats.mock.calls.length).toBe(failedAt + 1);
  });
});

describe("useWorkspaceChats row time", () => {
  test("a send re-stamps just that row and lifts it — with no list re-fetch", async () => {
    const { result } = await mount();
    expect(result.current.active.map((chat) => chat.id)).toEqual(["chat-2", "chat-1"]);
    const reads = listWorkspaceSessions.mock.calls.length;

    const now = Date.now();
    act(() =>
      chatSessionEvents.emit({ touchedSessionId: "chat-1", lastActiveAt: now }),
    );

    expect(result.current.active.map((chat) => chat.id)).toEqual(["chat-1", "chat-2"]);
    expect(result.current.active[0].lastActiveAt).toBe(new Date(now).toISOString());
    expect(listWorkspaceSessions.mock.calls.length).toBe(reads);
  });

  test("a stale touch never moves a row backwards in time", async () => {
    const { result } = await mount();

    act(() =>
      chatSessionEvents.emit({
        touchedSessionId: "chat-2",
        lastActiveAt: new Date("2026-01-01T00:00:00.000Z").getTime(),
      }),
    );

    expect(result.current.active[0].lastActiveAt).toBe("2026-10-02T10:00:00.000Z");
  });

  test("a running turn's start counts as activity, so its row reads now", async () => {
    const startedAt = "2027-01-01T00:00:00.000Z";
    activeChatsResult = async () => [turn("chat-1", startedAt)];

    const { result } = await mount();

    expect(result.current.active[0].id).toBe("chat-1");
    expect(result.current.active[0].lastActiveAt).toBe(startedAt);
  });
});

describe("useWorkspaceChats poll cadence", () => {
  test("5s while a chat of mine is running, 15s once nothing is", async () => {
    jest.useFakeTimers();
    activeChatsResult = async () => [turn("chat-2")];

    await mount();
    const afterMount = listWorkspaceActiveChats.mock.calls.length;

    advance(5_000);
    await flush();
    expect(listWorkspaceActiveChats.mock.calls.length).toBe(afterMount + 1);
    expect(listWorkspaceActiveChats.mock.calls.length).toBe(afterMount + 1);

    // The turn ended elsewhere: the next poll sees nothing running.
    activeChatsResult = async () => [];
    advance(5_000);
    await flush();
    const idleFrom = listWorkspaceActiveChats.mock.calls.length;

    // Now the slow cadence: not at 5s, not at 14s, yes at 15s.
    advance(5_000);
    await flush();
    expect(listWorkspaceActiveChats.mock.calls.length).toBe(idleFrom);
    advance(9_000);
    await flush();
    expect(listWorkspaceActiveChats.mock.calls.length).toBe(idleFrom);
    advance(1_000);
    await flush();
    expect(listWorkspaceActiveChats.mock.calls.length).toBe(idleFrom + 1);
  });

  test("no polling while the app is in the background, and a poll on return", async () => {
    jest.useFakeTimers();

    await mount();
    const beforeBackground = listWorkspaceActiveChats.mock.calls.length;

    act(() => appStateListeners.forEach((fn) => fn("background")));
    advance(60_000);
    await flush();
    expect(listWorkspaceActiveChats.mock.calls.length).toBe(beforeBackground);

    act(() => appStateListeners.forEach((fn) => fn("active")));
    await flush();
    expect(listWorkspaceActiveChats.mock.calls.length).toBe(beforeBackground + 1);
  });

  test("unmounting stops the poll", async () => {
    jest.useFakeTimers();
    const { unmount } = renderHook(() => useWorkspaceChats("w1"));
    await flush();
    const beforeUnmount = listWorkspaceActiveChats.mock.calls.length;

    unmount();
    advance(60_000);
    await flush();

    expect(listWorkspaceActiveChats.mock.calls.length).toBe(beforeUnmount);
  });
});

// ─── SHO-391: the list paints from the device ────────────────────────────────
//
// Every Home click used to mount a hook that started at `[]` / `loading: true`
// and refetched, and one failed request blanked a list the user was reading.

describe("useWorkspaceChats device cache", () => {
  /** A mount whose list request fails — the network a cache has to cover. */
  async function mountOffline(workspaceId = "w1") {
    listWorkspaceSessions.mockImplementation(async () => {
      throw new Error("offline")
    })
    const rendered = renderHook(() => useWorkspaceChats(workspaceId))
    await act(async () => {
      await rendered.result.current.refresh()
    })
    await flush()
    return rendered
  }

  test("a remount paints the cached rows on its first frame, with no loading state", async () => {
    const first = await mount()
    expect(first.result.current.sessions.map((chat) => chat.id)).toEqual(["chat-1", "chat-2"])
    first.unmount()
    // Nothing lands from the network now: what is on screen came from the cache.
    const second = await mountOffline()

    expect(second.result.current.loading).toBe(false)
    expect(second.result.current.sessions.map((chat) => chat.id)).toEqual(["chat-1", "chat-2"])
    expect(second.result.current.active.map((chat) => chat.id)).toEqual(["chat-2", "chat-1"])
  })

  test("a failed refresh keeps the rows already on screen", async () => {
    const { result } = await mount()
    expect(result.current.sessions).toHaveLength(2)

    listWorkspaceSessions.mockImplementation(async () => {
      throw new Error("500")
    })
    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.sessions.map((chat) => chat.id)).toEqual(["chat-1", "chat-2"])
    expect(result.current.loading).toBe(false)
  })

  test("a first-ever load that fails ends in the empty state, not a spinner", async () => {
    const { result } = await mountOffline("w9")

    expect(result.current.loading).toBe(false)
    expect(result.current.sessions).toEqual([])
  })

  test("a rename survives a remount without waiting for the network", async () => {
    const first = await mount()
    // The server has the rename, so the refresh the rename triggers agrees.
    sessionsResult = () =>
      CHATS().map((chat) =>
        chat.id === "chat-1" ? { ...chat, name: "Renamed party" } : chat,
      )
    await act(async () => {
      await first.result.current.updateChat("chat-1", { name: "Renamed party" })
    })
    first.unmount()

    const second = await mountOffline()
    const renamed = second.result.current.sessions.find((chat) => chat.id === "chat-1")
    expect(renamed?.name).toBe("Renamed party")
  })

  test("an answer for a workspace you already left never paints", async () => {
    let answerOld: (rows: any[]) => void = () => {}
    listWorkspaceSessions.mockImplementationOnce(
      () => new Promise<any[]>((resolve) => { answerOld = resolve }),
    )
    const { result, rerender } = renderHook(({ id }) => useWorkspaceChats(id), {
      initialProps: { id: "w1" },
    }) as any
    act(() => {
      void result.current.refresh()
    })

    sessionsResult = () => [{ id: "chat-w2", workspaceId: "w2", name: "Two" }]
    rerender({ id: "w2" })
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.sessions.map((chat) => chat.id)).toEqual(["chat-w2"])

    // The first workspace's answer lands now, after the switch.
    await act(async () => {
      answerOld([{ id: "chat-w1", workspaceId: "w1", name: "One" }])
      await Promise.resolve()
    })
    expect(result.current.sessions.map((chat) => chat.id)).toEqual(["chat-w2"])
  })

  test("one workspace's cache never paints another's rows", async () => {
    const first = await mount()
    first.unmount()

    const other = await mountOffline("w2")
    expect(other.result.current.sessions).toEqual([])
  })

  test("a chat created here is in the cache the next mount paints", async () => {
    const first = await mount()
    await act(async () => {
      await first.result.current.createChat({ inferredName: "Brand new" })
    })
    first.unmount()

    const second = await mountOffline()
    expect(second.result.current.sessions.map((chat) => chat.id)).toContain("chat-new")
  })
})
