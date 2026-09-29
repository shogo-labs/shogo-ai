// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export type AutoNameSessionResult = {
  name?: string | null;
  description?: string | null;
  source?: string;
};

export type AutoNameSessionOptions = {
  sessionId: string;
  userText: string;
  workspaceId?: string;
  projectId?: string;
  getSession: (sessionId: string) => unknown;
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
  getProjectName,
  generateName,
  updateProject,
  updateSession,
  emitRefresh,
}: AutoNameSessionOptions): Promise<void> {
  const normalizedText = userText.trim();
  if (!normalizedText) return;

  const session = getSession(sessionId) as
    { inferredName?: string | null; name?: string | null } | undefined;
  const sessionName = session?.inferredName || session?.name;
  if (sessionName && sessionName !== "Untitled") return;

  const { name, description, source } = await generateName(
    normalizedText,
    workspaceId,
    projectId,
  );
  if (source !== "ai" || !name) return;

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
