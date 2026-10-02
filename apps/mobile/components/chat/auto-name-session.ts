// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export type AutoNameSessionResult = {
  name?: string | null;
  description?: string | null;
  source?: string;
};

const PLACEHOLDER_SESSION_NAMES = new Set([
  "untitled",
  "untitled chat",
  "new chat",
  "workspace chat",
]);

/** True for an empty name or one of the default names new chats are created with. */
export function isPlaceholderSessionName(name: string | null | undefined): boolean {
  const normalized = (name ?? "").trim().toLowerCase();
  return !normalized || PLACEHOLDER_SESSION_NAMES.has(normalized);
}

export type AutoNameSessionOptions = {
  sessionId: string;
  userText: string;
  workspaceId?: string;
  projectId?: string;
  getSession: (sessionId: string) => unknown;
  /**
   * Load a session into the local collection when it isn't there yet
   * (workspace sessions are created server-side). Optional; failures are
   * treated as "session not found".
   */
  loadSession?: (sessionId: string) => Promise<unknown>;
  getProjectName: (projectId: string) => string | null | undefined;
  generateName: (
    userText: string,
    workspaceId?: string,
    projectId?: string,
  ) => Promise<AutoNameSessionResult>;
  updateProject: (
    projectId: string,
    changes: { name: string; description?: string },
  ) => Promise<unknown>;
  updateSession: (
    sessionId: string,
    changes: { inferredName: string },
  ) => Promise<unknown>;
  emitRefresh: (context: {
    projectId?: string;
    workspaceId?: string;
    sessionId: string;
  }) => void;
};

/**
 * Generate and persist the first chat title. The caller owns the per-session
 * single-flight guard; this function owns the async naming and persistence
 * sequence so it can be started from send-time and tested independently from
 * ChatPanel's streaming lifecycle.
 */
export async function autoNameSession({
  sessionId,
  userText,
  workspaceId,
  projectId,
  getSession,
  loadSession,
  getProjectName,
  generateName,
  updateProject,
  updateSession,
  emitRefresh,
}: AutoNameSessionOptions): Promise<void> {
  const normalizedText = userText.trim();
  if (!normalizedText) return;

  // Workspace sessions live server-side; pull them into the local collection
  // so the name check below sees their real name.
  if (!getSession(sessionId) && loadSession) {
    try {
      await loadSession(sessionId);
    } catch {
      // Fall through; treated as missing.
    }
  }

  const session = getSession(sessionId) as
    { inferredName?: string | null; name?: string | null } | undefined;
  const sessionName = session?.inferredName || session?.name;
  if (!isPlaceholderSessionName(sessionName)) return;

  const { name, description, source } = await generateName(
    normalizedText,
    workspaceId,
    projectId,
  );
  if (source !== "ai" || !name) return;

  // Workspace sessions live server-side; pull them into the local collection
  // so the update below can find them.
  if (!getSession(sessionId) && loadSession) {
    try {
      await loadSession(sessionId);
    } catch {
      // Treated as missing below.
    }
  }
  // The session may have been deleted while the naming request was in flight.
  if (!getSession(sessionId)) return;

  if (projectId && getProjectName(projectId) === "New Project") {
    await updateProject(projectId, {
      name,
      ...(description ? { description } : {}),
    });
  }

  await updateSession(sessionId, { inferredName: name });
  if (projectId || workspaceId) {
    emitRefresh({ projectId, workspaceId, sessionId });
  }
}
